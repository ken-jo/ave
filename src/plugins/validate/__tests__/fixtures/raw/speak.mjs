/** Speak the raw child protocol for failure fixtures; WITHHOLD intentionally sends no reply. */
import { createInterface } from "node:readline";

export const WITHHOLD = Symbol("withhold");

const RPC_METHOD_NOT_FOUND = -32601;

export function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

export function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

export function constructed(params, lifecycleHooks = [], requires = []) {
  return {
    implementedToolNames: params.declaredToolNames,
    servesUiResources: false,
    lifecycleHooks,
    pluginProtocol: { requires },
  };
}

const DEFAULT_ANSWERS = {
  "ave/instance/construct": (request) => constructed(request.params),
  "ave/instance/start": {},
  "ave/instance/onPublished": {},
  "ave/instance/stop": {},
  "server/discover": {
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: { listChanged: false } },
  },
  "tools/list": () => ({ tools: manifestTools }),
  "tools/call": (request) => ({
    content: [{ type: "text", text: "echoed" }],
    _meta: { "ave/rawResult": request.params.arguments },
  }),
};

let manifestTools = [];

/** With exitOnEnd false, input closure leaves process lifetime to the fixture. */
export function speak(answers = {}, { exitOnEnd = true } = {}) {
  const table = { ...DEFAULT_ANSWERS, ...answers };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    if (request.method === "ave/instance/construct") {
      manifestTools = request.params.manifest.tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
      }));
    }
    const answer = table[request.method];
    if (answer === undefined) {
      send({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: RPC_METHOD_NOT_FOUND, message: `Method not found: ${request.method}` },
      });
      return;
    }
    const result = typeof answer === "function" ? answer(request) : answer;
    if (result === WITHHOLD) return;
    reply(request.id, result);
  });
  if (exitOnEnd) process.stdin.on("end", () => process.exit(0));
}
