// Toolkit-owned fixtures for the row-5 holder probes: a newline-delimited JSON-RPC MCP server and a hook. They open no
// listener and no network connection; everything crosses the container's standard streams.
import { createInterface } from "node:readline";

const [mode, variant] = process.argv.slice(2);
const emit = (data) => process.stdout.write(JSON.stringify(data) + "\n");
const HOLDER_VARIABLES = ["AVE_HOOK_TYPE", "PLUGIN_ROOT", "PLUGIN_DATA", "AVE_PROBE_TOKEN"];
const markers = () => ({
  cwd: process.cwd(),
  home: process.env.HOME ?? null,
  temp: process.env.TEMP ?? null,
  holderVariables: Object.fromEntries(HOLDER_VARIABLES.map((key) => [key, process.env[key] ?? null])),
});

if (mode === "mcp-server") {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const reply = (body) => emit({ jsonrpc: "2.0", id: message.id, ...body });
    switch (message.method) {
      // A pre-final server: the client falls back to `initialize`, as Ave's client does for external servers.
      case "server/discover": return reply({ error: { code: -32601, message: "Method not found" } });
      case "initialize":
        return reply({ result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "holder-probe", version: "1" } } });
      case "tools/list":
        return reply({ result: { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "hang", inputSchema: { type: "object" } }] } });
      case "tools/call":
        // `hang` never answers: the host cancels it by disposing the container.
        if (message.params?.name === "hang") return undefined;
        return reply({ result: { content: [{ type: "text", text: JSON.stringify({ echo: message.params?.arguments ?? null, ...markers() }) }] } });
      case "probe/identity": return reply({ result: { pid: process.pid, nonce: message.params?.nonce ?? null } });
      default: return reply({ error: { code: -32601, message: "Method not found" } });
    }
  });
  // EOF ends the server, as a well-behaved stdio server does when its client closes stdin.
  lines.on("close", () => process.exit(0));
} else if (mode === "hook") {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const payload = JSON.parse(input);
    const observed = { tool: payload.tool_name ?? null, event: payload.hook_event_name ?? null, ...markers() };
    if (variant === "allow") {
      emit({ action: "allow", reason: "holder-probe", observed });
    } else if (variant === "exit2") {
      process.stderr.write("holder-probe-blocked");
      process.exitCode = 2;
    } else if (variant === "exit5") {
      process.exitCode = 5;
    } else {
      throw new Error("Unknown hook variant");
    }
  });
} else {
  throw new Error("Unknown holder fixture");
}
