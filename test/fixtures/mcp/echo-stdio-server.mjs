/**
 * Self-contained out-of-process MCP plugin server fixture
 * (untrusted-stdio-isolation test). Speaks the RC wire protocol over
 * newline-delimited stdin/stdout — NO project imports, so it runs as a real
 * `node` subprocess without a build step. Mirrors what a real spawned plugin
 * (StdioServerLoop + PluginMcpServer) would do.
 *
 * argv[2] is the legacy `_meta` vendor prefix (`LEGACY_META_PREFIX`), passed by
 * the test so the old name lives only in `src/shared/legacy-product-name.ts`.
 */
const legacyMetaPrefix = process.argv[2];
if (!legacyMetaPrefix) throw new Error("echo-stdio-server: missing legacy _meta prefix argument");
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
              // #885: this self-declared category is DELIBERATELY still sent —
              // the host ignores it (a plugin can lie) and registers the
              // default-strict "write" baseline. Kept to prove the reverse
              // projection does NOT honor a wire-declared category.
              // transitional: also intentionally uses the LEGACY reverse-DNS
              // `_meta` prefix — this fixture stands in for an out-of-process
              // plugin that has not yet migrated to `ave/*`, proving the host
              // still tolerates (and ignores) legacy `_meta` from a real subprocess.
              _meta: { [`${legacyMetaPrefix}category`]: "read", [`${legacyMetaPrefix}version`]: "1.0.0" },
            },
          ],
        },
      };
    case "tools/call": {
      const args = req.params?.arguments ?? {};
      // Special trigger: simulate a plugin crash to prove containment.
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
