import { Transform, Writable, type Readable } from "node:stream";
import { FRAME_BYTES_MAX } from "./host-api-wire.js";

export const PLUGIN_CHILD_INPUT_BYTES_MAX = FRAME_BYTES_MAX + 1;

// Raw NUL cannot occur in a JSON frame. The four bytes after it acknowledge consumed input.
const CREDIT_MARKER = 0;
const CREDIT_BYTES = 4;

export function pluginChildInputCredit(bytes: number): Buffer {
  const credit = Buffer.alloc(1 + CREDIT_BYTES);
  credit.writeUInt32BE(bytes, 1);
  return credit;
}

/** Pace the reference runtime's input without pausing its owner while it watches for EOF. */
export function pacePluginChildInput(source: Readable, sink: Writable): {
  input: Readable;
  output: Writable;
} {
  let pending: { remaining: number; done: (error?: Error | null) => void } | undefined;
  const credit = Buffer.alloc(CREDIT_BYTES);
  let creditRemaining = 0;
  const input = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      let offset = 0;
      while (offset < chunk.length) {
        if (creditRemaining === 0) {
          const marker = chunk.indexOf(CREDIT_MARKER, offset);
          if (marker === -1) {
            this.push(chunk.subarray(offset));
            break;
          }
          if (marker > offset) this.push(chunk.subarray(offset, marker));
          creditRemaining = CREDIT_BYTES;
          offset = marker + 1;
        }
        const count = Math.min(creditRemaining, chunk.length - offset);
        chunk.copy(credit, CREDIT_BYTES - creditRemaining, offset, offset + count);
        offset += count;
        creditRemaining -= count;
        if (creditRemaining > 0) continue;
        const bytes = credit.readUInt32BE();
        if (!pending || bytes === 0 || bytes > pending.remaining) {
          done(new Error("Invalid plugin child input credit"));
          return;
        }
        pending.remaining -= bytes;
        if (pending.remaining === 0) {
          const { done: delivered } = pending;
          pending = undefined;
          delivered();
        }
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
  if (source !== sink) sink.on("error", (error: Error) => output.destroy(error));
  source.once("close", () => {
    if (!source.readableEnded) input.destroy();
  });
  sink.once("close", () => {
    if (!output.writableFinished) output.destroy();
  });
  sink.once("finish", () => {
    if (!output.writableEnded || pending) output.destroy();
  });
  source.pipe(input);
  if (source.destroyed && !source.readableEnded) input.destroy();
  if (sink.destroyed || sink.writableFinished) output.destroy();
  return { input, output };
}
