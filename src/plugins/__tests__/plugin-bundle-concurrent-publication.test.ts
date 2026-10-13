import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../__tests__/support/plugin-child-entry.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { PersonaPromptStore } from "../../main/persona-prompt-store.js";
import { SkillStore } from "../../main/skill-store.js";
import { PluginLoopbackManager } from "../../mcp/plugin-loopback-manager.js";
import { PluginMcpHost } from "../../mcp/plugin-mcp-host.js";
import { ToolRegistry } from "../../tools/registry.js";
import { CommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import { ArtifactRollbackError } from "../plugin-artifact-store.js";
import { PluginBundleLifecycle } from "../plugin-bundle-lifecycle.js";
import type { PluginRuntimeGenerationProjection } from "../plugin-host-generation.js";
import { hashReceiptFiles } from "../plugin-install-receipt.js";
import { PluginRuntime } from "../runtime.js";
import { createNoopHostApiForTests } from "../runtime/sandbox.js";
import type { PluginManifest } from "../types.js";
import { agentPluginsDocument, makeTestTreeWritable } from "./test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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

  async function candidate(pluginId: string, options: { version?: string; hooksEnabled?: boolean } = {}) {
    const pluginRoot = join(root, pluginId);
    await mkdir(pluginRoot, { recursive: true });
    const manifest: PluginManifest = {
      id: pluginId,
      name: pluginId,
      description: "Method reservation fixture",
      version: options.version ?? "1.0.0",
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
    const payloadFiles = ["plugin.json"];
    if (options.hooksEnabled) {
      manifest.hooks = [{ id: "policy", path: "hooks/policy.json" }];
      await mkdir(join(pluginRoot, "hooks"), { recursive: true });
      await writeFile(join(pluginRoot, "hooks/policy.mjs"), "process.stdout.write(JSON.stringify({ action: 'allow' }));", "utf8");
      await writeFile(join(pluginRoot, "hooks/policy.json"), JSON.stringify({ hooks: { PreToolUse: [{
        matcher: "*", hooks: [{ type: "command", command: ["node", "./hooks/policy.mjs"] }],
      }] } }), "utf8");
      payloadFiles.push("hooks/policy.json", "hooks/policy.mjs");
    }
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
    const receiptRaw = JSON.stringify({
      schemaVersion: 2,
      pluginId,
      version: manifest.version,
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginRoot, payloadFiles),
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

  it("refuses a method published by another plugin while discovery is pending before durable commit", async () => {
    const { runtime, registry, lifecycle, candidate } = await fixture();
    const first = await candidate("first-plugin");
    const second = await candidate("second-plugin");
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const commitBarrier = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstPrepared = new Promise<void>((resolve) => { enteredFirst = resolve; });
    const firstPublication = lifecycle.replaceRuntimeWithCommit(first.projection, first.receiptRaw, async () => {
      enteredFirst();
      await commitBarrier;
    });
    await Promise.race([firstPrepared, firstPublication]);

    let releaseDiscovery!: () => void;
    let enteredDiscovery!: () => void;
    const discoveryBarrier = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const discoveryEntered = new Promise<void>((resolve) => { enteredDiscovery = resolve; });
    const createHost = PluginMcpHost.loopback.bind(PluginMcpHost);
    let secondHost: PluginMcpHost | undefined;
    vi.spyOn(PluginMcpHost, "loopback").mockImplementation((...args) => {
      const host = createHost(...args);
      if (args[0].id === "second-plugin") {
        const prepareTools = host.prepareTools.bind(host);
        vi.spyOn(host, "prepareTools").mockImplementation(async () => {
          enteredDiscovery();
          await discoveryBarrier;
          return prepareTools();
        });
        secondHost = host;
        vi.spyOn(host, "dispose");
      }
      return host;
    });
    const secondCommit = vi.fn(async () => undefined);
    const secondPublication = lifecycle.replaceRuntimeWithCommit(second.projection, second.receiptRaw, secondCommit);
    const secondOutcome = secondPublication.catch((error: unknown) => error);

    try {
      await Promise.race([discoveryEntered, secondPublication]);
      expect(lifecycle.getActive("first-plugin")).toBeUndefined();
      expect(runtime.getMethodMap().has("shared_method")).toBe(false);
      releaseFirst();
      await firstPublication;
      expect(registry.findByName("shared_method")).toBeUndefined();
      await expect(runtime.callForPlugin("first-plugin", "shared_method")).resolves.toBe("first-plugin");

      releaseDiscovery();
      const failure = await secondOutcome;
      expect(secondCommit).not.toHaveBeenCalled();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("Duplicate plugin method registered: shared_method");
      expect(lifecycle.getActive("second-plugin")).toBeUndefined();
      expect(secondHost?.dispose).toHaveBeenCalledOnce();
      const retry = registry.reservePluginReplacement("second-plugin", [], [], ["shared_method"]);
      retry.cancel();
      await expect(runtime.callForPlugin("first-plugin", "shared_method")).resolves.toBe("first-plugin");
    } finally {
      releaseFirst();
      releaseDiscovery();
      await Promise.allSettled([firstPublication, secondPublication]);
    }
  });

  describe.each(["preparation", "commit"] as const)("%s cleanup", (phase) => {
    it.each([
      { label: "ordinary error", createPrimary: () => new Error("generation refused") },
      { label: "artifact rollback error", createPrimary: (backupDir: string) => new ArtifactRollbackError(
        "directory rollback unresolved", [new Error("durable commit refused"), new Error("directory rollback refused")], backupDir,
      ) },
      { label: "aggregate error", createPrimary: () => new AggregateError([new Error("generation refused")], "generation failures") },
      { label: "committed publication error", createPrimary: () => new CommittedPluginGenerationPublicationError(
        "first-plugin", "a".repeat(64), new Error("publication withheld"), {
          retired: Promise.resolve(), markDispatchReady: async () => undefined, markDispatchUnavailable: () => undefined,
        }, undefined, "withheld",
      ) },
      { label: "non-error rejection", createPrimary: () => "generation refused" },
    ])("preserves $label and releases reservations when carried Hook revocation fails", async ({ createPrimary }) => {
      const { cacheRoot, runtime, loopbackManager, lifecycle, candidate } = await fixture();
      const first = await candidate("first-plugin", { hooksEnabled: true });
      await lifecycle.replaceRuntimeWithCommit(first.projection, first.receiptRaw, async () => undefined);
      const source = lifecycle.listContributionTrust("first-plugin").find((row) => row.kind === "hook" && row.localId === "policy");
      if (!source) throw new Error("Missing Hook contribution");
      expect(source.approvalDigest).toMatch(/^[a-f0-9]{64}$/u);
      await lifecycle.approveHook("first-plugin", "policy", {
        generationId: source.generationId, approvalDigest: source.approvalDigest,
      });
      const active = lifecycle.getActive("first-plugin");
      const update = await candidate("first-plugin", { version: "1.1.0", hooksEnabled: true });
      const trustDir = join(cacheRoot, "plugin-contribution-trust");
      const savedTrustDir = join(cacheRoot, "saved-contribution-trust");
      const primary = createPrimary(join(cacheRoot, "rollback-backup"));
      const approve = vi.spyOn(lifecycle.hookTrust, "approve");
      const revoke = vi.spyOn(lifecycle.hookTrust, "revoke");
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      let trustMoved = false;
      let failure: unknown;

      const blockTrustStorage = async () => {
        const carried = approve.mock.calls.at(-1)?.[0];
        if (!carried) throw new Error("Missing carried Hook approval");
        expect(lifecycle.hookTrust.record(carried)).toMatchObject({ carriedFrom: source.generationId });
        await rename(trustDir, savedTrustDir);
        trustMoved = true;
        await writeFile(trustDir, "Trust storage unavailable", "utf8");
      };
      if (phase === "preparation") {
        const prepareGeneration = loopbackManager.prepareGeneration.bind(loopbackManager);
        vi.spyOn(loopbackManager, "prepareGeneration").mockImplementationOnce(async (...args) => {
          const prepared = await prepareGeneration(...args);
          await blockTrustStorage();
          return prepared;
        });
        vi.spyOn(runtime, "prepareRuntimeGeneration").mockImplementationOnce(() => { throw primary; });
      }
      const durableCommit = vi.fn(async () => {
        await blockTrustStorage();
        throw primary;
      });

      try {
        failure = await lifecycle.replaceRuntimeWithCommit(update.projection, update.receiptRaw, durableCommit)
          .catch((error: unknown) => error);
      } finally {
        if (trustMoved) {
          await rm(trustDir, { force: true });
          await rename(savedTrustDir, trustDir);
        }
      }

      expect(durableCommit).toHaveBeenCalledTimes(phase === "commit" ? 1 : 0);
      expect(revoke).toHaveBeenCalledOnce();
      expect(lifecycle.getActive("first-plugin")).toEqual(active);
      await expect(runtime.callForPlugin("first-plugin", "shared_method")).resolves.toBe("first-plugin");
      const retryCommit = vi.fn(async () => undefined);
      await lifecycle.replaceRuntimeWithCommit(update.projection, update.receiptRaw, retryCommit);
      expect(retryCommit).toHaveBeenCalledOnce();
      expect(failure).toBe(primary);
      expect(failure instanceof ArtifactRollbackError).toBe(primary instanceof ArtifactRollbackError);
      const cleanupLogs = errorLog.mock.calls.map((args) => args.join(" "))
        .filter((message) => message.includes("[plugin-bundle-lifecycle]") && message.includes("cleanup failed"));
      expect(cleanupLogs).toHaveLength(1);
      expect(cleanupLogs[0]).toContain("EEXIST");
      expect(runtime.getPluginManifest("first-plugin")?.version).toBe("1.1.0");
    });
  });
});
