import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { SkillStore } from "../../main/skill-store.js";
import { PersonaPromptStore } from "../../main/persona-prompt-store.js";
import type { PluginManifest } from "../types.js";
import {
  PluginBundleLifecycle,
  type PluginBundleLifecycleDeps,
} from "../plugin-bundle-lifecycle.js";
import { hashReceiptFiles } from "../plugin-install-receipt.js";
import type { PluginRuntimeGenerationProjection } from "../plugin-host-generation.js";
import { CommittedPluginGenerationPublicationError } from "../committed-generation-publication-error.js";
import { PluginMcpTrustStore } from "../../mcp/plugin-mcp-projection.js";
import { ContributionTrustReviewStaleError } from "../plugin-contribution-trust.js";
import { makeTestTreeWritable } from "./test-helpers.js";
import { agentPluginsDocument } from "./test-helpers.js";

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
  deps: Omit<PluginBundleLifecycleDeps, "loopbackManager" | "revokeOperationGeneration" | "personaPromptStore" | "onContributionsUpdated"> &
    Partial<Pick<PluginBundleLifecycleDeps, "loopbackManager" | "revokeOperationGeneration" | "personaPromptStore" | "onContributionsUpdated">>,
): PluginBundleLifecycle {
  return new PluginBundleLifecycle({
    loopbackManager: inertLoopbackManager() as never,
    revokeOperationGeneration: vi.fn(),
    personaPromptStore: new PersonaPromptStore({ userDir: join(deps.receiptCacheRoot, "prompts") }),
    onContributionsUpdated: vi.fn(),
    ...deps,
  });
}

async function fixture(hookContent = JSON.stringify({ hooks: { PreToolUse: [] } }), withContent = false) {
  const root = mkdtempSync(join(tmpdir(), "ave-bundle-life-"));
  roots.push(root);
  const pluginRoot = join(root, "plugin");
  const cacheRoot = join(root, "cache");
  await mkdir(join(pluginRoot, "skills", "checkin"), { recursive: true });
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(join(pluginRoot, "mcp"), { recursive: true });
  const manifest = {
    id: "sampleportal",
    name: "Sample Portal API",
    version: "1.0.0",
    entry: "dist/index.js",
    tools: [],
    skills: [{ id: "checkin", path: "skills/checkin" }],
    hooks: [{ id: "policy", path: "hooks/policy.json" }],
    mcpServers: [{ id: "portal", path: "mcp/portal.json" }],
  } as unknown as PluginManifest;
  if (withContent) {
    manifest.prompts = [
      { id: "draft", path: "prompts/draft.md" },
      { id: "review", path: "prompts/review.md" },
    ];
    manifest.routineTemplates = [{ id: "daily", path: "routines/templates.json" }];
    await mkdir(join(pluginRoot, "prompts"), { recursive: true });
    await mkdir(join(pluginRoot, "routines"), { recursive: true });
    await writeFile(join(pluginRoot, "prompts", "draft.md"), "---\nname: draft\ndescription: Draft a report\nkind: template\n---\nDraft {args}\n", "utf8");
    await writeFile(join(pluginRoot, "prompts", "review.md"), "---\nname: review\ndescription: Review a report\nkind: persona\n---\nReview carefully.\n", "utf8");
    await writeFile(join(pluginRoot, "routines", "templates.json"), JSON.stringify({ version: 1, templates: [{
      id: "daily", title: "Daily review", description: "Review reports", trigger: "schedule",
      schedule: { repeat: { kind: "cron", expression: "0 9 * * *" } }, execution: "llm-session", prePrompt: "Review the report",
    }] }), "utf8");
  }
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
  await writeFile(join(pluginRoot, "skills", "checkin", "SKILL.md"), "---\nname: checkin\ndescription: Checkin workflow\n---\nUse the portal checkin API.", "utf8");
  await writeFile(join(pluginRoot, "hooks", "policy.json"), hookContent, "utf8");
  await writeFile(join(pluginRoot, "mcp", "portal.json"), JSON.stringify({ transport: "http", url: "https://portal.example.test/mcp" }), "utf8");
  await mkdir(join(cacheRoot, "sampleportal"), { recursive: true });
  const payloadFiles = [
    "plugin.json",
    "skills/checkin/SKILL.md",
    "hooks/policy.json",
    "mcp/portal.json",
  ];
  if (withContent) payloadFiles.push("prompts/draft.md", "prompts/review.md", "routines/templates.json");
  const files = await hashReceiptFiles(pluginRoot, payloadFiles);
  await writeFile(join(cacheRoot, "sampleportal", "install-receipt.json"), JSON.stringify({
    schemaVersion: 2,
    pluginId: "sampleportal",
    version: "1.0.0",
    installSource: "local-dev",
    artifactSha256: null,
    signerKeyId: null,
    installedAt: new Date(0).toISOString(),
    files,
  }), "utf8");
  return { root, pluginRoot, cacheRoot, manifest };
}

