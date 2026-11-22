import { write } from "node:fs";
import { Socket } from "node:net";
import { Writable, type Duplex } from "node:stream";
import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { StdioFrameDecoder } from "../../mcp/stdio-framing.js";
import { errorMessage } from "../../shared/error-message.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { acceptHostOverLoopback } from "./child-loopback-link.js";
import type { DecodedMessageInput, MultiplexedMessage } from "./child-stream-multiplex.js";
import { FRAME_BYTES_MAX } from "./host-api-wire.js";
import { PLUGIN_CHILD_INPUT_BYTES_MAX, PLUGIN_CHILD_INPUT_FD, pluginChildInputCredit } from "./plugin-child-credit.js";

type OwnerMessage =
  | { readonly frames: MultiplexedMessage[]; readonly observation: Uint8Array; readonly byteLength: number }
  | { readonly violation: string }
  | { readonly announce: string }
  | { readonly error?: string }
  | null;
type StdinEvent = "data" | "end";
type StdinListener = (chunk: Buffer) => void;
type StdinObserver = { readonly listener: StdinListener; readonly once: boolean };

interface PluginStdinView {
  on(event: StdinEvent, listener: StdinListener): PluginStdinView;
  once(event: StdinEvent, listener: StdinListener): PluginStdinView;
  off(event: StdinEvent, listener: StdinListener): PluginStdinView;
}

export interface PluginChildInputOwner {
  readonly queuedBytes: Int32Array;
  readonly port: MessagePort;
  readonly transport: "stdio" | "loopback";
  readonly privateInput: boolean;
}

export function openPluginChildInput(
  entry: URL,
  { transport, privateInput }: Pick<PluginChildInputOwner, "transport" | "privateInput">,
  stdout: Writable,
  onHostGone: () => void,
): {
  input: DecodedMessageInput & { destroy(): void };
  output: Writable;
  stdin: PluginStdinView;
} {
  const queuedBytes = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const acknowledgeBytes = Atomics.sub;
  const observationBuffer = Buffer.from;
  const { port1: receiver, port2: port } = new MessageChannel();
  const postToOwner = receiver.postMessage.bind(receiver);
  const closeReceiver = receiver.close.bind(receiver);
  let receive: ((message: MultiplexedMessage) => void) | undefined;
  let reject: ((reason: string) => void) | undefined;
  const input: DecodedMessageInput & { destroy(): void } = {
    subscribe(onMessage, onViolation) {
      receive = onMessage;
      reject = onViolation;
    },
    destroy() {
      receive = undefined;
      if (!closed) postToOwner(null);
    },
  };
  const observers: Record<StdinEvent, StdinObserver[]> = { data: [], end: [] };
  const stdin: PluginStdinView = Object.freeze({
    on(event: StdinEvent, listener: StdinListener) {
      observers[event].push({ listener, once: false });
      return stdin;
    },
    once(event: StdinEvent, listener: StdinListener) {
      observers[event].push({ listener, once: true });
      return stdin;
    },
    off(event: StdinEvent, listener: StdinListener) {
      const list = observers[event];
      const index = list.findLastIndex((observer) => observer.listener === listener);
      if (index !== -1) list.splice(index, 1);
      return stdin;
    },
  });
  function observe(event: StdinEvent, listeners: StdinObserver[], observed?: Buffer): void {
    for (const observer of listeners) {
      if (observer.once) {
        const list = observers[event];
        const index = list.indexOf(observer);
        if (index === -1) continue;
        list.splice(index, 1);
      }
      Reflect.apply(observer.listener, stdin, observed ? [observed] : []);
    }
  }
  const workerData: PluginChildInputOwner = { queuedBytes, transport, privateInput, port };
  const reader = new Worker(entry, { workerData, transferList: [port] });
  // Keep the main loop alive without exposing a referenced owner port as an active handle.
  const { port1: keepAlive, port2 } = new MessageChannel();
  keepAlive.ref();
  let written: ((error?: Error) => void) | undefined;
  let closed = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (closed) {
        callback(new Error("Plugin child channel closed"));
        return;
      }
      written = callback;
      const bytes = Uint8Array.from(chunk);
      postToOwner(bytes, [bytes.buffer]);
    },
  });
  output.on("error", (error) => {
    process.stderr.write(`[plugin-child] channel error: ${errorMessage(error)}\n`);
  });
  const creditOutput = transport === "stdio" ? stdout : output;
  const sendCredit = creditOutput.write.bind(creditOutput);
  receiver.onmessage = ({ data: message }: { data: OwnerMessage }) => {
    if (message === null) {
      closed = true;
      receive = undefined;
      closeReceiver();
      written?.(new Error("Plugin child channel closed"));
      written = undefined;
      keepAlive.close();
      port2.close();
      onHostGone();
      observe("end", observers.end.slice());
      return;
    }
    if ("frames" in message) {
      const listeners = observers.data.slice();
      for (let index = 0; index < message.frames.length; index += 1) {
        receive?.(message.frames[index]!);
      }
      acknowledgeBytes(queuedBytes, 0, message.byteLength);
      if (receive) sendCredit(pluginChildInputCredit(message.byteLength));
      if (listeners.length > 0) {
        const { buffer, byteOffset, byteLength } = message.observation;
        observe("data", listeners, observationBuffer(buffer, byteOffset, byteLength));
      }
    } else if ("violation" in message) {
      reject?.(message.violation);
    } else if ("announce" in message) {
      stdout.write(message.announce);
    } else {
      const callback = written;
      written = undefined;
      callback?.(message.error === undefined ? undefined : new Error(message.error));
    }
  };
  receiver.unref();
  reader.on("error", (error) => {
    process.stderr.write(`[plugin-child] stdin reader failed: ${errorMessage(error)}\n`);
  });
  reader.once("exit", () => process.exit(1));
  reader.unref();
  return { input, output, stdin };
}

