/**
 * Newline-delimited stdio framing for JSON-RPC, shared by the out-of-process
 * plugin path (mcp-alignment-design.md §3.1, `untrusted-stdio-isolation`).
 *
 * One message is one line: the MCP `2026-07-28` stdio binding ("newline-delimited
 * JSON-RPC over a byte stream"), which is what an off-the-shelf MCP server
 * library emits, so a plugin written in another language frames the way the
 * host-shipped reference runtime does (plugin-hostapi-protocol.md §2.3).
 * External MCP servers are read by `mcp-client.ts`'s `StdioTransport`, which
 * keeps its own line parser because it is the external boundary.
 */

/** Frame one JSON-RPC message for an output stream. */
export function frameMessage(message: unknown): Buffer {
  // JSON.stringify escapes every newline inside a string, so the serialized
  // message never contains 0x0A and the trailing one is its only delimiter.
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf-8");
}

/**
 * A peer wrote a line longer than the reader agreed to hold.
 *
 * A contract violation, not a malformed message: the peer is either broken or
 * trying to grow this process's memory without bound, and the only line that
 * could follow is the rest of the one that already overflowed. So it is
 * thrown, and the owner of the channel ends it, rather than resynchronised.
 */
export class StdioFrameOverflowError extends Error {
  constructor(readonly maxLineBytes: number) {
    super(`[stdio-framing] a line exceeded ${maxLineBytes} bytes without ending`);
    this.name = "StdioFrameOverflowError";
  }
}

/**
 * Incremental decoder: feed it stream chunks; it returns every COMPLETE line
 * parsed so far, buffering a partial line across `push` calls. The buffer stays
 * bytes until a whole line is in, so a multi-byte UTF-8 character split across
 * chunks decodes intact (0x0A never occurs inside a multi-byte sequence). A line
 * that is not a JSON object is skipped, not thrown — a hostile/buggy peer must
 * not crash the loop.
 *
 * A line longer than `maxLineBytes`, whether or not its newline has arrived,
 * throws {@link StdioFrameOverflowError}, and so does every push after it: the
 * buffer is the peer's to fill, and without a bound a peer that never writes
 * 0x0A grows it until this process runs out of memory.
 */
export class StdioFrameDecoder {
  // The unfinished line, as the chunks it arrived in. Joined once, when its
  // newline arrives: re-joining on every push, and rescanning the joined bytes
  // for a newline, is quadratic in the chunk count, and a peer that writes a
  // line just under the cap in small chunks would stall the reader on it.
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private overflowed = false;

  constructor(private readonly maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError(`[stdio-framing] maxLineBytes must be a positive integer, got ${maxLineBytes}`);
    }
  }

  /** Bytes of a line that has started but not ended. */
  get pendingBytes(): number {
    return this.partialBytes;
  }

  push(chunk: Buffer): Array<Record<string, unknown>> {
    if (this.overflowed) throw new StdioFrameOverflowError(this.maxLineBytes);
    const out: Array<Record<string, unknown>> = [];

    // Each byte of `chunk` is scanned once; bytes held from earlier pushes
    // are never scanned again, because they are known to hold no newline.
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
