import { describe, expect, it } from "vitest";
import { exportPortableMcp, parsePortableMcp, projectPortableMcp } from "../portable-mcp.js";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

function document(mcpServers: Record<string, unknown>) {
  return JSON.stringify({ $schema: SCHEMA, mcpServers });
}

describe("portable MCP configuration", () => {
  it("parses the portable variants and projects symbolic runtime fields", () => {
    const parsed = parsePortableMcp(document({
      local: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"], cwd: "${PLUGIN_DATA}/work", env: { DATA_FILE: "${PLUGIN_DATA}/state" } },
      remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Client": "sample" } },
    }));
    expect(projectPortableMcp(parsed)).toEqual({
      local: { transport: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.js"], cwd: "${PLUGIN_DATA}/work", env: { DATA_FILE: "${PLUGIN_DATA}/state" } },
      remote: { transport: "http", url: "https://example.test/mcp", headers: { "X-Client": "sample" } },
    });
  });

  it("keeps package paths and defaults symbolic for identical authority under different roots", () => {
    const parsed = parsePortableMcp(document({ local: { type: "stdio", command: "./server/run" } }));
    const projected = projectPortableMcp(parsed, { local: { auth: "api-key", apiKeyEnv: "SERVICE_TOKEN" } });
    expect(projected.local).toEqual({ transport: "stdio", command: "./server/run", cwd: "${PLUGIN_ROOT}", auth: "api-key", apiKeyEnv: "SERVICE_TOKEN" });
    expect(projectPortableMcp(parsePortableMcp(JSON.stringify(exportPortableMcp(projected))), { local: { auth: "api-key", apiKeyEnv: "SERVICE_TOKEN" } })).toEqual(projected);
    expect(JSON.stringify(exportPortableMcp(projected))).not.toContain("SERVICE_TOKEN");
  });

  it.each([
    ["legacy transport", { type: "sse", url: "https://example.test/mcp" }],
    ["placeholder command", { type: "stdio", command: "${PLUGIN_ROOT}/server" }],
    ["escaping command", { type: "stdio", command: "./../server" }],
    ["outside cwd", { type: "stdio", command: "node", cwd: "../outside" }],
    ["escaping cwd", { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/../outside" }],
    ["reserved environment", { type: "stdio", command: "node", env: { PLUGIN_DATA: "outside" } }],
    ["launcher environment", { type: "stdio", command: "node", env: { NPM_CONFIG_REGISTRY: "https://example.test" } }],
    ["unknown field", { type: "stdio", command: "node", extra: true }],
    ["unsecured URL", { type: "streamable-http", url: "http://example.test/mcp" }],
  ])("refuses %s", (_label, server) => {
    expect(() => parsePortableMcp(document({ local: server }))).toThrow();
  });

  it("names the unsupported transport", () => {
    expect(() => parsePortableMcp(document({ local: { type: "sse", url: "https://example.test/mcp" } }))).toThrow(/sse is not supported/u);
  });

  it("refuses undeclared and invalid credential declarations", () => {
    const parsed = parsePortableMcp(document({ local: { type: "stdio", command: "node" } }));
    expect(() => projectPortableMcp(parsed, { absent: { auth: "api-key", apiKeyEnv: "SERVICE_TOKEN" } })).toThrow(/names no MCP server/u);
    expect(() => projectPortableMcp(parsed, { local: { auth: "api-key", apiKeyHeader: "X-Token" } })).toThrow(/apiKeyEnv/u);
    expect(() => projectPortableMcp(parsed, { local: { auth: "api-key", apiKeyEnv: "NODE_OPTIONS" } })).toThrow(/apiKeyEnv/u);
    expect(() => projectPortableMcp(parsed, { local: { auth: "api-key", apiKeyEnv: "SERVICE_TOKEN", extra: true } as never })).toThrow(/unknown fields/u);
  });

  it("refuses duplicate JSON keys before projection", () => {
    expect(() => parsePortableMcp(`{"$schema":"${SCHEMA}","mcpServers":{},"mcpServers":{}}`)).toThrow();
  });

  it("keeps server names that overlap object prototype members", () => {
    const parsed = parsePortableMcp(`{"$schema":"${SCHEMA}","mcpServers":{"constructor":{"type":"stdio","command":"node"},"toString":{"type":"stdio","command":"node"}}}`);
    const projected = projectPortableMcp(parsed);
    expect(Object.keys(projected)).toEqual(["constructor", "toString"]);
    expect(Object.keys(exportPortableMcp(projected).mcpServers)).toEqual(["constructor", "toString"]);
  });

  it("does not read inherited credential declarations", () => {
    const parsed = parsePortableMcp(document({ toString: { type: "stdio", command: "node" } }));
    expect(projectPortableMcp(parsed).toString).toEqual({ transport: "stdio", command: "node", cwd: "${PLUGIN_ROOT}" });
  });

  it("refuses control characters in HTTP header values", () => {
    expect(() => parsePortableMcp(document({ remote: { type: "streamable-http", url: "https://example.test/mcp", headers: { "X-Client": "line\r\nbreak" } } }))).toThrow(/headers/u);
  });
});
