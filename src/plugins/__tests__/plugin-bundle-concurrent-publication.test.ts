import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../__tests__/support/plugin-child-entry.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { PersonaPromptStore } from "../../main/persona-prompt-store.js";
import { SkillStore } from "../../main/skill-store.js";
import { PluginLoopbackManager } from "../../mcp/plugin-loopback-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { PluginBundleLifecycle } from "../plugin-bundle-lifecycle.js";
import type { PluginRuntimeGenerationProjection } from "../plugin-host-generation.js";
import { hashReceiptFiles } from "../plugin-install-receipt.js";
import { PluginRuntime } from "../runtime.js";
import { createNoopHostApiForTests } from "../runtime/sandbox.js";
import type { PluginManifest } from "../types.js";
import { agentPluginsDocument, makeTestTreeWritable } from "./test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ave-bundle-concurrent-"));
  roots.push(root);
  const cacheRoot = join(root, "cache");
  const runtime = new PluginRuntime({
    childEntryPath: pluginChildEntryPath(),
    encryption: unavailableSecretEncryption,
    hostRoot: root,
    createHostApi: createNoopHostApiForTests,
  });
  const registry = new ToolRegistry();
  const loopbackManager = new PluginLoopbackManager(runtime, registry, vi.fn());
  const lifecycle = new PluginBundleLifecycle({
    pluginRuntime: runtime,
    receiptCacheRoot: cacheRoot,
    skillStore: new SkillStore({ userDir: join(root, "skills") }),
    personaPromptStore: new PersonaPromptStore({ userDir: join(root, "prompts") }),
    hookManager: new ScriptHookManager(),
    loopbackManager,
    mcpManager: {
      bundledServerIdsForPlugin: vi.fn(() => []),
      prepareBundledGeneration: vi.fn(async () => ({ published: false })),
      publishBundledGeneration: vi.fn((prepared: { published: boolean }) => { prepared.published = true; }),
      retirePublishedMcpReplacement: vi.fn(async () => undefined),
    } as never,
    revokeOperationGeneration: vi.fn(),
    onContributionsUpdated: vi.fn(),
  });
  runtime.setGenerationAccess(lifecycle);

  async function candidate(pluginId: string) {
    const pluginRoot = join(root, pluginId);
    await mkdir(pluginRoot, { recursive: true });
    const manifest: PluginManifest = {
      id: pluginId,
      name: pluginId,
      description: "Method reservation fixture",
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [
        {
          name: `${pluginId.replaceAll("-", "_")}_read`,
          inputSchema: { type: "object", properties: {} },
          _meta: { ui: { visibility: ["model"] } },
        },
        {
          name: "shared_method",
          // Missing array items keeps this method out of loopback discovery.
          inputSchema: { type: "object", properties: { values: { type: "array" } } },
          _meta: { ui: { visibility: ["model"] } },
        },
      ],
    };
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
    const receiptRaw = JSON.stringify({
      schemaVersion: 2,
      pluginId,
      version: manifest.version,
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginRoot, ["plugin.json"]),
    });
    const handlers = Object.fromEntries(manifest.tools.map((tool) => [tool.name, async () => pluginId]));
    const projection: PluginRuntimeGenerationProjection = {
      activationId: pluginId,
      installId: pluginId,
      manifest,
      pluginRoot,
      instance: { handlers },
      methods: new Map(Object.entries(handlers)),
      arm: "child",
      confinement: "unconfined",
    };
    return { projection, receiptRaw };
  }

  return { cacheRoot, runtime, registry, loopbackManager, lifecycle, candidate };
}

describe("concurrent bundle method reservations", () => {
  it("refuses a lint-dropped shared method during preparation before the second durable commit", async () => {
    const { cacheRoot, runtime, registry, loopbackManager, lifecycle, candidate } = await fixture();
    const first = await candidate("first-plugin");
    const second = await candidate("second-plugin");
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstPrepared = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const firstCommit = vi.fn(async () => {
      enteredFirst();
      await commitBarrier;
    });
    const secondCommit = vi.fn(async () => undefined);
    const firstPublication = lifecycle.replaceRuntimeWithCommit(first.projection, first.receiptRaw, firstCommit);
    void firstPublication.catch(() => undefined);
    await Promise.race([firstPrepared, firstPublication]);

    try {
      expect(lifecycle.getActive("first-plugin")).toBeUndefined();
      await expect(lifecycle.replaceRuntimeWithCommit(second.projection, second.receiptRaw, secondCommit))
        .rejects.toThrow("Tool name is already reserved: shared_method");
      expect(secondCommit).not.toHaveBeenCalled();
      expect(lifecycle.getActive("second-plugin")).toBeUndefined();
      expect(await readdir(join(cacheRoot, "second-plugin", "generations"))).toEqual([]);
    } finally {
      releaseFirst();
      await firstPublication.catch(() => undefined);
    }

    await firstPublication;
    expect(firstCommit).toHaveBeenCalledOnce();
    expect(loopbackManager.has("first-plugin")).toBe(true);
    expect(loopbackManager.has("second-plugin")).toBe(false);
    expect(registry.findByName("shared_method")).toBeUndefined();
    expect(registry.findByName("first_plugin_read")?.pluginId).toBe("first-plugin");
    await expect(runtime.callForPlugin("first-plugin", "shared_method")).resolves.toBe("first-plugin");
    await expect(runtime.callForPlugin("first-plugin", "first_plugin_read")).resolves.toBe("first-plugin");
  });

  it("releases lint-dropped method reservations when durable commit rejects", async () => {
    const { runtime, loopbackManager, lifecycle, candidate } = await fixture();
    const first = await candidate("first-plugin");
    const second = await candidate("second-plugin");
    const commitFailure = new Error("durable commit refused");

    await expect(lifecycle.replaceRuntimeWithCommit(first.projection, first.receiptRaw, async () => {
      throw commitFailure;
    })).rejects.toBe(commitFailure);
    const secondCommit = vi.fn(async () => undefined);
    await lifecycle.replaceRuntimeWithCommit(second.projection, second.receiptRaw, secondCommit);

    expect(secondCommit).toHaveBeenCalledOnce();
    expect(loopbackManager.has("first-plugin")).toBe(false);
    await expect(runtime.callForPlugin("second-plugin", "shared_method")).resolves.toBe("second-plugin");
  });
});
