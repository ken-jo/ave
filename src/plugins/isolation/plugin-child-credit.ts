import { Transform, Writable, type Readable } from "node:stream";
import { FRAME_BYTES_MAX } from "./host-api-wire.js";

export const PLUGIN_CHILD_INPUT_BYTES_MAX = FRAME_BYTES_MAX + 1;
export const PLUGIN_CHILD_INPUT_FD = 3;

// Raw NUL cannot occur in a JSON frame. The four bytes after it acknowledge consumed input.
const CREDIT_MARKER = 0;
const CREDIT_BYTES = 4;

export function pluginChildInputCredit(bytes: number): Buffer {
  const credit = Buffer.alloc(1 + CREDIT_BYTES);
  credit.writeUInt32BE(bytes, 1);
  return credit;
}

interface PendingWrite {
  remaining: number;
  done(error?: Error | null): void;
}

/** Pace the reference runtime's input without pausing its owner while it watches for EOF. */
export function pacePluginChildInput(source: Readable, sink: Writable): {
  input: Readable;
  output: Writable;
} {
  let pending: PendingWrite | undefined;
  const credit = Buffer.alloc(CREDIT_BYTES);
  let creditRemaining = 0;
  let creditWrite: PendingWrite | undefined;
  const input = new Transform({
    writableObjectMode: true,
    writableHighWaterMark: 1,
    transform({ chunk, write }: { chunk: Buffer; write: PendingWrite | undefined }, _encoding, done) {
      let offset = 0;
      while (offset < chunk.length) {
        if (creditRemaining === 0) {
          const marker = chunk.indexOf(CREDIT_MARKER, offset);
          if (marker === -1) {
            this.push(chunk.subarray(offset));
            break;
          }
          if (marker > offset) this.push(chunk.subarray(offset, marker));
          creditWrite = write;
          creditRemaining = CREDIT_BYTES;
          offset = marker + 1;
        }
        if (!creditWrite || creditWrite !== write || creditWrite !== pending || creditWrite.remaining === 0) {
          done(new Error("Invalid plugin child input credit"));
          return;
        }
        const count = Math.min(creditRemaining, chunk.length - offset);
        chunk.copy(credit, CREDIT_BYTES - creditRemaining, offset, offset + count);
        offset += count;
        creditRemaining -= count;
        if (creditRemaining > 0) continue;
        const bytes = credit.readUInt32BE();
        if (bytes === 0 || bytes > creditWrite.remaining) {
          done(new Error("Invalid plugin child input credit"));
          return;
        }
        creditWrite.remaining -= bytes;
        creditWrite = undefined;
      }
      if (write && pending === write && write.remaining === 0) {
        pending = undefined;
        write.done();
      }
      done();
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (chunk.length === 0) return done();
      if (chunk.length > PLUGIN_CHILD_INPUT_BYTES_MAX) {
        return done(new Error("Plugin child input write exceeds credit window"));
      }
      const write = { remaining: chunk.length, done };
      pending = write;
      sink.write(chunk, (error) => {
        if (error && pending === write) {
          pending = undefined;
          done(error);
        }
      });
    },
    final(done) { sink.end(done); },
    destroy(error, done) {
      const write = pending;
      pending = undefined;
      write?.done(error ?? new Error("Plugin child input closed before delivery"));
      done(error);
    },
  });
  // A link can fault before the protocol session attaches its listeners.
  input.on("error", () => undefined);
  output.on("error", () => undefined);
  source.on("error", (error: Error) => input.destroy(error));
  if (!Object.is(source, sink)) sink.on("error", (error: Error) => output.destroy(error));
  source.once("close", () => {
    if (!source.readableEnded) input.destroy();
  });
  sink.once("close", () => {
    if (!output.writableFinished) output.destroy();
  });
  sink.once("finish", () => {
    if (!output.writableEnded || pending) output.destroy();
  });
  const accept = (chunk: Buffer): void => {
    // Snapshot on arrival, before the transform can queue the chunk or complete a write.
    if (!input.write({ chunk, write: pending })) source.pause();
  };
  input.on("drain", () => source.resume());
  input.once("close", () => source.off("data", accept));
  source.once("end", () => input.end());
  if (source.readableEnded) input.end();
  else source.on("data", accept);
  if (source.destroyed && !source.readableEnded) input.destroy();
  if (sink.destroyed || sink.writableFinished) output.destroy();
  return { input, output };
}
