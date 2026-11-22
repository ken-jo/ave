import { Socket } from "node:net";
import { PassThrough, Writable } from "node:stream";
import { Worker, parentPort } from "node:worker_threads";
import { errorMessage } from "../../shared/error-message.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { OUTBOUND_QUEUE_BYTES_MAX } from "./child-stream-multiplex.js";
import { acceptHostOverLoopback } from "./child-loopback-link.js";

type OwnerMessage = Uint8Array | null | { readonly announce: string } | { readonly error?: string };

export interface PluginChildInputOwner {
  readonly queuedBytes: Int32Array;
  readonly transport: "stdio" | "loopback";
}

export function openPluginChildInput(entry: URL, transport: PluginChildInputOwner["transport"], stdout: Writable): {
  input: PassThrough;
  output: Writable;
} {
  const queuedBytes = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const input = new PassThrough();
  const workerData: PluginChildInputOwner = { queuedBytes, transport };
  const reader = new Worker(entry, { workerData });
  let written: ((error?: Error) => void) | undefined;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written = callback;
      const bytes = Uint8Array.from(chunk);
      reader.postMessage(bytes, [bytes.buffer]);
    },
  });
  output.on("error", (error) => {
    process.stderr.write(`[plugin-child] channel error: ${errorMessage(error)}\n`);
  });
  reader.on("message", (message: OwnerMessage) => {
    if (message === null) {
      input.end();
      written?.(new Error("Plugin child channel closed"));
      written = undefined;
      reader.unref();
      return;
    }
    if (message instanceof Uint8Array) {
      input.write(message, () => Atomics.sub(queuedBytes, 0, message.byteLength));
    } else if ("announce" in message) {
      stdout.write(message.announce);
    } else {
      const callback = written;
      written = undefined;
      callback?.(message.error === undefined ? undefined : new Error(message.error));
    }
  });
  input.once("close", () => reader.postMessage(null));
  reader.on("error", (error) => {
    process.stderr.write(`[plugin-child] stdin reader failed: ${errorMessage(error)}\n`);
  });
  reader.once("exit", () => process.exit(1));
  return { input, output };
}

export async function ownPluginChildInput({ transport, queuedBytes }: PluginChildInputOwner): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error("[plugin-child] input owner requires a worker");
  const input = transport === "stdio"
    ? new Socket({ fd: 0, readable: true, writable: false })
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
  input.once("error", handleLoss);
  input.once("close", handleLoss);
  port.on("message", (chunk: Uint8Array | null) => {
    if (chunk === null) handleLoss();
    else input.write(chunk, (error) => {
      const message: OwnerMessage = { error: error?.message };
      port.postMessage(message);
    });
  });
  input.on("data", (chunk: Buffer) => {
    // Keep reading to observe EOF independently, with the same bound as the host's outbound queue.
    if (Atomics.add(queuedBytes, 0, chunk.byteLength) + chunk.byteLength > OUTBOUND_QUEUE_BYTES_MAX) {
      process.stderr.write("[plugin-child] stdin queue exceeds limit\n");
      handleLoss();
      return;
    }
    const bytes = Uint8Array.from(chunk);
    port.postMessage(bytes, [bytes.buffer]);
  });
  input.resume();
}
