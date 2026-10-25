// Run a self-contained newline-delimited protocol server without project imports or a build step.

const UNKNOWN_META_PREFIX = "xyz.example/";
let buffer = Buffer.alloc(0);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(req) {
  const id = req.id;
  switch (req.method) {
    case "server/discover":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions: ["2026-07-28"],
          serverInfo: { name: "echo", version: "1.0.0", description: "echo" },
          capabilities: { tools: { listChanged: true } },
        },
      };
    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          tools: [
            {
              name: "echo_say",
              description: "echo a message",
              inputSchema: {
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: { msg: { type: "string" } },
                required: ["msg"],
              },
              // Send an untrusted self-declared category to prove the host retains its strict baseline.
              // Unknown metadata prefixes must not grant authority.
              _meta: { [`${UNKNOWN_META_PREFIX}category`]: "read", [`${UNKNOWN_META_PREFIX}version`]: "1.0.0" },
            },
          ],
        },
      };
    case "tools/call": {
      const args = req.params?.arguments ?? {};
      if (args.crash) process.exit(7);
      return {
        jsonrpc: "2.0",
        id,
        result: { resultType: "complete", content: [{ type: "text", text: `echo: ${args.msg}` }] },
      };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const lineEnd = buffer.indexOf(0x0a);
    if (lineEnd === -1) break;
    const line = buffer.subarray(0, lineEnd).toString("utf-8");
    buffer = buffer.subarray(lineEnd + 1);
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    if (req.method && req.id !== undefined) {
      Promise.resolve(handle(req)).then((res) => write(res));
    }
  }
});
