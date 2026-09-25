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
  private buffer = Buffer.alloc(0);
  private overflowed = false;

  constructor(private readonly maxLineBytes: number) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError(`[stdio-framing] maxLineBytes must be a positive integer, got ${maxLineBytes}`);
    }
  }

  /** Bytes of a line that has started but not ended. */
  get pendingBytes(): number {
    return this.buffer.length;
  }

  push(chunk: Buffer): Array<Record<string, unknown>> {
    if (this.overflowed) throw new StdioFrameOverflowError(this.maxLineBytes);
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: Array<Record<string, unknown>> = [];

    for (;;) {
      const lineEnd = this.buffer.indexOf(0x0a);
      if (lineEnd === -1) break;
      if (lineEnd > this.maxLineBytes) this.overflow();

      const line = this.buffer.subarray(0, lineEnd).toString("utf-8");
      this.buffer = this.buffer.subarray(lineEnd + 1);

      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // Skip an unparseable line; the next one may still be intact.
      }
    }
    if (this.buffer.length > this.maxLineBytes) this.overflow();
    return out;
  }

  private overflow(): never {
    this.overflowed = true;
    this.buffer = Buffer.alloc(0);
    throw new StdioFrameOverflowError(this.maxLineBytes);
  }
}
