import { randomBytes } from "node:crypto";
import { Transform, Writable, type Readable } from "node:stream";
import { FRAME_BYTES_MAX } from "./host-api-wire.js";

export const PLUGIN_CHILD_INPUT_BYTES_MAX = FRAME_BYTES_MAX + 1;
export const PLUGIN_CHILD_INPUT_FD = 3;

const WRITE_ID_BYTES = 16;
const WRITE_HEADER_BYTES = WRITE_ID_BYTES + 4;
// Raw NUL cannot occur in a JSON frame. Credit carries the write ID and its cumulative consumed bytes.
const CREDIT_MARKER = 0;
const CREDIT_BYTES = WRITE_HEADER_BYTES;

export function pluginChildInputCredit(id: Buffer, consumed: number): Buffer {
  const credit = Buffer.alloc(1 + CREDIT_BYTES);
  id.copy(credit, 1);
  credit.writeUInt32BE(consumed, 1 + WRITE_ID_BYTES);
  return credit;
}

export function framePluginChildInputWrite(chunk: Buffer): Buffer {
  const header = Buffer.alloc(WRITE_HEADER_BYTES);
  randomBytes(WRITE_ID_BYTES).copy(header);
  header.writeUInt32BE(chunk.length, WRITE_ID_BYTES);
  return Buffer.concat([header, chunk]);
}

/** Strip the write envelope before passing payload bytes to the frame decoder. */
export class PluginChildInputWriteDecoder {
  private readonly header = Buffer.alloc(WRITE_HEADER_BYTES);
  private headerBytes = 0;
  private remaining = 0;
  private consumed = 0;

  push(chunk: Buffer, receive: (payload: Buffer, id: Buffer, consumed: number) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const count = Math.min(WRITE_HEADER_BYTES - this.headerBytes, chunk.length - offset);
        chunk.copy(this.header, this.headerBytes, offset, offset + count);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < WRITE_HEADER_BYTES) return;
        this.headerBytes = 0;
        this.consumed = 0;
        this.remaining = this.header.readUInt32BE(WRITE_ID_BYTES);
        if (this.remaining === 0 || this.remaining > PLUGIN_CHILD_INPUT_BYTES_MAX) {
          throw new Error("Invalid plugin child input write size");
        }
        if (offset === chunk.length) return;
      }
      const count = Math.min(this.remaining, chunk.length - offset);
      const payload = chunk.subarray(offset, offset + count);
      const id = this.header.subarray(0, WRITE_ID_BYTES);
      offset += count;
      this.remaining -= count;
      this.consumed += count;
      receive(payload, id, this.consumed);
    }
  }
}

interface PendingWrite {
  readonly id: Buffer;
  readonly length: number;
  consumed: number;
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
  const input = new Transform({
    writableHighWaterMark: 1,
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
        if (!pending || pending.consumed === pending.length) {
          done(new Error("Invalid plugin child input credit"));
          return;
        }
        const count = Math.min(creditRemaining, chunk.length - offset);
        chunk.copy(credit, CREDIT_BYTES - creditRemaining, offset, offset + count);
        offset += count;
        creditRemaining -= count;
        if (creditRemaining > 0) continue;
        const consumed = credit.readUInt32BE(WRITE_ID_BYTES);
        if (!pending.id.equals(credit.subarray(0, WRITE_ID_BYTES))
          || consumed <= pending.consumed || consumed > pending.length) {
          done(new Error("Invalid plugin child input credit"));
          return;
        }
        pending.consumed = consumed;
      }
      if (pending && pending.consumed === pending.length) {
        const write = pending;
        pending = undefined;
        write.done();
      }
      done();
    },
    flush(done) {
      done(creditRemaining === 0 ? undefined : new Error("Truncated plugin child input credit"));
    },
  });
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      if (chunk.length === 0) return done();
      if (chunk.length > PLUGIN_CHILD_INPUT_BYTES_MAX) {
        return done(new Error("Plugin child input write exceeds credit window"));
      }
      const frame = framePluginChildInputWrite(chunk);
      const write = { id: frame.subarray(0, WRITE_ID_BYTES), length: chunk.length, consumed: 0, done };
      pending = write;
      sink.write(frame, (error) => {
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
  if (source.destroyed && !source.readableEnded) input.destroy();
  else source.pipe(input);
  if (sink.destroyed || sink.writableFinished) output.destroy();
  return { input, output };
}
