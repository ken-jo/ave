/** Emit an old Content-Length header; only raw-byte checks reveal it because the decoder can skip it. */
import { constructed, speak, WITHHOLD } from "./speak.mjs";

speak({
  "ave/instance/construct": (request) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: constructed(request.params) });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}\n`);
    return WITHHOLD;
  },
});
