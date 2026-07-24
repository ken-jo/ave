import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { SkillStore } from "../../main/skill-store.js";
import type { PluginManifest } from "../types.js";
import {
  PluginBundleLifecycle,
  type PluginBundleLifecycleDeps,
} from "../plugin-bundle-lifecycle.js";
import { hashReceiptFiles } from "../plugin-install-receipt.js";
import { makeTestTreeWritable } from "./test-helpers.js";

const roots: string[] = [];

function inertLoopbackManager() {
  const prepared = (pluginId: string, generationId: string) => ({
    pluginId,
    generationId,
    tools: [],
    registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
    published: false,
    disconnectPredecessor: false,
  });
  return {
    prepareGeneration: vi.fn(async (manifest: PluginManifest, generationId: string) =>
      prepared(manifest.id, generationId)),
    prepareRemoval: vi.fn((pluginId: string, generationId: string) =>
      prepared(pluginId, generationId)),
    publishGeneration: vi.fn((candidate: { published: boolean }) => { candidate.published = true; }),
    postPublishGeneration: vi.fn(),
    discardGeneration: vi.fn(async () => undefined),
    retireGeneration: vi.fn(async () => undefined),
  };
}

function makeLifecycle(
  deps: Omit<PluginBundleLifecycleDeps, "loopbackManager" | "revokeOperationGeneration"> &
    Partial<Pick<PluginBundleLifecycleDeps, "loopbackManager" | "revokeOperationGeneration">>,
): PluginBundleLifecycle {
  return new PluginBundleLifecycle({
    loopbackManager: inertLoopbackManager() as never,
    revokeOperationGeneration: vi.fn(),
    ...deps,
  });
}

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
    activationId: "test-activation",
    manifest,
    pluginRoot,
    instance: { handlers: {} },
    methods: new Map(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("PluginBundleLifecycle", () => {
  it("rejects a missing receipt cache root with an explicit contract error", () => {
    expect(() => new PluginBundleLifecycle({ receiptCacheRoot: "" } as never)).toThrow(
      "PluginBundleLifecycle requires a non-empty receiptCacheRoot",
    );
  });

  it("uses an explicit empty transition instead of fabricating an inactive generation", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const getRuntimeGenerationProjection = vi.fn(() => undefined as ReturnType<typeof runtimeProjection> | undefined);
    const prepareRuntimeRemoval = vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() }));
    const loopbackManager = inertLoopbackManager();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection,
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval,
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: { bundledServerIdsForPlugin: vi.fn(() => []) } as never,
      loopbackManager: loopbackManager as never,
    });
    const durableCommit = vi.fn(async () => "committed");

    const inactiveCommit = await lifecycle.deactivateWithCommit("orion-api", durableCommit);
    expect(inactiveCommit).toMatchObject({
      result: "committed",
    });
    await expect(inactiveCommit.retirement).resolves.toBeUndefined();
    expect(prepareRuntimeRemoval).not.toHaveBeenCalled();
    expect(loopbackManager.prepareRemoval).not.toHaveBeenCalled();

    getRuntimeGenerationProjection.mockReturnValue(runtimeProjection(manifest, pluginRoot));
    await expect(lifecycle.deactivateWithCommit("orion-api", durableCommit)).rejects.toThrow(
      /live projections without an active bundle generation/,
    );
    expect(durableCommit).toHaveBeenCalledOnce();
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
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore,
      hookManager,
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
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

    const active = lifecycle.getActive("orion-api");
    expect(active).not.toHaveProperty("state");
    expect(active?.manifest).not.toBe(manifest);
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active?.manifest)).toBe(true);
    expect(Object.isFrozen(active?.manifest.tools)).toBe(true);
    const generationId = active?.generationId;
    expect(generationId).toMatch(/^[a-f0-9]{64}$/);
    await lifecycle.deactivate("orion-api");
    await lifecycle.waitForRetirements();
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(2);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(2);
    expect(skillStore.listCatalogSync()).toEqual([]);
    expect(disconnectBundledGeneration).toHaveBeenCalledWith("orion-api", generationId);
  });

  it("keeps published MCP trust committed when predecessor retirement exhausts retries", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const publishBundledGeneration = vi.fn((prepared) => { prepared.published = true; });
    const discardBundledGeneration = vi.fn(async () => undefined);
    const retirePublishedMcpReplacement = vi.fn(async () => undefined);
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async ({ pluginId, generationId }) => ({
          pluginId,
          generationId,
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
        })),
        publishBundledGeneration,
        discardBundledGeneration,
        retirePublishedMcpReplacement,
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });
    await lifecycle.activate("orion-api");
    await lifecycle.waitForRetirements();
    retirePublishedMcpReplacement.mockRejectedValue(new Error("retirement endpoint token=secret"));

    await lifecycle.approveMcpServer("orion-api", "orion");
    await lifecycle.waitForRetirements();

    const trust = lifecycle.listContributionTrust("orion-api")
      .find((row) => row.kind === "mcpServer" && row.localId === "orion");
    expect(trust?.status).toBe("approved");
    expect(publishBundledGeneration).toHaveBeenCalledTimes(2);
    expect(discardBundledGeneration).not.toHaveBeenCalled();
    const healthRaw = await readFile(join(cacheRoot, "plugin-generation-health.json"), "utf8");
    expect(healthRaw).toContain("mcp-predecessor-retirement");
    expect(healthRaw).not.toContain("token=secret");
  });

  it("restores durable MCP trust when a revoke candidate cannot be prepared", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const prepareBundledGeneration = vi.fn(async ({ pluginId, generationId }) => ({
      pluginId,
      generationId,
      predecessorServerIds: [],
      predecessorToolNames: [],
      records: [],
      registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
      published: false,
    }));
    const publishBundledGeneration = vi.fn((prepared) => { prepared.published = true; });
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration,
        publishBundledGeneration,
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate("orion-api");
    await lifecycle.approveMcpServer("orion-api", "orion");
    prepareBundledGeneration.mockRejectedValueOnce(new Error("candidate preparation failed"));

    await expect(lifecycle.revokeMcpServer("orion-api", "orion")).rejects.toThrow(
      "candidate preparation failed",
    );
    expect(lifecycle.listContributionTrust("orion-api")).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", localId: "orion", status: "approved" }),
    );
    expect(publishBundledGeneration).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed hidden candidate without replacing the active generation", async () => {
    const valid = await fixture();
    const skillStore = new SkillStore({ userDir: join(valid.root, "user-skills") });
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => valid.manifest,
        getPluginRoot: () => valid.pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(valid.manifest, valid.pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: valid.manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: valid.manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: valid.cacheRoot,
      skillStore,
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
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
    const generationRoot = join(
      valid.cacheRoot,
      "orion-api",
      "generations",
    );
    const generationsBefore = await readdir(generationRoot);

    await writeFile(join(valid.pluginRoot, "hooks", "policy.json"), "{", "utf8");
    const receiptPath = join(valid.cacheRoot, "orion-api", "install-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.files.find((file: { path: string }) => file.path === "hooks/policy.json").sha256 = createHash("sha256").update("{").digest("hex");
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await expect(lifecycle.activate("orion-api")).rejects.toThrow(/not valid JSON/);
    expect(lifecycle.getActive("orion-api")?.generationId).toBe(active?.generationId);
    expect(skillStore.listCatalogSync()).toHaveLength(1);
    expect(await readdir(generationRoot)).toEqual(generationsBefore);
  });

  it("removes an inactive retained generation when durable commit rejects", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({
          pluginId: manifest.id,
          publish: vi.fn(),
        })),
        prepareRuntimeRemoval: vi.fn(() => ({
          pluginId: manifest.id,
          publish: vi.fn(),
        })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async () => ({
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: {
            publish: vi.fn(),
            cancel: vi.fn(),
            replacementTools: [],
          },
          published: false,
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(),
      } as never,
    });
    const receiptRaw = await readFile(
      join(cacheRoot, "orion-api", "install-receipt.json"),
      "utf8",
    );
    const commitFailure = new Error("registry commit rejected");

    await expect(
      lifecycle.replaceRuntimeWithCommit(
        runtimeProjection(manifest, pluginRoot),
        receiptRaw,
        async () => {
          throw commitFailure;
        },
      ),
    ).rejects.toBe(commitFailure);

    const generationRoot = join(cacheRoot, "orion-api", "generations");
    const retained = await readdir(generationRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    expect(retained).toEqual([]);
    expect(lifecycle.getActive("orion-api")).toBeUndefined();
  });

  it("journals retirement progress and retries only the failed cleanup phase", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const stopRuntime = vi.fn();
    const drainRuntime = vi.fn()
      .mockRejectedValueOnce(new Error("HostApi drain failed"))
      .mockResolvedValue(undefined);
    const prepareRuntimeRetirement = vi.fn(() => [
      { phase: "runtime.stop" as const, run: stopRuntime },
      { phase: "runtime.drain" as const, run: drainRuntime },
    ]);
    const disconnectBundledGeneration = vi.fn();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement,
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
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
        disconnectBundledGeneration,
      } as never,
    });

    await lifecycle.activate("orion-api");
    const committed = await lifecycle.deactivateWithCommit(
      "orion-api",
      async () => "removed",
    );
    expect(committed.result).toBe("removed");
    await committed.retirement;

    expect(disconnectBundledGeneration).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeRetirement).toHaveBeenCalledTimes(2);
    expect(stopRuntime).toHaveBeenCalledTimes(1);
    expect(drainRuntime).toHaveBeenCalledTimes(2);
    const journal = JSON.parse(await readFile(join(cacheRoot, "plugin-retirement-journal.json"), "utf8"));
    expect(journal.retirements).toEqual([]);
  });

  it("durably journals internal runtime and MCP post-commit faults without rolling back the committed generation", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(async () => { throw new Error("runtime restore failed"); }),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async () => ({
          predecessorServerIds: [],
          predecessorToolNames: [],
          records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
          degraded: [],
        })),
        publishBundledGeneration: vi.fn(() => { throw new Error("publication invariant failed"); }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });
    const receiptRaw = await readFile(join(cacheRoot, "orion-api", "install-receipt.json"), "utf8");
    const durableCommit = vi.fn(async () => "committed");

    const committed = await lifecycle.replaceRuntimeWithCommit(
      runtimeProjection(manifest, pluginRoot),
      receiptRaw,
      durableCommit,
    );

    expect(committed.result).toBe("committed");
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(lifecycle.getActive("orion-api")).toBeDefined();
    const health = JSON.parse(await readFile(join(cacheRoot, "plugin-generation-health.json"), "utf8"));
    expect(health.faults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: "orion-api",
        phase: "runtime-post-publish",
        errorName: "Error",
        errorCode: null,
        message: "internal post-commit fault",
      }),
      expect.objectContaining({
        pluginId: "orion-api",
        phase: "mcp-publication",
        errorName: "Error",
        errorCode: null,
        message: "internal post-commit fault",
      }),
    ]));
    expect(JSON.stringify(health)).not.toContain("runtime restore failed");
    expect(JSON.stringify(health)).not.toContain("publication invariant failed");
  });
});