/** The review binding a user approval sends: the row the user saw (design §18.7.5). */
function reviewed(lifecycle: PluginBundleLifecycle, kind: "hook" | "mcpServer", localId: string) {
  const row = lifecycle.listContributionTrust("sampleportal").find((item) => item.kind === kind && item.localId === localId);
  if (!row) throw new Error(`no ${kind} ${localId} row`);
  return { generationId: row.generationId, approvalDigest: row.approvalDigest };
}

function runtimeProjection(manifest: PluginManifest, pluginRoot: string) {
  return {
    activationId: "test-activation",
    installId: manifest.id,
    manifest,
    pluginRoot,
    instance: { handlers: {} },
    methods: new Map(),
    // A generation the routing function produced, spawned with the sandbox off.
    arm: "child" as const,
    confinement: "unconfined" as const,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("PluginBundleLifecycle", () => {
  it("publishes extension prompts and routine templates only while their generation is active", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture(undefined, true);
    const personaPromptStore = new PersonaPromptStore({ userDir: join(root, "local-prompts") });
    const onContributionsUpdated = vi.fn();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "local-skills") }),
      personaPromptStore,
      onContributionsUpdated,
      hookManager: new ScriptHookManager(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async () => ({ records: [], predecessorServerIds: [], predecessorToolNames: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] }, published: false })),
        publishBundledGeneration: vi.fn(),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });
    await lifecycle.activate(manifest.id);
    expect(personaPromptStore.listTemplates()).toMatchObject([{ id: "extension:sampleportal:draft", body: "Draft {args}" }]);
    expect(await personaPromptStore.get("extension:sampleportal:review")).toMatchObject({
      systemPromptAdd: "Review carefully.", origin: { kind: "plugin", package: "sampleportal" },
    });
    expect(lifecycle.listRoutineTemplates()).toMatchObject([{ id: "daily", packageName: "sampleportal", sourceKind: "extension" }]);
    await lifecycle.deactivate(manifest.id);
    expect(personaPromptStore.listTemplates()).toEqual([]);
    expect(await personaPromptStore.get("extension:sampleportal:review")).toBeNull();
    expect(lifecycle.listRoutineTemplates()).toEqual([]);
    expect(onContributionsUpdated).toHaveBeenCalledTimes(2);
  });
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
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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

    const inactiveCommit = await lifecycle.deactivateWithCommit("sampleportal", durableCommit);
    expect(inactiveCommit).toMatchObject({
      result: "committed",
    });
    await expect(inactiveCommit.retirement).resolves.toBeUndefined();
    expect(prepareRuntimeRemoval).not.toHaveBeenCalled();
    expect(loopbackManager.prepareRemoval).not.toHaveBeenCalled();

    getRuntimeGenerationProjection.mockReturnValue(runtimeProjection(manifest, pluginRoot));
    await expect(lifecycle.deactivateWithCommit("sampleportal", durableCommit)).rejects.toThrow(
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
    const prepareRuntimeGeneration = vi.fn(() => ({
      pluginId: manifest.id,
      handOver: vi.fn(),
      publish: vi.fn(),
    }));
    const prepareRuntimeRemoval = vi.fn(() => ({
      pluginId: manifest.id,
      publish: vi.fn(),
    }));
    let activationId = "test-activation-1";
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
        }),
        prepareRuntimeGeneration,
        prepareRuntimeRemoval,
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

    await lifecycle.activate("sampleportal");
    const initialGenerationId = lifecycle.getActive("sampleportal")?.generationId;
    expect(prepareRuntimeGeneration).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      undefined,
    );
    expect(skillStore.listCatalogSync()).toEqual([expect.objectContaining({ name: "plugin:sampleportal:checkin" })]);
    expect(hookManager.size()).toBe(0);
    expect(prepareBundledGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "sampleportal" }),
      expect.anything(),
      lifecycle.mcpTrust,
    );
    expect(publishBundledGeneration).toHaveBeenCalledTimes(1);

    activationId = "test-activation-2";
    await lifecycle.activate("sampleportal");
    expect(prepareRuntimeGeneration).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      initialGenerationId,
    );
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(2);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(2);

    await lifecycle.approveHook("sampleportal", "policy", reviewed(lifecycle, "hook", "policy"));
    expect(hookManager.size()).toBe(0); // descriptor intentionally contains no runnable entries
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(3);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(3);

    const active = lifecycle.getActive("sampleportal");
    expect(active).not.toHaveProperty("state");
    expect(active?.manifest).not.toBe(manifest);
    expect(Object.isFrozen(active)).toBe(true);
    expect(Object.isFrozen(active?.manifest)).toBe(true);
    expect(Object.isFrozen(active?.manifest.tools)).toBe(true);
    const generationId = active?.generationId;
    expect(generationId).toMatch(/^[a-f0-9]{64}$/);
    await lifecycle.deactivate("sampleportal");
    await lifecycle.waitForRetirements();
    expect(prepareRuntimeRemoval).toHaveBeenCalledWith(
      "sampleportal",
      generationId,
    );
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(3);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(3);
    expect(skillStore.listCatalogSync()).toEqual([]);
    expect(disconnectBundledGeneration).toHaveBeenCalledWith("sampleportal", generationId);
  });

  it("retires the predecessor before replacement post-publish startup", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const events: string[] = [];
    let activationId = "test-activation-1";
    let releaseRetirement!: () => void;
    let reportRetirementStarted!: () => void;
    const retirementGate = new Promise<void>((resolve) => {
      releaseRetirement = resolve;
    });
    const retirementStarted = new Promise<void>((resolve) => {
      reportRetirementStarted = resolve;
    });
    const postPublishRuntimeGeneration = vi.fn(async (
      runtime: PluginRuntimeGenerationProjection,
    ) => {
      events.push(`published:${runtime.activationId}`);
    });
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
        }),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration,
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn((
          runtime: PluginRuntimeGenerationProjection,
        ) => [{
          phase: "runtime.stop" as const,
          run: async () => {
            events.push(`retiring:${runtime.activationId}`);
            reportRetirementStarted();
            await retirementGate;
            events.push(`retired:${runtime.activationId}`);
          },
        }]),
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
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate("sampleportal");
    expect(events).toEqual(["published:test-activation-1"]);

    activationId = "test-activation-2";
    const replacement = lifecycle.activate("sampleportal");
    await retirementStarted;
    expect(events).toEqual([
      "published:test-activation-1",
      "retiring:test-activation-1",
    ]);
    expect(postPublishRuntimeGeneration).toHaveBeenCalledTimes(1);

    releaseRetirement();
    await replacement;
    expect(events).toEqual([
      "published:test-activation-1",
      "retiring:test-activation-1",
      "retired:test-activation-1",
      "published:test-activation-2",
    ]);
  });

  it("returns from a self-admitted replacement so its predecessor lease can drain", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    let activationId = "test-activation-1";
    const events: string[] = [];
    let lifecycle!: PluginBundleLifecycle;
    const postPublishRuntimeGeneration = vi.fn(async (
      runtime: PluginRuntimeGenerationProjection,
    ) => {
      events.push(`published:${runtime.activationId}`);
      if (runtime.activationId === "test-activation-2") {
        const generationId = lifecycle.getActive(manifest.id)?.generationId;
        if (!generationId) throw new Error("candidate generation is not active");
        const nested = await lifecycle.acquireExact(manifest.id, generationId);
        nested.release();
      }
    });
    lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
        }),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration,
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn((runtime: PluginRuntimeGenerationProjection) => [{
          phase: "runtime.stop" as const,
          run: async () => {
            events.push(`retired:${runtime.activationId}`);
          },
        }]),
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
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate("sampleportal");
    const predecessorId = lifecycle.getActive("sampleportal")!.generationId;
    const predecessorLease = await lifecycle.acquireExact("sampleportal", predecessorId);
    let reportReplacementReturned!: () => void;
    const replacementReturned = new Promise<void>((resolve) => {
      reportReplacementReturned = resolve;
    });
    let releasePredecessorOperation!: () => void;
    const predecessorOperationGate = new Promise<void>((resolve) => {
      releasePredecessorOperation = resolve;
    });
    try {
      const predecessorOperation = lifecycle.runWithLease(predecessorLease, async () => {
        activationId = "test-activation-2";
        await lifecycle.activate("sampleportal");
        await expect(lifecycle.activate("sampleportal")).rejects.toThrow(
          /cannot start another lifecycle mutation/,
        );
        reportReplacementReturned();
        await predecessorOperationGate;
      });
      await replacementReturned;
      let disableReturned = false;
      const disable = lifecycle.deactivate("sampleportal").then(() => {
        disableReturned = true;
      });
      const candidateLease = lifecycle.acquire("sampleportal");
      let admitted = false;
      void candidateLease.then(() => { admitted = true; });
      await Promise.resolve();
      expect(admitted).toBe(false);
      expect(disableReturned).toBe(false);
      releasePredecessorOperation();
      await predecessorOperation;
      predecessorLease.release();
      const admittedCandidate = await candidateLease;
      expect(admittedCandidate.generation.generationId).not.toBe(predecessorId);
      admittedCandidate.release();
      await disable;
      await lifecycle.waitForRetirements();
    } finally {
      predecessorLease.release();
    }
    expect(postPublishRuntimeGeneration).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "published:test-activation-1",
      "retired:test-activation-1",
      "published:test-activation-2",
      "retired:test-activation-2",
    ]);
  });

  it("keeps the lifecycle tail closed after a self-admitted committed publication failure", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    let activationId = "test-activation-1";
    const publicationCause = new Error("candidate projection publish failed");
    const retirementCause = new Error("predecessor retirement failed");
    let predecessorRetirementAttempts = 0;
    const prepareRuntimeRemoval = vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() }));
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
        }),
        prepareRuntimeGeneration: vi.fn((runtime: PluginRuntimeGenerationProjection) => ({
          pluginId: manifest.id,
          handOver: vi.fn(),
          publish: () => {
            if (runtime.activationId === "test-activation-2") throw publicationCause;
          },
        })),
        prepareRuntimeRemoval,
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn((runtime: PluginRuntimeGenerationProjection) =>
          runtime.activationId === "test-activation-1"
            ? [{
                phase: "runtime.stop" as const,
                run: async () => {
                  predecessorRetirementAttempts += 1;
                  throw retirementCause;
                },
              }]
            : []),
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
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate(manifest.id);
    const predecessorId = lifecycle.getActive(manifest.id)!.generationId;
    const predecessorLease = await lifecycle.acquireExact(manifest.id, predecessorId);
    let reportFailureReturned!: (error: unknown) => void;
    const failureReturned = new Promise<unknown>((resolve) => { reportFailureReturned = resolve; });
    let releasePredecessorOperation!: () => void;
    const predecessorOperationGate = new Promise<void>((resolve) => {
      releasePredecessorOperation = resolve;
    });
    const predecessorOperation = lifecycle.runWithLease(predecessorLease, async () => {
      activationId = "test-activation-2";
      const failure = await lifecycle.activate(manifest.id).catch((error: unknown) => error);
      reportFailureReturned(failure);
      await predecessorOperationGate;
    });
    const failure = await failureReturned;
    expect(failure).toBeInstanceOf(CommittedPluginGenerationPublicationError);
    expect(failure).toMatchObject({
      publicationCause,
      outcome: { state: "active" },
      committed: { retirementDeferred: true },
    });

    let secondMutationSettled = false;
    const secondMutation = lifecycle.deactivate(manifest.id).finally(() => {
      secondMutationSettled = true;
    });
    await Promise.resolve();
    expect(secondMutationSettled).toBe(false);
    expect(prepareRuntimeRemoval).not.toHaveBeenCalled();

    releasePredecessorOperation();
    await predecessorOperation;
    predecessorLease.release();
    await expect(
      (failure as CommittedPluginGenerationPublicationError).committed?.completion,
    ).rejects.toMatchObject({ errors: [retirementCause] });
    await secondMutation;
    expect(predecessorRetirementAttempts).toBe(3);
    expect(prepareRuntimeRemoval).toHaveBeenCalledOnce();
    await lifecycle.waitForRetirements();
  });

  it("keeps the lifecycle tail closed until every deferred completion settles", async () => {
    const lifecycle = new PluginBundleLifecycle({
      receiptCacheRoot: join(tmpdir(), "ave-deferred-completion-test"),
      loopbackManager: { prepareGeneration: vi.fn() },
      revokeOperationGeneration: vi.fn(),
      personaPromptStore: new PersonaPromptStore({ userDir: join(tmpdir(), "ave-deferred-completion-test", "prompts") }),
      onContributionsUpdated: vi.fn(),
    } as never);
    type SyntheticCommit = {
      result: undefined;
      retirement: Promise<void>;
      completion: Promise<void>;
      retirementDeferred: true;
    };
    const serializeCommitted = (
      lifecycle as unknown as {
        serializeCommitted(
          pluginId: string,
          operation: () => Promise<SyntheticCommit>,
        ): Promise<SyntheticCommit>;
      }
    ).serializeCommitted.bind(lifecycle);
    let rejectFirstCompletion!: (error: Error) => void;
    const firstCompletion = new Promise<void>((_resolve, reject) => {
      rejectFirstCompletion = reject;
    });
    let resolveSecondCompletion!: () => void;
    const secondCompletion = new Promise<void>((resolve) => {
      resolveSecondCompletion = resolve;
    });
    const committed = (completion: Promise<void>): SyntheticCommit => Object.freeze({
      result: undefined,
      retirement: completion,
      completion,
      retirementDeferred: true,
    });

    await lifecycle.runInLifecycleQueue("sampleportal", async () => {
      await serializeCommitted("sampleportal", async () => committed(firstCompletion));
      await serializeCommitted("sampleportal", async () => committed(secondCompletion));
    });
    let nextMutationStarted = false;
    const nextMutation = lifecycle.runInLifecycleQueue("sampleportal", async () => {
      nextMutationStarted = true;
    });

    rejectFirstCompletion(new Error("first completion failed"));
    await Promise.resolve();
    expect(nextMutationStarted).toBe(false);

    resolveSecondCompletion();
    await nextMutation;
    expect(nextMutationStarted).toBe(true);
  });

  it("reports a committed inactive outcome when removal projection publication fails", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const publicationCause = new Error("removal projection publish failed");
    const discardGeneration = vi.fn(async () => undefined);
    const durableCommit = vi.fn(async () => "removed");
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({
          pluginId: manifest.id,
          publish: () => { throw publicationCause; },
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
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
      loopbackManager: {
        ...inertLoopbackManager(),
        prepareRemoval: vi.fn((pluginId: string, generationId: string) => ({
          pluginId,
          generationId,
          tools: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] },
          published: false,
          disconnectPredecessor: false,
        })),
        discardGeneration,
      } as never,
    });

    await lifecycle.activate(manifest.id);
    const failure = await lifecycle.deactivateWithCommit(
      manifest.id,
      durableCommit,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CommittedPluginGenerationPublicationError);
    expect(failure).toMatchObject({
      generationId: undefined,
      publicationCause,
      outcome: { state: "inactive" },
      committed: { result: "removed", retirementDeferred: false },
    });
    expect((failure as Error).cause).toBe(publicationCause);
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(discardGeneration).not.toHaveBeenCalled();
    expect(lifecycle.getActive(manifest.id)).toBeUndefined();
    await expect(lifecycle.acquire(manifest.id)).rejects.toThrow(/no active generation/);
    await expect(lifecycle.deactivate(manifest.id)).rejects.toThrow(
      /live projections without an active bundle generation/,
    );
    await lifecycle.waitForRetirements();
  });

  it("keeps replacement dispatch closed after predecessor retirement retries exhaust", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    let activationId = "test-activation-1";
    let retirementAttempts = 0;
    const postPublishRuntimeGeneration = vi.fn();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
        }),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration,
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => [{
          phase: "runtime.stop" as const,
          run: async () => {
            retirementAttempts += 1;
            throw new Error("predecessor stop failed");
          },
        }]),
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
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate("sampleportal");
    activationId = "test-activation-2";
    await lifecycle.activate("sampleportal");

    expect(retirementAttempts).toBe(3);
    expect(postPublishRuntimeGeneration).toHaveBeenCalledTimes(1);
    expect(lifecycle.getActive("sampleportal")?.generationId).toMatch(/^[a-f0-9]{64}$/);
    await expect(lifecycle.acquire("sampleportal")).rejects.toThrow(/dispatch blocked/);
  });

  it("keeps replacement dispatch closed when runtime post-publish readiness fails", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    let activationId = "test-activation-1";
    const postPublishRuntimeGeneration = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("candidate runtime readiness failed"));
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
        }),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration,
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
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await lifecycle.activate("sampleportal");
    activationId = "test-activation-2";
    await lifecycle.activate("sampleportal");

    expect(postPublishRuntimeGeneration).toHaveBeenCalledTimes(2);
    await expect(lifecycle.acquire("sampleportal")).rejects.toThrow(/dispatch blocked/);
    await expect(lifecycle.deactivate("sampleportal")).resolves.toBeUndefined();
    await expect(lifecycle.waitForRetirements()).resolves.toBeUndefined();
  });

  it("keeps an initial generation unavailable when runtime post-publish readiness fails", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => pluginRoot,
        getRuntimeGenerationProjection: () => runtimeProjection(manifest, pluginRoot),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(async () => {
          throw new Error("initial runtime readiness failed");
        }),
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
        })),
        publishBundledGeneration: vi.fn((prepared) => { prepared.published = true; }),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });

    await expect(lifecycle.activate("sampleportal")).resolves.toBeUndefined();
    await expect(lifecycle.acquire("sampleportal")).rejects.toThrow(/dispatch blocked/);
  });

  it("restores MCP approval after a same-artifact reinstall refreshes installedAt", async () => {
    const { root, pluginRoot, cacheRoot, manifest } = await fixture();
    let activationId = "test-activation-v1";
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
        getRuntimeGenerationProjection: () => ({
          ...runtimeProjection(manifest, pluginRoot),
          activationId,
          installId: "sampleportal",
        }),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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

    await lifecycle.activate("sampleportal");
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    expect(lifecycle.listContributionTrust("sampleportal")).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", localId: "portal", status: "approved" }),
    );

    const receiptPath = join(cacheRoot, "sampleportal", "install-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.installedAt = "2026-07-27T00:05:00.000Z";
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    activationId = "test-activation-v1-reinstalled";

    await lifecycle.activate("sampleportal");
    expect(lifecycle.listContributionTrust("sampleportal")).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", localId: "portal", status: "approved" }),
    );
    expect(prepareBundledGeneration).toHaveBeenCalledTimes(3);
    expect(publishBundledGeneration).toHaveBeenCalledTimes(3);
    await lifecycle.waitForRetirements();
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
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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
    await lifecycle.activate("sampleportal");
    await lifecycle.waitForRetirements();
    retirePublishedMcpReplacement.mockRejectedValue(new Error("retirement endpoint token=secret"));

    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    await lifecycle.waitForRetirements();

    const trust = lifecycle.listContributionTrust("sampleportal")
      .find((row) => row.kind === "mcpServer" && row.localId === "portal");
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
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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

    await lifecycle.activate("sampleportal");
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    prepareBundledGeneration.mockRejectedValueOnce(new Error("candidate preparation failed"));

    await expect(lifecycle.revokeMcpServer("sampleportal", "portal")).rejects.toThrow(
      "candidate preparation failed",
    );
    expect(lifecycle.listContributionTrust("sampleportal")).toContainEqual(
      expect.objectContaining({ kind: "mcpServer", localId: "portal", status: "approved" }),
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
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: valid.manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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
    await lifecycle.activate("sampleportal");
    const active = lifecycle.getActive("sampleportal");
    const generationRoot = join(
      valid.cacheRoot,
      "sampleportal",
      "generations",
    );
    const generationsBefore = await readdir(generationRoot);

    await writeFile(join(valid.pluginRoot, "hooks", "policy.json"), "{", "utf8");
    const receiptPath = join(valid.cacheRoot, "sampleportal", "install-receipt.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.files.find((file: { path: string }) => file.path === "hooks/policy.json").sha256 = createHash("sha256").update("{").digest("hex");
    await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    await expect(lifecycle.activate("sampleportal")).rejects.toThrow(/not valid JSON/);
    expect(lifecycle.getActive("sampleportal")?.generationId).toBe(active?.generationId);
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
          handOver: vi.fn(),
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
      join(cacheRoot, "sampleportal", "install-receipt.json"),
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

    const generationRoot = join(cacheRoot, "sampleportal", "generations");
    const retained = await readdir(generationRoot).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    expect(retained).toEqual([]);
    expect(lifecycle.getActive("sampleportal")).toBeUndefined();
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
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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

    await lifecycle.activate("sampleportal");
    const committed = await lifecycle.deactivateWithCommit(
      "sampleportal",
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
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
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
    const receiptRaw = await readFile(join(cacheRoot, "sampleportal", "install-receipt.json"), "utf8");
    const durableCommit = vi.fn(async () => "committed");

    const committed = await lifecycle.replaceRuntimeWithCommit(
      runtimeProjection(manifest, pluginRoot),
      receiptRaw,
      durableCommit,
    );

    expect(committed.result).toBe("committed");
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(lifecycle.getActive("sampleportal")).toBeDefined();
    const health = JSON.parse(await readFile(join(cacheRoot, "plugin-generation-health.json"), "utf8"));
    expect(health.faults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: "sampleportal",
        phase: "runtime-post-publish",
        errorName: "Error",
        errorCode: null,
        message: "internal post-commit fault",
      }),
      expect.objectContaining({
        pluginId: "sampleportal",
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

describe("PluginBundleLifecycle approval carry-forward (design §18.7.3)", () => {
  /** A lifecycle over the fixture whose manifest, files and receipt `release` rewrites in place. */
  async function updatable(options: { mcpTrust?: PluginMcpTrustStore; loopbackManager?: ReturnType<typeof inertLoopbackManager> } = {}) {
    const base = await fixture();
    let manifest = base.manifest;
    let activationId = 0;
    const publishBundledGeneration = vi.fn((prepared) => { prepared.published = true; });
    const lifecycle = makeLifecycle({
      pluginRuntime: {
        getPluginManifest: () => manifest,
        getPluginRoot: () => base.pluginRoot,
        getRuntimeGenerationProjection: () => ({ ...runtimeProjection(manifest, base.pluginRoot), activationId: `activation-${++activationId}` }),
        prepareRuntimeGeneration: vi.fn(() => ({ pluginId: manifest.id, handOver: vi.fn(), publish: vi.fn() })),
        prepareRuntimeRemoval: vi.fn(() => ({ pluginId: manifest.id, publish: vi.fn() })),
        postPublishRuntimeGeneration: vi.fn(),
        publishRuntimeGeneration: vi.fn(),
        unpublishRuntimeGeneration: vi.fn(),
        prepareRuntimeRetirement: vi.fn(() => []),
      },
      receiptCacheRoot: base.cacheRoot,
      skillStore: new SkillStore({ userDir: join(base.root, "user-skills") }),
      hookManager: new ScriptHookManager(),
      ...(options.mcpTrust ? { mcpTrust: options.mcpTrust } : {}),
      ...(options.loopbackManager ? { loopbackManager: options.loopbackManager as never } : {}),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async ({ pluginId, generationId }) => ({
          pluginId, generationId, predecessorServerIds: [], predecessorToolNames: [], records: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] }, published: false,
        })),
        publishBundledGeneration,
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
    });
    /** Publish a new version with the given file contents changed, as an install would leave it. */
    const release = async (version: string, files: Record<string, string> = {}) => {
      manifest = { ...manifest, version } as PluginManifest;
      await writeFile(join(base.pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
      for (const [path, content] of Object.entries(files)) await writeFile(join(base.pluginRoot, path), content, "utf8");
      const receiptPath = join(base.cacheRoot, "sampleportal", "install-receipt.json");
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      receipt.version = version;
      receipt.files = await hashReceiptFiles(base.pluginRoot, receipt.files.map((file: { path: string }) => file.path));
      await writeFile(receiptPath, JSON.stringify(receipt), "utf8");
    };
    const row = (localId = "portal") => lifecycle.listContributionTrust("sampleportal").find((item) => item.kind === "mcpServer" && item.localId === localId)!;
    /** The trust-store view of a row's exact identity. */
    const owned = (item: ReturnType<typeof row>) => ({ owner: {
      pluginId: item.pluginId, pluginVersion: item.pluginVersion, generationId: item.generationId, localId: item.localId, fingerprint: item.fingerprint,
    } }) as never;
    return { ...base, lifecycle, release, row, owned };
  }

  it("carries an approval to a new version whose server and package bytes are unchanged, naming its source", async () => {
    const { lifecycle, release, row, owned } = await updatable();
    await lifecycle.activate("sampleportal");
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    const approved = row();
    expect(approved.approvalDigest).toMatch(/^[a-f0-9]{64}$/u);

    // Only the skill text changed: a remote server's approval digest is the same.
    await release("1.1.0", { "skills/checkin/SKILL.md": "---\nname: checkin\ndescription: Checkin workflow\n---\nUse the portal checkin API, carefully." });
    await lifecycle.activate("sampleportal");
    const carried = row();
    expect(carried.generationId).not.toBe(approved.generationId);
    expect(carried).toMatchObject({ pluginVersion: "1.1.0", status: "approved", approvalDigest: approved.approvalDigest });
    expect(lifecycle.mcpTrust.record(owned(carried))).toMatchObject({ carriedFrom: approved.generationId, approvalDigest: approved.approvalDigest });
    await lifecycle.waitForRetirements();
  });

  it("does not carry an approval to a server whose declaration changed", async () => {
    const { lifecycle, release, row } = await updatable();
    await lifecycle.activate("sampleportal");
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    await release("1.1.0", { "mcp/portal.json": JSON.stringify({ transport: "http", url: "https://elsewhere.example.test/mcp" }) });
    await lifecycle.activate("sampleportal");
    expect(row()).toMatchObject({ pluginVersion: "1.1.0", status: "approval_required" });
    await lifecycle.waitForRetirements();
  });

  it("abandons the update and revokes the carried approval when its source is revoked before publication", async () => {
    const loopbackManager = inertLoopbackManager();
    const { lifecycle, release, row, owned, cacheRoot } = await updatable({ loopbackManager });
    await lifecycle.activate("sampleportal");
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    const source = row();
    await release("1.1.0", { "skills/checkin/SKILL.md": "---\nname: checkin\ndescription: Checkin workflow\n---\nChanged." });
    // The user revokes the approval while the update is being prepared.
    let carriedTo: string | undefined;
    loopbackManager.prepareGeneration.mockImplementationOnce(async (manifest: PluginManifest, generationId: string) => {
      lifecycle.mcpTrust.revoke(owned(source));
      carriedTo = generationId;
      return { pluginId: manifest.id, generationId, tools: [], registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] }, published: false, disconnectPredecessor: false };
    });
    await expect(lifecycle.activate("sampleportal")).rejects.toThrow(/was withdrawn while its update was prepared/u);
    expect(carriedTo).toBeDefined();
    // The revocation is not undone, the old generation stays active, and nothing was carried.
    expect(row()).toMatchObject({ generationId: source.generationId, pluginVersion: "1.0.0", status: "approval_required" });
    const written = JSON.parse(await readFile(join(cacheRoot, "plugin-contribution-trust", "mcp-servers.json"), "utf8"));
    expect(written.approvals).toEqual([]);
    await lifecycle.waitForRetirements();
  });

  it("revokes a carried approval when preparation fails after the carry", async () => {
    const loopbackManager = inertLoopbackManager();
    const { lifecycle, release, row, cacheRoot } = await updatable({ loopbackManager });
    await lifecycle.activate("sampleportal");
    await lifecycle.approveMcpServer("sampleportal", "portal", reviewed(lifecycle, "mcpServer", "portal"));
    await release("1.1.0", { "skills/checkin/SKILL.md": "---\nname: checkin\ndescription: Checkin workflow\n---\nChanged." });
    loopbackManager.prepareGeneration.mockRejectedValueOnce(new Error("tool registry refused the candidate"));
    const approvedBefore = JSON.stringify(lifecycle.listContributionTrust("sampleportal"));
    await expect(lifecycle.activate("sampleportal")).rejects.toThrow();
    // The 1.0.0 approval is untouched, and no approval of the never-published 1.1.0 generation remains.
    expect(JSON.stringify(lifecycle.listContributionTrust("sampleportal"))).toBe(approvedBefore);
    expect(row()).toMatchObject({ pluginVersion: "1.0.0", status: "approved" });
    const raw = JSON.parse(await readFile(join(cacheRoot, "plugin-contribution-trust", "mcp-servers.json"), "utf8"));
    expect(raw.approvals.filter((item: { pluginVersion: string }) => item.pluginVersion === "1.1.0")).toEqual([]);
    await lifecycle.waitForRetirements();
  });

  it("migrates a version-2 approval to version 3 by the running bytes, then carries it", async () => {
    const trustRoot = mkdtempSync(join(tmpdir(), "ave-trust-v2-"));
    roots.push(trustRoot);
    const trustPath = join(trustRoot, "mcp-servers.json");
    const first = await updatable({ mcpTrust: new PluginMcpTrustStore(trustPath) });
    await first.lifecycle.activate("sampleportal");
    const identity = first.row();
    // A 0.12 approval of this exact generation: no approval digest.
    await writeFile(trustPath, JSON.stringify({ version: 2, kind: "mcpServer", approvals: [{
      pluginId: identity.pluginId, pluginVersion: identity.pluginVersion, generationId: identity.generationId,
      localId: identity.localId, fingerprint: identity.fingerprint,
    }] }), "utf8");
    await first.lifecycle.waitForRetirements();

    const migrated = new PluginMcpTrustStore(trustPath);
    const second = await updatable({ mcpTrust: migrated });
    await second.release("1.0.0");
    await second.lifecycle.activate("sampleportal");
    expect(second.row()).toMatchObject({ generationId: identity.generationId, status: "approved" });
    const written = JSON.parse(await readFile(trustPath, "utf8"));
    expect(written).toMatchObject({ version: 3, approvals: [expect.objectContaining({ generationId: identity.generationId, approvalDigest: identity.approvalDigest })] });

    await second.release("1.1.0", { "skills/checkin/SKILL.md": "---\nname: checkin\ndescription: Checkin workflow\n---\nChanged." });
    await second.lifecycle.activate("sampleportal");
    expect(second.row()).toMatchObject({ pluginVersion: "1.1.0", status: "approved" });
    await second.lifecycle.waitForRetirements();
  });

  it("refuses an approval whose review names a generation or digest that is no longer installed", async () => {
    const { lifecycle, release, row } = await updatable();
    await lifecycle.activate("sampleportal");
    const stale = reviewed(lifecycle, "mcpServer", "portal");
    await release("1.1.0", { "mcp/portal.json": JSON.stringify({ transport: "http", url: "https://elsewhere.example.test/mcp" }) });
    await lifecycle.activate("sampleportal");
    await expect(lifecycle.approveMcpServer("sampleportal", "portal", stale)).rejects.toBeInstanceOf(ContributionTrustReviewStaleError);
    await expect(lifecycle.approveMcpServer("sampleportal", "portal", { ...reviewed(lifecycle, "mcpServer", "portal"), approvalDigest: "0".repeat(64) }))
      .rejects.toBeInstanceOf(ContributionTrustReviewStaleError);
    await expect(lifecycle.approveMcpServer("sampleportal", "portal", undefined as never)).rejects.toThrow(/requires the reviewed generation/u);
    expect(row().status).toBe("approval_required");
    await lifecycle.waitForRetirements();
  });
});
