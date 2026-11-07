import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPluginComponents } from "../../marketplace/catalog/types.js";
import { resolveRuntimeMcp } from "../agent-plugin-mcp.js";
import { parsePortableMcp, projectPortableMcp } from "../portable-mcp.js";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(command: string, args: string[] = [], cwd?: string, env?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "agent-plugin-mcp-"));
  roots.push(root);
  const generationRoot = join(root, "generation");
  const dataDir = join(root, "data");
  mkdirSync(join(generationRoot, "server"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(generationRoot, "server", "run"), "server payload");
  writeFileSync(join(generationRoot, "server.js"), "server payload");
  writeFileSync(join(generationRoot, "config.json"), "{}");
  const parsed = parsePortableMcp(JSON.stringify({ $schema: SCHEMA, mcpServers: { local: { type: "stdio", command, args, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}) } } }));
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
    expect(projection.config.bundledPayloadRoot).toBe(realpathSync(item.generationRoot));
    expect(projection.config.env).toMatchObject({ PLUGIN_ROOT: realpathSync(item.generationRoot), PLUGIN_DATA: realpathSync(item.dataDir) });
    if (command.startsWith("./")) expect(projection.config.command).toBe(join(realpathSync(item.generationRoot), "server", "run"));
    else expect(projection.config.command).toBe(command);
    if (command === "node" || command === "bun") expect(isAbsolute(projection.config.args?.[0] ?? "")).toBe(true);
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

  describe("PLUGIN_DATA paths in env and cwd follow the argv rule", () => {
    // The plugin owns PLUGIN_DATA and can repoint a link after the check, so a data path may not pass through one.
    function withDataLink(env: Record<string, string>, args: string[] = ["./server/run"]) {
      const item = fixture("node", args, undefined, env);
      mkdirSync(join(item.dataDir, "real"));
      symlinkSync(join(item.dataDir, "real"), join(item.dataDir, "link"), "dir");
      return item;
    }

    it.runIf(process.platform !== "win32")("refuses an env value that passes through a symlink under PLUGIN_DATA", () => {
      const item = withDataLink({ CONFIG: "${PLUGIN_DATA}/link/cfg" });
      expect(() => resolveRuntimeMcp(item.staticServers, item.activation))
        .toThrow(/env\.CONFIG passes through a symlink or reparse point inside PLUGIN_DATA \('link'\)/u);
    });

    it.runIf(process.platform !== "win32")("refuses an env value that names a dangling symlink under PLUGIN_DATA", () => {
      const item = fixture("node", ["./server/run"], undefined, { CONFIG: "${PLUGIN_DATA}/gone" });
      symlinkSync(join(item.dataDir, "missing-target"), join(item.dataDir, "gone"));
      expect(() => resolveRuntimeMcp(item.staticServers, item.activation))
        .toThrow(/env\.CONFIG passes through a symlink or reparse point inside PLUGIN_DATA \('gone'\)/u);
    });

    it.runIf(process.platform !== "win32")("still resolves an env value whose PLUGIN_DATA path has no link, existing or not", () => {
      const item = withDataLink({ CONFIG: "${PLUGIN_DATA}/real/cfg", ROOT_DATA: "${PLUGIN_DATA}" });
      const projection = resolveRuntimeMcp(item.staticServers, item.activation)[0]!;
      expect(projection.config.transport).toBe("stdio");
      if (projection.config.transport !== "stdio") return;
      expect(projection.config.env).toMatchObject({
        CONFIG: join(realpathSync(item.dataDir), "real", "cfg"),
        ROOT_DATA: realpathSync(item.dataDir),
      });
    });

    it.runIf(process.platform !== "win32")("refuses a cwd that passes through a symlink under PLUGIN_DATA", () => {
      const item = fixture("node", ["./server/run"], "${PLUGIN_DATA}/link");
      mkdirSync(join(item.dataDir, "real"));
      symlinkSync(join(item.dataDir, "real"), join(item.dataDir, "link"), "dir");
      expect(() => resolveRuntimeMcp(item.staticServers, item.activation))
        .toThrow(/\.cwd passes through a symlink or reparse point inside PLUGIN_DATA \('link'\)/u);
    });

    it.runIf(process.platform !== "win32")("refuses a cwd that names a dangling symlink under PLUGIN_DATA", () => {
      const item = fixture("node", ["./server/run"], "${PLUGIN_DATA}/gone");
      symlinkSync(join(item.dataDir, "missing-target"), join(item.dataDir, "gone"));
      expect(() => resolveRuntimeMcp(item.staticServers, item.activation))
        .toThrow(/\.cwd passes through a symlink or reparse point inside PLUGIN_DATA \('gone'\)/u);
    });

    it("still accepts a plain directory under PLUGIN_DATA as cwd", () => {
      const item = fixture("node", ["./server/run"], "${PLUGIN_DATA}/work");
      mkdirSync(join(item.dataDir, "work"));
      const projection = resolveRuntimeMcp(item.staticServers, item.activation)[0]!;
      expect(projection.config.transport === "stdio" && projection.config.cwd).toBe(join(realpathSync(item.dataDir), "work"));
    });

    // The host creates PLUGIN_DATA; a root that is itself a link could be repointed after the check, in any form.
    it.runIf(process.platform !== "win32").each([
      ["env, bare", undefined, { CONFIG: "${PLUGIN_DATA}" }, /env\.CONFIG: the plugin data root .* is a symlink/u],
      ["env, subpath", undefined, { CONFIG: "${PLUGIN_DATA}/cfg" }, /env\.CONFIG: the plugin data root .* is a symlink/u],
      ["cwd, bare", "${PLUGIN_DATA}", undefined, /\.cwd: the plugin data root .* is a symlink/u],
      ["cwd, subpath", "${PLUGIN_DATA}/work", undefined, /\.cwd: the plugin data root .* is a symlink/u],
    ] as const)("refuses a symlinked PLUGIN_DATA root (%s)", (_case, cwd, env, message) => {
      const item = fixture("node", ["./server/run"], cwd, env ? { ...env } : undefined);
      mkdirSync(join(item.dataDir, "work"));
      const linkedRoot = `${item.dataDir}-link`;
      symlinkSync(item.dataDir, linkedRoot, "dir");
      expect(() => resolveRuntimeMcp(item.staticServers, { ...item.activation, dataDir: linkedRoot })).toThrow(message);
    });

    it("still resolves bare and subpath PLUGIN_DATA env and cwd against a plain root", () => {
      const item = fixture("node", ["./server/run"], "${PLUGIN_DATA}/work", { BARE: "${PLUGIN_DATA}", SUB: "${PLUGIN_DATA}/cfg" });
      mkdirSync(join(item.dataDir, "work"));
      const projection = resolveRuntimeMcp(item.staticServers, item.activation)[0]!;
      expect(projection.config.transport).toBe("stdio");
      if (projection.config.transport !== "stdio") return;
      const dataRoot = realpathSync(item.dataDir);
      expect(projection.config.cwd).toBe(join(dataRoot, "work"));
      expect(projection.config.env).toMatchObject({ BARE: dataRoot, SUB: join(dataRoot, "cfg") });
    });

    it.runIf(process.platform !== "win32")("keeps refusing the same path in args", () => {
      const item = withDataLink({}, ["./server/run", "${PLUGIN_DATA}/link/cfg"]);
      expect(() => resolveRuntimeMcp(item.staticServers, item.activation))
        .toThrow(/passes through a symlink or reparse point inside PLUGIN_DATA \('link'\)/u);
    });
  });
});
