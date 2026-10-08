/**
 * Frames its construct reply with a `Content-Length:` header, as a server
 * written for the old stdio framing would. The decoder drops the header lines
 * and still reads the frame; only the raw bytes show the header was there.
 */
import { constructed, speak, WITHHOLD } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: constructed(request.params) });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}\n`);
    return WITHHOLD;
  },
});
