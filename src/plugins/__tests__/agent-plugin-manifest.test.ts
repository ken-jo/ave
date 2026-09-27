import { describe, expect, it } from "vitest";
import { parseAgentPluginManifest } from "../agent-plugin-manifest.js";
import manifestSchema from "../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import { resolveAddFormats, resolveAjv } from "../config-schema.js";

const ROOT = { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer-plugin" };
const MARKET = { ...ROOT, version: "1.0.0", description: "Writing tools" };
const namespace = (value: unknown) => ({ ...MARKET, extensions: { "ai.agent-connector.ave": value } });
const ajv = new (resolveAjv())({ strict: true, strictRequired: false, allErrors: true, allowUnionTypes: true });
resolveAddFormats()(ajv);
const valid = ajv.compile(manifestSchema);

describe("agent-plugin manifest branches", () => {
  it("accepts a portable root, an entry extension, a process extension and a component-only plugin", () => {
    expect(valid(ROOT)).toBe(true);
    expect(valid(namespace({ entry: "dist/index.js", tools: [] }))).toBe(true);
    expect(valid(namespace({ process: { command: "./bin/worker", args: [] }, tools: [] }))).toBe(true);
    expect(valid(namespace({ requires: { minAppVersion: "0.12.0" }, mcpAuth: { editor: { auth: "api-key", apiKeyEnv: "EDITOR_KEY" } } }))).toBe(true);
    expect(parseAgentPluginManifest(JSON.stringify(MARKET))).toMatchObject(MARKET);
  });

  it("refuses malformed markers, mixed branches and extension authority in a component-only plugin", () => {
    for (const value of [
      { entry: null, tools: [] },
      { entry: "dist/index.js", process: { command: "./bin/worker" }, tools: [] },
      { entry: "dist/index.js" },
      { capabilities: [] },
      { mcpAuth: { editor: { auth: "api-key", apiKeyEnv: "EDITOR_KEY", extra: true } } },
      { requires: { hostProtocol: "1", minAppVersion: "0.12.0" } },
    ]) {
      expect(valid(namespace(value)), JSON.stringify(value)).toBe(false);
      expect(() => parseAgentPluginManifest(JSON.stringify(namespace(value)))).toThrow();
    }
  });

  it("requires marketplace metadata and matches the index identity", () => {
    for (const value of [{}, { ...MARKET, $schema: "wrong" }, { ...MARKET, name: "other-plugin" }, { ...MARKET, version: "2.0.0" }]) {
      expect(() => parseAgentPluginManifest(JSON.stringify(value), { name: "writer-plugin", version: "1.0.0" })).toThrow();
    }
    expect(() => parseAgentPluginManifest(JSON.stringify(ROOT))).toThrow("needs version");
    expect(() => parseAgentPluginManifest(JSON.stringify({ ...MARKET, extensions: { "ai.agent-connector.ave": { entry: "dist/index.js", tools: [] } } }))).toThrow("extension process");
    expect(() => parseAgentPluginManifest(JSON.stringify(namespace({ process: { command: "node" }, tools: [] })))).toThrow("extension process");
  });
});
