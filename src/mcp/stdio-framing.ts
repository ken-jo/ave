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
 * Incremental decoder: feed it stream chunks; it returns every COMPLETE line
 * parsed so far, buffering a partial line across `push` calls. The buffer stays
 * bytes until a whole line is in, so a multi-byte UTF-8 character split across
 * chunks decodes intact (0x0A never occurs inside a multi-byte sequence). A line
 * that is not a JSON object is skipped, not thrown — a hostile/buggy peer must
 * not crash the loop.
 */
export class StdioFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Array<Record<string, unknown>> {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: Array<Record<string, unknown>> = [];

    for (;;) {
      const lineEnd = this.buffer.indexOf(0x0a);
      if (lineEnd === -1) break;

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
    return out;
  }
}
