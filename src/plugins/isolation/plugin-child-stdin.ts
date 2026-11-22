import { EventEmitter } from "node:events";
import { write } from "node:fs";
import { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { MessageChannel, Worker, parentPort } from "node:worker_threads";
import { errorMessage } from "../../shared/error-message.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { acceptHostOverLoopback } from "./child-loopback-link.js";
import { PLUGIN_CHILD_INPUT_BYTES_MAX, PLUGIN_CHILD_INPUT_FD, pluginChildInputCredit } from "./plugin-child-credit.js";

type OwnerMessage = Uint8Array | null | { readonly announce: string } | { readonly error?: string };
type StdinEvent = "data" | "end";
type StdinListener = (chunk: Buffer) => void;

interface PluginStdinView {
  on(event: StdinEvent, listener: StdinListener): PluginStdinView;
  once(event: StdinEvent, listener: StdinListener): PluginStdinView;
  off(event: StdinEvent, listener: StdinListener): PluginStdinView;
}

export interface PluginChildInputOwner {
  readonly queuedBytes: Int32Array;
  readonly transport: "stdio" | "loopback";
  readonly privateInput: boolean;
}

export function openPluginChildInput(
  entry: URL,
  { transport, privateInput }: Omit<PluginChildInputOwner, "queuedBytes">,
  stdout: Writable,
): {
  input: Readable;
  output: Writable;
  stdin: PluginStdinView;
} {
  const queuedBytes = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const acknowledgeBytes = Atomics.sub;
  const input = new Readable({ read() {} });
  const deliver = input.push.bind(input);
  const observers = new EventEmitter();
  const observe = observers.emit.bind(observers);
  const hasObservers = observers.listenerCount.bind(observers);
  const stdin: PluginStdinView = Object.freeze({
    on(event: StdinEvent, listener: StdinListener) {
      observers.on(event, listener);
      return stdin;
    },
    once(event: StdinEvent, listener: StdinListener) {
      observers.once(event, listener);
      return stdin;
    },
    off(event: StdinEvent, listener: StdinListener) {
      observers.off(event, listener);
      return stdin;
    },
  });
  const workerData: PluginChildInputOwner = { queuedBytes, transport, privateInput };
  const reader = new Worker(entry, { workerData });
  const postToOwner = reader.postMessage.bind(reader);
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
  reader.on("message", (message: OwnerMessage) => {
    if (message === null) {
      closed = true;
      deliver(null);
      observe("end");
      written?.(new Error("Plugin child channel closed"));
      written = undefined;
      keepAlive.close();
      port2.close();
      return;
    }
    if (message instanceof Uint8Array) {
      const bytes = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
      deliver(bytes);
      if (hasObservers("data") > 0) observe("data", Buffer.from(bytes));
      acknowledgeBytes(queuedBytes, 0, message.byteLength);
      if (!input.destroyed) sendCredit(pluginChildInputCredit(message.byteLength));
    } else if ("announce" in message) {
      stdout.write(message.announce);
    } else {
      const callback = written;
      written = undefined;
      callback?.(message.error === undefined ? undefined : new Error(message.error));
    }
  });
  input.once("close", () => { if (!closed) postToOwner(null); });
  reader.on("error", (error) => {
    process.stderr.write(`[plugin-child] stdin reader failed: ${errorMessage(error)}\n`);
  });
  reader.once("exit", () => process.exit(1));
  reader.unref();
  return { input, output, stdin };
}

export async function ownPluginChildInput({ transport, queuedBytes, privateInput }: PluginChildInputOwner): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("[plugin-child] input owner requires a worker");
  const input = transport === "stdio"
    ? new Socket({ fd: privateInput ? PLUGIN_CHILD_INPUT_FD : 0, readable: true, writable: false })
    : await acceptHostOverLoopback({
      announce: (line) => { port.postMessage({ announce: line }); },
      acceptTimeoutMs: 60_000,
      handshakeTimeoutMs: 10_000,
    });
  let lost = false;
  const handleLoss = (): void => {
    if (lost) return;
    lost = true;
    // This timer runs even if plugin code never returns control to its event loop.
    setTimeout(() => process.kill(process.pid, "SIGKILL"), TOOL_TIMEOUT_POLICY.pluginShutdownKillGraceMs * 2);
    port.postMessage(null);
    input.destroy();
  };
  input.once("end", handleLoss);
  const fail = (reason: string): void => {
    handleLoss();
    write(2, `[plugin-child] ${reason}\n`, () => undefined);
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
    // A valid host waits for consumption of its current write. The owner can always read through to EOF.
    if (Atomics.add(queuedBytes, 0, chunk.byteLength) + chunk.byteLength > PLUGIN_CHILD_INPUT_BYTES_MAX) {
      fail("host input exceeded the credit window");
      return;
    }
    const bytes = Uint8Array.from(chunk);
    port.postMessage(bytes, [bytes.buffer]);
  });
  input.resume();
}
