import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPluginComponents } from "../../marketplace/catalog/types.js";
import { resolveRuntimeMcp } from "../agent-plugin-mcp.js";
import { parsePortableMcp, projectPortableMcp } from "../portable-mcp.js";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(command: string, args: string[] = [], cwd?: string) {
  const root = mkdtempSync(join(tmpdir(), "agent-plugin-mcp-"));
  roots.push(root);
  const generationRoot = join(root, "generation");
  const dataDir = join(root, "data");
  mkdirSync(join(generationRoot, "server"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(generationRoot, "server", "run"), "server payload");
  writeFileSync(join(generationRoot, "server.js"), "server payload");
  writeFileSync(join(generationRoot, "config.json"), "{}");
  const parsed = parsePortableMcp(JSON.stringify({ $schema: SCHEMA, mcpServers: { local: { type: "stdio", command, args, ...(cwd ? { cwd } : {}) } } }));
  const projected = projectPortableMcp(parsed);
  const staticServers = { local: { ...projected.local!, digest: "a".repeat(64) } } as AgentPluginComponents["mcpServers"];
  return { staticServers, generationRoot, dataDir, activation: { packageName: "kit", version: "1.0.0", generationRoot, dataDir, activationId: "run-a", generationId: "tree-a", approvalDigests: { local: "c".repeat(64) } } };
}

describe("agent plugin MCP runtime resolution", () => {
  it.each([
    ["npx", ["-y", "example-server@1.2.3", "--data", "${PLUGIN_DATA}/db"]],
    ["npx", ["-y", "@example/server@1.2.3"]],
    ["uvx", ["example-server==1.2.3"]],
    ["uvx", ["--from", "example-server==1.2.3", "example-cli"]],
    ["docker", ["run", "-i", "--rm", "ghcr.io/example/server:1.2.3"]],
    ["docker", ["run", "-i", "--rm", `example/server@sha256:${"a".repeat(64)}`]],
    ["./server/run", ["${PLUGIN_ROOT}/config.json"]],
    ["node", ["${PLUGIN_ROOT}/server.js"]],
    ["bun", ["./server/run"]],
  ])("resolves a pinned %s launcher without treating its package literal as a path", (command, args) => {
    const item = fixture(command, args);
    const projection = resolveRuntimeMcp(item.staticServers, item.activation)[0]!;
    expect(projection.owner.pluginId).toBe("agent-plugin/kit");
    expect(projection.approval.bundled).toMatchObject({ package: "agent-plugin/kit", server: "local" });
    expect(projection.config.transport).toBe("stdio");
    if (projection.config.transport !== "stdio") return;
    expect(projection.config.cwd).toBe(realpathSync(item.generationRoot));
    expect(projection.config.pluginDataDir).toBe(realpathSync(item.dataDir));
    expect(projection.config.env).toMatchObject({ PLUGIN_ROOT: realpathSync(item.generationRoot), PLUGIN_DATA: realpathSync(item.dataDir) });
    if (command.startsWith("./")) expect(projection.config.command).toBe(join(realpathSync(item.generationRoot), "server", "run"));
    else expect(projection.config.command).toBe(command);
    if (command === "node" || command === "bun") expect(projection.config.args?.[0]).toMatch(/^\//u);
    if (command === "npx" && args.includes("${PLUGIN_DATA}/db")) expect(projection.config.args?.at(-1)).toBe(join(realpathSync(item.dataDir), "db"));
  });

  it("keeps the static projection free of roots, activation ids and secrets", () => {
    const item = fixture("node", ["./server/run"], "${PLUGIN_DATA}");
    const snapshot = JSON.stringify(item.staticServers);
    const projection = resolveRuntimeMcp(item.staticServers, item.activation)[0]!;
    expect(JSON.stringify(item.staticServers)).toBe(snapshot);
    expect(snapshot).not.toContain(item.generationRoot);
    expect(snapshot).not.toContain(item.dataDir);
    expect(snapshot).not.toContain("run-a");
    expect(projection.config.transport === "stdio" && projection.config.cwd).toBe(realpathSync(item.dataDir));
  });

  it("carries the server's approval digest and refuses an activation that has none", () => {
    const item = fixture("node", ["./server/run"]);
    expect(resolveRuntimeMcp(item.staticServers, item.activation)[0]!.approvalDigest).toBe("c".repeat(64));
    expect(resolveRuntimeMcp(item.staticServers, { ...item.activation, approvalDigests: { local: null } })[0]!.approvalDigest).toBeNull();
    expect(() => resolveRuntimeMcp(item.staticServers, { ...item.activation, approvalDigests: {} })).toThrow(/has no approval digest/u);
  });
});
