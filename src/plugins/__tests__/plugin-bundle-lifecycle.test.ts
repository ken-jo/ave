import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillStore } from "../../main/skill-store.js";
import type { PluginManifest } from "../types.js";
import { PluginBundleLifecycle } from "../plugin-bundle-lifecycle.js";

const roots: string[] = [];

async function fixture(hookContent = JSON.stringify({ hooks: { PreToolUse: [] } })) {
  const root = mkdtempSync(join(tmpdir(), "ave-bundle-life-"));
  roots.push(root);
  const pluginRoot = join(root, "plugin");
  const cacheRoot = join(root, "cache");
  await mkdir(join(pluginRoot, "skills", "attendance"), { recursive: true });
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(join(pluginRoot, "mcp"), { recursive: true });
  const manifest = {
    id: "orion-api",
    name: "ORION API",
    version: "1.0.0",
    entry: "dist/index.js",
    tools: [],
    skills: [{ id: "attendance", path: "skills/attendance" }],
    hooks: [{ id: "policy", path: "hooks/policy.json" }],
    mcpServers: [{ id: "orion", path: "mcp/orion.json" }],
  } as unknown as PluginManifest;
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(manifest), "utf8");
  await writeFile(join(pluginRoot, "skills", "attendance", "SKILL.md"), "---\nname: attendance\ndescription: Attendance workflow\n---\nUse the ORION attendance API.", "utf8");
  await writeFile(join(pluginRoot, "hooks", "policy.json"), hookContent, "utf8");
  await writeFile(join(pluginRoot, "mcp", "orion.json"), JSON.stringify({ transport: "http", url: "https://orion.example.test/mcp" }), "utf8");
  await mkdir(join(cacheRoot, "orion-api"), { recursive: true });
  await writeFile(join(cacheRoot, "orion-api", "install-receipt.json"), JSON.stringify({ pluginId: "orion-api", version: "1.0.0" }), "utf8");
  return { root, pluginRoot, cacheRoot, manifest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginBundleLifecycle", () => {
  it("publishes Skills, keeps executable bundles fail-closed, approves exact owners, and tears down", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const skillStore = new SkillStore({ userDir: join(root, "user-skills") });
    const hookManager = new ScriptHookManager();
    const connectBundledServer = vi.fn(async () => ({ status: "approval_required" as const, registeredTools: [] }));
    const disconnectBundledGeneration = vi.fn(async () => undefined);
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
      },
      receiptCacheRoot: cacheRoot,
      skillStore,
      skillOverlay: new SkillOverlay(),
      hookManager,
      mcpManager: { connectBundledServer, disconnectBundledGeneration } as never,
    });

    await lifecycle.activate("orion-api");
    expect(skillStore.listCatalogSync()).toEqual([expect.objectContaining({ name: "plugin:orion-api:attendance" })]);
    expect(hookManager.size()).toBe(0);
    expect(connectBundledServer).toHaveBeenCalledWith(expect.anything(), lifecycle.mcpTrust);

    await lifecycle.approveHook("orion-api", "policy");
    expect(hookManager.size()).toBe(0); // descriptor intentionally contains no runnable entries
    await lifecycle.approveMcpServer("orion-api", "orion");
    expect(connectBundledServer).toHaveBeenLastCalledWith(expect.anything(), lifecycle.mcpTrust);

    const generationId = lifecycle.getActive("orion-api")?.generationId;
    expect(generationId).toMatch(/^[a-f0-9]{64}$/);
    await lifecycle.deactivate("orion-api");
    expect(skillStore.listCatalogSync()).toEqual([]);
    expect(disconnectBundledGeneration).toHaveBeenCalledWith("orion-api", generationId);
  });

  it("rejects a malformed hidden candidate without replacing the active generation", async () => {
    const valid = await fixture();
    const skillStore = new SkillStore({ userDir: join(valid.root, "user-skills") });
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: {
        getPluginManifest: () => valid.manifest,
        getPluginRoot: () => valid.pluginRoot,
      },
      receiptCacheRoot: valid.cacheRoot,
      skillStore,
      skillOverlay: new SkillOverlay(),
      hookManager: new ScriptHookManager(),
      mcpManager: { connectBundledServer: vi.fn(), disconnectBundledGeneration: vi.fn() } as never,
    });
    await lifecycle.activate("orion-api");
    const active = lifecycle.getActive("orion-api");

    await writeFile(join(valid.pluginRoot, "hooks", "policy.json"), "{", "utf8");
    await expect(lifecycle.activate("orion-api")).rejects.toThrow(/not valid JSON/);
    expect(lifecycle.getActive("orion-api")?.generationId).toBe(active?.generationId);
    expect(skillStore.listCatalogSync()).toHaveLength(1);
  });
});
