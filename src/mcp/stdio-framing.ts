/** One JSON-RPC message per newline-delimited UTF-8 line, shared by plugin stdio transports. */

export function frameMessage(message: unknown): Buffer {
  // JSON.stringify escapes embedded newlines, leaving only the trailing delimiter.
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf-8");
}

/** Overflow is terminal: the channel must close rather than resynchronize an unbounded peer line. */
export class StdioFrameOverflowError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`[stdio-framing] a line exceeded ${maxLineBytes} bytes without ending`);
    this.name = "StdioFrameOverflowError";
  }
}

/** Buffer bytes until a full line preserves split UTF-8 code points; malformed lines are skipped.
 * The caller line cap applies before delimiters and all pushes fail after overflow. */
export class StdioFrameDecoder {
  // Join an unfinished line only once at its delimiter to avoid quadratic copying across chunks.
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private overflowed = false;

  constructor(private readonly maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError(`[stdio-framing] maxLineBytes must be a positive integer, got ${maxLineBytes}`);
    }
  }

  get pendingBytes(): number {
    return this.partialBytes;
  }

  push(chunk: Buffer): Array<Record<string, unknown>> {
    if (this.overflowed) throw new StdioFrameOverflowError(this.maxLineBytes);
    const out: Array<Record<string, unknown>> = [];

    // Scan each incoming byte once; buffered chunks are already known to contain no newline.
    let lineStart = 0;
    for (;;) {
      const lineEnd = chunk.indexOf(0x0a, lineStart);
      if (lineEnd === -1) break;
      const lineBytes = this.partialBytes + (lineEnd - lineStart);
      if (lineBytes > this.maxLineBytes) this.overflow();

      const tail = chunk.subarray(lineStart, lineEnd);
      const line =
        this.partialBytes === 0 ? tail : Buffer.concat([...this.partial, tail], lineBytes);
      this.partial = [];
      this.partialBytes = 0;
      lineStart = lineEnd + 1;

      try {
        const parsed = JSON.parse(line.toString("utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Skip an unparseable line; the next one may still be intact.
      }
    }
    if (lineStart < chunk.length) {
      this.partial.push(chunk.subarray(lineStart));
      this.partialBytes += chunk.length - lineStart;
      if (this.partialBytes > this.maxLineBytes) this.overflow();
    }
    return out;
  }

  private overflow(): never {
    this.overflowed = true;
    this.partial = [];
    this.partialBytes = 0;
    throw new StdioFrameOverflowError(this.maxLineBytes);
  }
}