export async function ownPluginChildInput({ transport, queuedBytes, privateInput, port }: PluginChildInputOwner): Promise<void> {
  const input = transport === "stdio"
    ? new Socket({ fd: privateInput ? PLUGIN_CHILD_INPUT_FD : 0, readable: true, writable: false })
    : await acceptHostOverLoopback({
      announce: (line) => { port.postMessage({ announce: line }); },
      acceptTimeoutMs: 60_000,
      handshakeTimeoutMs: 10_000,
    });
  watchPluginChildInput(input, port, queuedBytes);
}

interface PluginChildInputControl {
  schedule(callback: () => void, delayMs: number): void;
  forceExit(): void;
  report(reason: string): void;
}

const inputControl: PluginChildInputControl = {
  schedule(callback, delayMs) { setTimeout(callback, delayMs); },
  forceExit() { process.kill(process.pid, "SIGKILL"); },
  report(reason) { write(2, `[plugin-child] ${reason}\n`, () => undefined); },
};

export function watchPluginChildInput(
  input: Duplex,
  port: MessagePort,
  queuedBytes: Int32Array,
  control: PluginChildInputControl = inputControl,
): void {
  const decoder = new StdioFrameDecoder(FRAME_BYTES_MAX);
  let lost = false;
  const handleLoss = (): void => {
    if (lost) return;
    lost = true;
    // This timer runs even if plugin code never returns control to its event loop.
    control.schedule(control.forceExit, TOOL_TIMEOUT_POLICY.pluginChildHostLossMs);
    port.postMessage(null);
    input.destroy();
  };
  input.once("end", handleLoss);
  const fail = (reason: string): void => {
    handleLoss();
    control.report(reason);
  };
  input.once("error", (error) => fail(`channel error: ${errorMessage(error)}`));
  input.once("close", handleLoss);
  port.on("message", (chunk: Uint8Array | null) => {
    if (chunk === null) handleLoss();
    else input.write(chunk, (error) => {
      const message: OwnerMessage = { error: error?.message };
      port.postMessage(message);
    });
  });
  input.on("data", (chunk: Buffer) => {
    if (lost) return;
    // A valid host waits for consumption of its current write. The owner can always read through to EOF.
    if (Atomics.add(queuedBytes, 0, chunk.byteLength) + chunk.byteLength > PLUGIN_CHILD_INPUT_BYTES_MAX) {
      fail("host input exceeded the credit window");
      return;
    }
    let frames: MultiplexedMessage[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      port.postMessage({ violation: errorMessage(error) } satisfies OwnerMessage);
      handleLoss();
      return;
    }
    const observation = Uint8Array.from(chunk);
    port.postMessage({ frames, observation, byteLength: chunk.byteLength } satisfies OwnerMessage, [observation.buffer]);
  });
  input.resume();
}
