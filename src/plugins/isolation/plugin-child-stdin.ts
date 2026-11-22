import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { Worker, parentPort } from "node:worker_threads";
import { errorMessage } from "../../shared/error-message.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { OUTBOUND_QUEUE_BYTES_MAX } from "./child-stream-multiplex.js";

export function openPluginChildStdin(entry: URL): PassThrough {
  const queuedBytes = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const input = new PassThrough();
  const reader = new Worker(entry, { workerData: queuedBytes });
  reader.on("message", (chunk: Uint8Array | null) => {
    if (chunk === null) {
      input.end();
      reader.unref();
      return;
    }
    input.write(chunk, () => Atomics.sub(queuedBytes, 0, chunk.byteLength));
  });
  input.once("close", () => reader.postMessage(null));
  reader.on("error", (error) => {
    process.stderr.write(`[plugin-child] stdin reader failed: ${errorMessage(error)}\n`);
  });
  reader.once("exit", () => process.exit(1));
  return input;
}

export function readPluginChildStdin(queuedBytes: Int32Array): void {
  const port = parentPort;
  if (!port) throw new Error("[plugin-child] stdin reader requires a worker");
  const input = new Socket({ fd: 0, readable: true, writable: false });
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
  port.once("message", handleLoss);
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
}
