import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillStore } from "../../main/skill-store.js";
import type { PluginManifest } from "../types.js";
import { PluginBundleLifecycle } from "../plugin-bundle-lifecycle.js";
import { hashReceiptFiles } from "../plugin-install-receipt.js";

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
  const payloadFiles = [
    "plugin.json",
    "skills/attendance/SKILL.md",
    "hooks/policy.json",
    "mcp/orion.json",
  ];
  const files = await hashReceiptFiles(pluginRoot, payloadFiles);
  await writeFile(join(cacheRoot, "orion-api", "install-receipt.json"), JSON.stringify({
    schemaVersion: 2,
    pluginId: "orion-api",
    version: "1.0.0",
    installSource: "local-dev",
    artifactSha256: null,
    signerKeyId: null,
    installedAt: new Date(0).toISOString(),
    files,
  }), "utf8");
  return { root, pluginRoot, cacheRoot, manifest };
}

function runtimeProjection(manifest: PluginManifest, pluginRoot: string) {
  return {
    manifest,
    pluginRoot,
    instance: { handlers: {} },
    methods: new Map(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PluginBundleLifecycle", () => {
  it("rejects a missing receipt cache root with an explicit contract error", () => {
    expect(() => new PluginBundleLifecycle({ receiptCacheRoot: "" } as never)).toThrow(
      "PluginBundleLifecycle requires a non-empty receiptCacheRoot",
    );
  });

  it("publishes Skills, keeps executable bundles fail-closed, approves exact owners, and tears down", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const skillStore = new SkillStore({ userDir: join(root, "user-skills") });
    const hookManager = new ScriptHookManager();
    const prepareBundledGeneration = vi.fn(async () => ({
      predecessorServerIds: [],
      predecessorToolNames: [],
      records: [],
      registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
      published: false,
    }));
    const publishBundledGeneration = vi.fn((prepared) => { prepared.published = true; });
    const disconnectBundledGeneration = vi.fn(async () => undefined);
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        retireRuntimeGeneration: vi.fn(async () => undefined),
      },
      receiptCacheRoot: cacheRoot,
      skillStore,
      skillOverlay: new SkillOverlay(),
      hookManager,
      mcpManager: {
        prepareBundledGeneration,
        publishBundledGeneration,
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration,
      } as never,
    });

    await lifecycle.activate("orion-api");
    expect(skillStore.listCatalogSync()).toEqual([expect.objectContaining({ name: "plugin:orion-api:attendance" })]);
    expect(hookManager.size()).toBe(0);
    expect(prepareBundledGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "orion-api" }),
      expect.anything(),
      lifecycle.mcpTrust,
    );
    expect(publishBundledGeneration).toHaveBeenCalledTimes(1);

    await lifecycle.approveHook("orion-api", "policy");
    expect(hookManager.size()).toBe(0); // descriptor intentionally contains no runnable entries
    await lifecycle.approveMcpServer("orion-api", "orion");
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(2);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(2);

    const generationId = lifecycle.getActive("orion-api")?.generationId;
    expect(generationId).toMatch(/^[a-f0-9]{64}$/);
    await lifecycle.deactivate("orion-api");
    await lifecycle.waitForRetirements();
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(3);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(3);
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
        getRuntimeGenerationProjection: () => runtimeProjection(valid.manifest, valid.pluginRoot),
        prepareRuntimeGeneration: vi.fn(),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        retireRuntimeGeneration: vi.fn(async () => undefined),
      },
      receiptCacheRoot: valid.cacheRoot,
      skillStore,
      skillOverlay: new SkillOverlay(),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        prepareBundledGeneration: vi.fn(async () => ({
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(),
      } as never,
    });
    await lifecycle.activate("orion-api");
    const active = lifecycle.getActive("orion-api");

    await writeFile(join(valid.pluginRoot, "hooks", "policy.json"), "{", "utf8");
    const receiptPath = join(valid.cacheRoot, "orion-api", "install-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.files.find((file: { path: string }) => file.path === "hooks/policy.json").sha256 = createHash("sha256").update("{").digest("hex");
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await expect(lifecycle.activate("orion-api")).rejects.toThrow(/not valid JSON/);
    expect(lifecycle.getActive("orion-api")?.generationId).toBe(active?.generationId);
    expect(skillStore.listCatalogSync()).toHaveLength(1);
  });

  it("drains the active generation and atomically hides then restores bundled contributions", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const skillStore = new SkillStore({ userDir: join(root, "user-skills") });
    const publishBundledGeneration = vi.fn((prepared) => { prepared.published = true; });
    const disconnectBundledGeneration = vi.fn(async () => undefined);
    const loopbackManager = { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        retireRuntimeGeneration: vi.fn(async () => undefined),
      },
      receiptCacheRoot: cacheRoot,
      skillStore,
      skillOverlay: new SkillOverlay(),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        prepareBundledGeneration: vi.fn(async () => ({
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
        })),
        publishBundledGeneration,
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration,
      } as never,
      loopbackManager,
    });
    await lifecycle.activate("orion-api");
    const generationId = lifecycle.getActive("orion-api")?.generationId;

    const lease = await lifecycle.acquire("orion-api");
    const disabling = lifecycle.setContributionsEnabled("orion-api", false);
    await Promise.resolve();
    expect(skillStore.listCatalogSync()).toHaveLength(1);
    lease.release();
    await disabling;

    expect(lifecycle.getActive("orion-api")?.generationId).toBe(generationId);
    expect(skillStore.listCatalogSync()).toEqual([]);
    expect(loopbackManager.stop).toHaveBeenCalledWith("orion-api");
    expect(disconnectBundledGeneration).toHaveBeenCalledWith("orion-api", generationId);

    await lifecycle.setContributionsEnabled("orion-api", true);
    expect(skillStore.listCatalogSync()).toHaveLength(1);
    expect(loopbackManager.start).toHaveBeenLastCalledWith(manifest);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(3);
  });

  it("journals a failed retirement and retries exact-generation cleanup", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const retireRuntimeGeneration = vi.fn()
      .mockRejectedValueOnce(new Error("stop failed"))
      .mockResolvedValue(undefined);
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        retireRuntimeGeneration,
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      skillOverlay: new SkillOverlay(),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        prepareBundledGeneration: vi.fn(async () => ({
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate("orion-api");
    await lifecycle.deactivate("orion-api");
    await lifecycle.waitForRetirements();

    expect(retireRuntimeGeneration).toHaveBeenCalledTimes(2);
    const journal = JSON.parse(await readFile(join(cacheRoot, "plugin-retirement-journal.json"), "utf8"));
    expect(journal.retirements).toEqual([]);
  });
});
