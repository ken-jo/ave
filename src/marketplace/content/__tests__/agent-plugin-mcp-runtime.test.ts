import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMcpTrustStore } from "../../../mcp/plugin-mcp-projection.js";
import type { InstalledAgentPluginRuntime } from "../service.js";
import { AgentPluginMcpRuntime } from "../agent-plugin-mcp-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function packageFixture(): { item: InstalledAgentPluginRuntime; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "installed-agent-mcp-"));
  roots.push(root);
  const dir = join(root, "package");
  const dataDir = join(root, "data");
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(dataDir);
  writeFileSync(join(dir, "server", "run"), "server payload");
  const item = {
    name: "meeting-kit", version: "1.0.0", generationId: "a".repeat(64), dir,
    content: { kind: "agent-plugin", files: [], components: {
      skills: [], prompts: [], agents: [], routineTemplates: [], hooks: [],
      mcpServers: { notes: { transport: "stdio", command: "./server/run", cwd: "${PLUGIN_ROOT}", digest: "b".repeat(64) } },
    } },
  } as InstalledAgentPluginRuntime;
  return { item, dataDir };
}

describe("installed agent plugin MCP publication", () => {
  it("keeps data across an update, skips unchanged reloads, and retires removal", async () => {
    const { item, dataDir } = packageFixture();
    const prepare = vi.fn(async (_owner, projections) => ({ projections }));
    const publish = vi.fn();
    const disconnect = vi.fn(async () => undefined);
    const manager = { prepareBundledGeneration: prepare, publishBundledGeneration: publish,
      discardBundledGeneration: vi.fn(), disconnectBundledGeneration: disconnect };
    const runtime = new AgentPluginMcpRuntime(manager as never, {
      trust: new PluginMcpTrustStore(), dataDirForPackage: async () => dataDir,
    });
    await runtime.sync([item]);
    expect(prepare).toHaveBeenCalledTimes(1);
    const first = prepare.mock.calls[0]![1][0];
    expect(first.config.pluginDataDir).toBe(realpathSync(dataDir));
    expect(first.config.env.PLUGIN_DATA).toBe(realpathSync(dataDir));
    const marker = join(dataDir, "marker");
    writeFileSync(marker, "retained");
    await runtime.sync([item]);
    expect(prepare).toHaveBeenCalledTimes(1);

    const updated = { ...item, version: "1.1.0", generationId: "c".repeat(64) };
    await runtime.sync([updated]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[1]![1][0].serverId).not.toBe(first.serverId);
    expect(readFileSync(marker, "utf8")).toBe("retained");
    expect(disconnect).toHaveBeenCalledWith("agent-plugin/meeting-kit", prepare.mock.calls[0]![0].generationId);
    await runtime.sync([]);
    expect(disconnect).toHaveBeenCalledWith("agent-plugin/meeting-kit", prepare.mock.calls[1]![0].generationId);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("discards candidates when publication refuses the current policy", async () => {
    const { item, dataDir } = packageFixture();
    const prepared = { published: false };
    const discard = vi.fn(async () => undefined);
    const runtime = new AgentPluginMcpRuntime({
      prepareBundledGeneration: vi.fn(async () => prepared),
      publishBundledGeneration: () => { throw new Error("runtime approval not admitted by policy"); },
      discardBundledGeneration: discard,
      disconnectBundledGeneration: vi.fn(async () => undefined),
    } as never, { trust: new PluginMcpTrustStore(), dataDirForPackage: async () => dataDir });
    await expect(runtime.sync([item])).rejects.toThrow(/not admitted/u);
    expect(discard).toHaveBeenCalledWith(prepared);
  });
});
