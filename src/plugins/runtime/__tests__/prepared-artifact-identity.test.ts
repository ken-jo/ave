import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestPluginRuntime,
  makeTestTreeWritable,
} from "../../__tests__/test-helpers.js";
import {
  buildInstallReceipt,
} from "../../plugin-install-receipt.js";
import {
  createNoopHostApiForTests,
  PluginRuntime,
  type PluginRuntimeOptions,
} from "../../runtime.js";
import type { EntryPluginManifest, PluginManifest } from "../../types.js";
import { canonicalJSON } from "../../secret-access/canonical-json.js";
import { agentPluginsDocument } from "../../__tests__/test-helpers.js";
import {
  HOST_PROTOCOL_CURRENT_VERSION,
  HOST_PROTOCOL_VERSIONS_SERVED,
  IncompatibleHostProtocolError,
} from "../../isolation/host-api-wire.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { PersonaPromptStore } from "../../../main/persona-prompt-store.js";
import { SkillStore } from "../../../main/skill-store.js";
import { PluginLoopbackManager } from "../../../mcp/plugin-loopback-manager.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ArtifactRollbackError } from "../../plugin-artifact-store.js";
import { PluginBundleLifecycle } from "../../plugin-bundle-lifecycle.js";

const removalFault = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: 0,
}));
vi.mock("../../plugin-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugin-contributions.js")>();
  return { ...actual, removeRetainedPluginGeneration: async (...args: Parameters<typeof actual.removeRetainedPluginGeneration>) => {
    if (removalFault.error) {
      removalFault.calls += 1;
      throw removalFault.error;
    }
    await actual.removeRetainedPluginGeneration(...args);
  } };
});

const roots: string[] = [];

afterEach(async () => {
  removalFault.error = undefined;
  removalFault.calls = 0;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(async (root) => {
    await makeTestTreeWritable(root);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("prepared activation cleanup error identity", () => {
  it.each(["routing", "host api", "durable commit"] as const)("preserves rollback metadata when %s and retained cleanup both fail", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-cleanup-"));
    roots.push(root);
    const pluginId = "cleanup-candidate";
    const cacheRoot = join(root, "cache");
    const prepared = await writePreparedPlugin(root, pluginId, pluginId);
    const primary = new ArtifactRollbackError("directory rollback unresolved", [new Error("durable commit refused")], join(root, "rollback-backup"));
    const secondary = new Error("retained generation removal refused");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runtime = new PluginRuntime({
      childEntryPath: pluginChildEntryPath(),
      encryption: unavailableSecretEncryption,
      hostRoot: root,
      pluginsRoot: join(root, "plugins"),
      registryPath: join(root, "plugins", "registry.json"),
      installReceiptCacheRoot: cacheRoot,
      createHostApi: (id, manifest, dataDir) => {
        if (phase === "host api") {
          removalFault.error = secondary;
          throw primary;
        }
        return createNoopHostApiForTests(id, manifest, dataDir);
      },
    });
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: runtime,
      receiptCacheRoot: cacheRoot,
      skillStore: new SkillStore({ userDir: join(root, "skills") }),
      personaPromptStore: new PersonaPromptStore({ userDir: join(root, "prompts") }),
      hookManager: new ScriptHookManager(),
      loopbackManager: new PluginLoopbackManager(runtime, new ToolRegistry(), () => undefined),
      mcpManager: {
        bundledServerIdsForPlugin: () => [],
        prepareBundledGeneration: async () => ({ published: false }),
        publishBundledGeneration: (candidate: { published: boolean }) => { candidate.published = true; },
        retirePublishedMcpReplacement: async () => undefined,
      } as never,
      revokeOperationGeneration: () => undefined,
      skillOverlay: { clearPluginGeneration: () => undefined },
      onContributionsUpdated: () => undefined,
    });
    runtime.setGenerationAccess(lifecycle);
    if (phase === "routing") {
      const routing = runtime as unknown as { importPluginFactoryForLifecycle(...args: unknown[]): Promise<unknown> };
      vi.spyOn(routing, "importPluginFactoryForLifecycle").mockImplementationOnce(async () => {
        removalFault.error = secondary;
        throw primary;
      });
    }
    const durableCommit = vi.fn(async () => {
      removalFault.error = secondary;
      throw primary;
    });
    try {
      const failure = await runtime.activatePreparedArtifact({ installId: pluginId, ...prepared, durableCommit })
        .catch((error: unknown) => error);
      removalFault.error = undefined;
      expect(failure).toBe(primary);
      expect(failure).toBeInstanceOf(ArtifactRollbackError);
      expect((failure as ArtifactRollbackError).backupDir).toBe(primary.backupDir);
      expect(removalFault.calls).toBe(phase === "durable commit" ? 2 : 1);
      expect(durableCommit).toHaveBeenCalledTimes(phase === "durable commit" ? 1 : 0);
      expect(lifecycle.getActive(pluginId)).toBeUndefined();
      expect(errorLog.mock.calls.map((args) => args.join(" ")).some((message) =>
        message.includes("[plugin-runtime]") && message.includes(secondary.message))).toBe(true);
    } finally {
      removalFault.error = undefined;
      await runtime.stopAll();
    }
  });
});

describe("restart cleanup error identity", () => {
  it.each(["entry", "routing", "factory", "start", "publication"] as const)("preserves the primary %s error when replacement cleanup fails", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "ave-restart-cleanup-"));
    roots.push(root);
    const pluginId = "restart-candidate";
    const pluginsRoot = join(root, "plugins");
    const registryPath = join(pluginsRoot, "registry.json");
    const cacheRoot = join(root, "cache");
    const prepared = await writePreparedPlugin(root, pluginId, pluginId, (toolName) => `export default async function createPlugin() {
      return { handlers: { ${toolName}: async () => "pong" }, start: async () => {} };
    }`);
    await mkdir(pluginsRoot, { recursive: true });
    const installDir = join(pluginsRoot, pluginId);
    await rename(prepared.pluginRoot, installDir);
    prepared.pluginRoot = installDir;
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{
      id: pluginId, manifestPath: `${pluginId}/plugin.json`, ...prepared.registryEntry,
    }] }), "utf8");
    const runtime = makeTestPluginRuntime({ rootDir: root, registryPath, pluginsRoot }, { installReceiptCacheRoot: cacheRoot });
    await runtime.activatePreparedArtifact({ installId: pluginId, ...prepared, durableCommit: async () => {
      await mkdir(join(cacheRoot, pluginId), { recursive: true });
      await writeFile(join(cacheRoot, pluginId, "install-receipt.json"), prepared.receiptRaw, "utf8");
    } });
    const primary = new ArtifactRollbackError("replacement refused", [new Error("primary refusal")], join(root, "rollback-backup"));
    const secondary = new Error("replacement root cleanup refused");
    const internals = runtime as unknown as {
      removeUnpublishedRuntimeRoot(...args: unknown[]): Promise<void>;
      pluginFactorySource(...args: unknown[]): unknown;
      importPluginFactoryForLifecycle(...args: unknown[]): Promise<unknown>;
      runPluginLifecycleHook(scope: unknown, hook: () => unknown): Promise<unknown>;
      generationLifecycle: { replaceRuntime(...args: unknown[]): Promise<void> };
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(internals, "removeUnpublishedRuntimeRoot").mockRejectedValueOnce(secondary);
    if (phase === "entry") {
      vi.spyOn(internals, "pluginFactorySource").mockImplementationOnce(() => { throw primary; });
    } else if (phase === "routing") {
      vi.spyOn(internals, "importPluginFactoryForLifecycle").mockRejectedValueOnce(primary);
    } else if (phase === "publication") {
      vi.spyOn(internals.generationLifecycle, "replaceRuntime").mockRejectedValueOnce(primary);
    } else {
      const hook = internals.runPluginLifecycleHook.bind(runtime);
      const spy = vi.spyOn(internals, "runPluginLifecycleHook");
      if (phase === "start") spy.mockImplementationOnce(hook);
      spy.mockRejectedValueOnce(primary);
    }
    try {
      await expect(runtime.restartPlugin(pluginId, { skipPreparation: true, throwOnFailure: true })).rejects.toBe(primary);
      await expect(runtime.call("restart_candidate_ping")).resolves.toBe("pong");
      expect(errorLog.mock.calls.map((args) => args.join(" ")).some((message) => message.includes(secondary.message))).toBe(true);
    } finally {
      await runtime.stopAll();
    }
  });
});

describe.each(["add", "boot"] as const)("%s cleanup failure reporting", (route) => {
  it.each(["entry", "routing"] as const)("keeps the reported %s failure when root cleanup fails", async (phase) => {
    const root = await mkdtemp(join(tmpdir(), "ave-add-cleanup-"));
    roots.push(root);
    const pluginId = "add-candidate";
    const pluginsRoot = join(root, "plugins");
    const registryPath = join(pluginsRoot, "registry.json");
    const cacheRoot = join(root, "cache");
    const prepared = await writePreparedPlugin(root, pluginId, pluginId);
    await mkdir(pluginsRoot, { recursive: true });
    await rename(prepared.pluginRoot, join(pluginsRoot, pluginId));
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{
      id: pluginId, manifestPath: `${pluginId}/plugin.json`, ...prepared.registryEntry,
    }] }), "utf8");
    await mkdir(join(cacheRoot, pluginId), { recursive: true });
    await writeFile(join(cacheRoot, pluginId, "install-receipt.json"), prepared.receiptRaw, "utf8");
    const runtime = makeTestPluginRuntime({ rootDir: root, registryPath, pluginsRoot }, { installReceiptCacheRoot: cacheRoot });
    const primary = new Error("candidate factory refused");
    const secondary = new Error("candidate root cleanup refused");
    const internals = runtime as unknown as {
      removeUnpublishedRuntimeRoot(...args: unknown[]): Promise<void>;
      pluginFactorySource(...args: unknown[]): unknown;
      importPluginFactoryForLifecycle(...args: unknown[]): Promise<unknown>;
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(internals, "removeUnpublishedRuntimeRoot").mockRejectedValueOnce(secondary);
    if (phase === "entry") {
      vi.spyOn(internals, "pluginFactorySource").mockImplementationOnce(() => { throw primary; });
    } else {
      vi.spyOn(internals, "importPluginFactoryForLifecycle").mockRejectedValueOnce(primary);
    }
    try {
      if (route === "add") {
        await expect(runtime.addPlugin(pluginId)).rejects.toThrow(`addPlugin failed for ${pluginId}`);
      } else {
        await runtime.startAll();
        const card = runtime.listPluginCards().find((candidate) => candidate.id === pluginId);
        expect(card?.loadStatus).toBe("failed");
        expect(card?.installFailureKind).not.toBe("load-crash");
      }
      const messages = errorLog.mock.calls.map((args) => args.join(" "));
      if (route === "boot") {
        expect(errorLog).toHaveBeenCalledWith(
          expect.stringContaining("[plugin-lifecycle]"),
          expect.objectContaining({ err: primary }),
        );
      } else {
        expect(messages.some((message) => message.includes(primary.message))).toBe(true);
      }
      expect(messages.some((message) => message.includes(secondary.message))).toBe(true);
    } finally {
      await runtime.stopAll();
    }
  });
});

async function writePreparedPlugin(
  root: string,
  manifestId: string,
  installId: string,
  entrySource?: (toolName: string) => string,
  manifestOverrides: Partial<EntryPluginManifest> = {},
): Promise<{
  pluginRoot: string;
  manifest: PluginManifest;
  receiptRaw: string;
  registryEntry: {
    installSource: "user";
    manifestSha256: string;
  };
}> {
  const pluginRoot = join(root, `staging-${manifestId}`);
  await mkdir(pluginRoot, { recursive: true });
  const toolName = `${manifestId.replaceAll("-", "_")}_ping`;
  const manifest: PluginManifest = {
    id: manifestId,
    name: manifestId,
    version: "1.0.0",
    entry: "entry.mjs",
    description: "Prepared identity fixture.",
    requires: { hostProtocol: HOST_PROTOCOL_CURRENT_VERSION },
    tools: [{
      name: toolName,
      description: "Return a ping reply.",
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    }],
    ...manifestOverrides,
  };
  // Omitted requires means no host protocol declaration.
  if (manifest.requires === undefined) delete manifest.requires;
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
  await writeFile(
    join(pluginRoot, "entry.mjs"),
    entrySource?.(toolName) ?? `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "pong" } };
}
`,
    "utf8",
  );
  const { receipt } = await buildInstallReceipt(pluginRoot, {
    pluginId: installId,
    version: manifest.version,
    installSource: "marketplace",
    artifactSha256: "a".repeat(64),
    signerKeyId: "test-v1",
    files: ["entry.mjs", "plugin.json"],
    installedAt: new Date(0).toISOString(),
  });
  return {
    pluginRoot,
    manifest,
    receiptRaw: JSON.stringify(receipt),
    registryEntry: {
      installSource: "user",
      manifestSha256: createHash("sha256")
        .update(canonicalJSON(agentPluginsDocument(manifest)))
        .digest("hex"),
    },
  };
}

describe("prepared artifact install identity", () => {
  it("prepares host-managed runtime config before starting a marketplace candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-python-runtime-"));
    roots.push(root);
    const pluginId = "python-candidate";
    const installId = "catalog-python-candidate";
    const pythonExecutable = join(root, "managed-python");
    const prepared = await writePreparedPlugin(
      root,
      pluginId,
      installId,
      (toolName) => `export default async function createPlugin(context) {
  if (context.config.pythonExecutable !== ${JSON.stringify(pythonExecutable)}) {
    throw new Error("python runtime was not prepared before candidate factory");
  }
  return { handlers: { ${toolName}: async () => "pong" } };
}
`,
      { python: { managedBy: "ave" } },
    );
    const preparePluginStart: NonNullable<PluginRuntimeOptions["preparePluginStart"]> =
      vi.fn(async ({ pluginId: preparedPluginId, manifestPath, pluginRoot }) => {
        expect(preparedPluginId).toBe(pluginId);
        expect(manifestPath).toBe(join(prepared.pluginRoot, "plugin.json"));
        expect(pluginRoot).toBe(prepared.pluginRoot);
        return { configOverride: { pythonExecutable } };
      });
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      {
        installReceiptCacheRoot: join(root, "cache"),
        preparePluginStart,
      },
    );
    runtime.setConfigOverride(pluginId, {
      pythonExecutable: join(root, "incumbent-python"),
      retained: "incumbent",
    });

    const activated = await runtime.activatePreparedArtifact({
      installId,
      ...prepared,
      durableCommit: async () => "committed",
    });
    await activated.retirement;

    expect(preparePluginStart).toHaveBeenCalledOnce();
    expect(runtime.getConfigOverride(pluginId)).toEqual({
      pythonExecutable,
      retained: "incumbent",
    });
    await expect(runtime.call("python_candidate_ping")).resolves.toBe("pong");
  });

  it("passes fresh provenance into production-shaped HostApi creation and publishes it after commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-identity-"));
    roots.push(root);
    const installId = "catalog-fresh";
    const canonicalId = "manifest-fresh";
    const prepared = await writePreparedPlugin(root, canonicalId, installId);
    const observedInstallIds: Array<string | null> = [];
    const observedRegistryEntries: unknown[] = [];
    const observedAccessGrants: unknown[] = [];
    const approvedPluginAccess = {
      plugins: [{
        pluginId: "sampleassistant",
        events: ["sampleassistant.snapshot.requested"],
      }],
    };
    const createHostApi: PluginRuntimeOptions["createHostApi"] = (
      pluginId,
      manifest,
      dataDir,
      _incarnation,
      candidateInstallId,
      candidateRegistryEntry,
      candidateApprovedPluginAccess,
    ) => {
      observedInstallIds.push(candidateInstallId);
      observedRegistryEntries.push(candidateRegistryEntry);
      observedAccessGrants.push(candidateApprovedPluginAccess);
      return createNoopHostApiForTests(pluginId, manifest, dataDir);
    };
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      {
        installReceiptCacheRoot: join(root, "cache"),
        createHostApi,
      },
    );
    const durableCommit = vi.fn(async () => "committed");

    const activated = await runtime.activatePreparedArtifact({
      installId,
      ...prepared,
      approvedPluginAccess,
      durableCommit,
    });
    await activated.retirement;

    expect(activated.result).toBe("committed");
    expect(durableCommit).toHaveBeenCalledOnce();
    expect(observedInstallIds).toEqual([installId]);
    expect(observedRegistryEntries).toEqual([prepared.registryEntry]);
    expect(observedAccessGrants).toEqual([approvedPluginAccess]);
    expect(runtime.resolvePluginInstallId(canonicalId)).toBe(installId);
    await expect(runtime.call("manifest_fresh_ping")).resolves.toBe("pong");
  });

  it("rejects a prepared manifest id already owned as another plugin's install alias", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-collision-"));
    roots.push(root);
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      { installReceiptCacheRoot: join(root, "cache") },
    );
    const owner = await writePreparedPlugin(root, "canonical-owner", "claimed-alias");
    await runtime.activatePreparedArtifact({
      installId: "claimed-alias",
      ...owner,
      durableCommit: async () => "owner-committed",
    });
    const collision = await writePreparedPlugin(
      root,
      "claimed-alias",
      "claimed-alias",
    );
    const durableCommit = vi.fn(async () => "must-not-commit");

    await expect(runtime.activatePreparedArtifact({
      installId: "claimed-alias",
      ...collision,
      durableCommit,
    })).rejects.toMatchObject({ code: "plugin-identity-collision" });
    expect(durableCommit).not.toHaveBeenCalled();
    expect(runtime.resolvePluginId("claimed-alias")).toBe("canonical-owner");
  });

  it("atomically reserves canonical and install identities until durable publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-concurrent-collision-"));
    roots.push(root);
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      { installReceiptCacheRoot: join(root, "cache") },
    );
    const owner = await writePreparedPlugin(
      root,
      "concurrent-owner",
      "shared-identity",
    );
    const collision = await writePreparedPlugin(
      root,
      "shared-identity",
      "second-install",
    );
    let releaseCommit!: () => void;
    const holdCommit = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    let signalCommitEntered!: () => void;
    const commitEntered = new Promise<void>((resolve) => {
      signalCommitEntered = resolve;
    });
    const ownerCommit = vi.fn(async () => {
      signalCommitEntered();
      await holdCommit;
      return "owner-committed";
    });
    const collisionCommit = vi.fn(async () => "must-not-commit");

    const ownerActivation = runtime.activatePreparedArtifact({
      installId: "shared-identity",
      ...owner,
      durableCommit: ownerCommit,
    });
    await commitEntered;
    await expect(runtime.activatePreparedArtifact({
      installId: "second-install",
      ...collision,
      durableCommit: collisionCommit,
    })).rejects.toMatchObject({ code: "plugin-identity-collision" });
    expect(ownerCommit).toHaveBeenCalledOnce();
    expect(collisionCommit).not.toHaveBeenCalled();
    releaseCommit();
    const activated = await ownerActivation;
    await activated.retirement;
    expect(runtime.resolvePluginInstallId("concurrent-owner"))
      .toBe("shared-identity");
  });

  // Cover every throw boundary with one outer reservation cleanup so retries cannot inherit leaked identity.
  const failurePhases: ReadonlyArray<{
    label: string;
    entrySource?: (toolName: string) => string;
    failsRegistryProvenance?: boolean;
    failsPreparePluginStart?: boolean;
    failsGenerationMaterialization?: boolean;
    failsHostApiIncarnation?: boolean;
    failsDurableCommit?: boolean;
    failsPublication?: boolean;
    expectedMessage?: string;
    reachesDurableCommit?: boolean;
  }> = [
    {
      label: "registry provenance",
      failsRegistryProvenance: true,
      expectedMessage: "registry manifest provenance changed",
    },
    { label: "runtime preparation hook", failsPreparePluginStart: true },
    {
      label: "generation materialization",
      failsGenerationMaterialization: true,
      expectedMessage: "ENOENT",
    },
    { label: "host api incarnation", failsHostApiIncarnation: true },
    {
      label: "module import",
      entrySource: () => 'throw new Error("module import failure");\n',
    },
    {
      label: "plugin factory",
      entrySource: () => `export default async function createPlugin() {
  throw new Error("plugin factory failure");
}
`,
    },
    {
      label: "plugin start",
      entrySource: (toolName) => `export default async function createPlugin() {
  return {
    handlers: { ${toolName}: async () => "pong" },
    start: async () => { throw new Error("plugin start failure"); },
  };
}
`,
    },
    {
      label: "durable commit",
      failsDurableCommit: true,
      reachesDurableCommit: true,
    },
    {
      label: "prepared publication",
      failsPublication: true,
      reachesDurableCommit: true,
    },
  ];

  for (const phase of failurePhases) {
    it(`releases both reserved identities after ${phase.label} failure`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ave-prepared-retry-"));
      roots.push(root);
      const pluginId = `retry-${phase.label.replaceAll(" ", "-")}`;
      const installId = `catalog-${phase.label.replaceAll(" ", "-")}`;
      const incumbentConfig = {
        pythonExecutable: join(root, "incumbent-python"),
        retained: "incumbent",
      };
      const candidatePythonExecutable = join(root, "candidate-python");
      const failure = new Error(`${phase.label} failure`);
      // Arm runtime faults once so retry reuses the same reservation map.
      let injectRuntimeFailure = true;
      const failingCreateHostApi: PluginRuntimeOptions["createHostApi"] = (
        hostApiPluginId,
        hostApiManifest,
        dataDir,
      ) => {
        if (injectRuntimeFailure) throw failure;
        return createNoopHostApiForTests(hostApiPluginId, hostApiManifest, dataDir);
      };
      const runtime = makeTestPluginRuntime(
        {
          rootDir: root,
          registryPath: join(root, "plugins", "registry.json"),
          pluginsRoot: join(root, "plugins"),
        },
        {
          installReceiptCacheRoot: join(root, "cache"),
          preparePluginStart: async () => {
            if (phase.failsPreparePluginStart && injectRuntimeFailure) throw failure;
            return { configOverride: { pythonExecutable: candidatePythonExecutable } };
          },
          ...(phase.failsHostApiIncarnation ? { createHostApi: failingCreateHostApi } : {}),
        },
      );
      runtime.setConfigOverride(pluginId, incumbentConfig);
      const publicationSpy = phase.failsPublication
        ? vi.spyOn(runtime, "prepareRuntimeGeneration").mockImplementation(
          () => ({ handOver: () => undefined, publish: () => { throw failure; } }) as never,
        )
        : undefined;
      const failedPrepared = await writePreparedPlugin(
        root,
        pluginId,
        installId,
        phase.entrySource,
      );
      if (phase.failsGenerationMaterialization) {
        await rm(join(failedPrepared.pluginRoot, "entry.mjs"));
      }
      const failedRegistryEntry = phase.failsRegistryProvenance
        ? { ...failedPrepared.registryEntry, manifestSha256: "b".repeat(64) }
        : failedPrepared.registryEntry;
      const failedCommit = vi.fn(async () => {
        if (phase.failsDurableCommit) throw failure;
        return "first-commit";
      });

      await expect(runtime.activatePreparedArtifact({
        installId,
        ...failedPrepared,
        registryEntry: failedRegistryEntry,
        durableCommit: failedCommit,
      })).rejects.toThrow(phase.expectedMessage ?? failure.message);
      publicationSpy?.mockRestore();
      injectRuntimeFailure = false;

      expect(runtime.listPluginIds()).not.toContain(pluginId);
      expect(runtime.getConfigOverride(pluginId)).toEqual(incumbentConfig);
      if (phase.reachesDurableCommit) expect(failedCommit).toHaveBeenCalledOnce();
      else expect(failedCommit).not.toHaveBeenCalled();

      const retryPrepared = await writePreparedPlugin(root, pluginId, installId);
      const retryCommit = vi.fn(async () => "retry-commit");
      const activated = await runtime.activatePreparedArtifact({
        installId,
        ...retryPrepared,
        durableCommit: retryCommit,
      });
      await activated.retirement;

      expect(activated.result).toBe("retry-commit");
      expect(retryCommit).toHaveBeenCalledOnce();
      expect(runtime.resolvePluginInstallId(pluginId)).toBe(installId);
      expect(runtime.getConfigOverride(pluginId)).toEqual({
        pythonExecutable: candidatePythonExecutable,
        retained: "incumbent",
      });
      await expect(runtime.call(`${pluginId.replaceAll("-", "_")}_ping`)).resolves.toBe("pong");
    });
  }
});

type AuditEntry = { level: string; message: string; data?: unknown };

/** Boot and refused updates must report the same protocol refusal event, fields and message. */
async function bootRefusalOf(pluginId: string): Promise<{ audit: AuditEntry[]; message: string | undefined }> {
  const root = await mkdtemp(join(tmpdir(), "ave-boot-refusal-"));
  roots.push(root);
  const pluginRoot = join(root, "plugins", pluginId);
  await mkdir(pluginRoot, { recursive: true });
  const manifest: PluginManifest = {
    id: pluginId,
    name: pluginId,
    version: "1.1.0",
    entry: "entry.mjs",
    description: "Prepared identity fixture.",
    tools: [],
  };
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify(agentPluginsDocument(manifest)), "utf8");
  await writeFile(join(pluginRoot, "entry.mjs"), "export default async function createPlugin() { return { handlers: {} }; }\n", "utf8");
  const registryPath = join(root, "plugins", "registry.json");
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    plugins: [{ id: pluginId, manifestPath: join(pluginRoot, "plugin.json"), enabled: true }],
  }), "utf8");
  const audit: AuditEntry[] = [];
  const runtime = makeTestPluginRuntime(
    { rootDir: root, registryPath, pluginsRoot: join(root, "plugins") },
    { auditLog: (level, message, data) => { audit.push({ level, message, data }); } },
  );
  await runtime.startAll();
  const card = runtime.listPluginCards().find((candidate) => candidate.id === pluginId);
  expect(card?.loadStatus).toBe("failed");
  // Undeclared protocol fails before routing, so no arm is recorded.
  expect(card?.arm).toBeUndefined();
  expect(card?.confinement).toBeUndefined();
  return {
    audit: audit.filter((entry) => entry.message === "plugin_incompatible_host_protocol"),
    message: card?.installFailureMessage,
  };
}

describe("a prepared update the child factory refuses leaves the running generation serving", () => {
  it("rejects with the boot refusal, records it for the card and keeps the incumbent generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-refused-"));
    roots.push(root);
    const pluginId = "refused-update";
    const installId = "catalog-refused-update";
    const cacheRoot = join(root, "cache");
    const audit: AuditEntry[] = [];
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      {
        installReceiptCacheRoot: cacheRoot,
        auditLog: (level, message, data) => { audit.push({ level, message, data }); },
      },
    );
    const lifecycle = (runtime as unknown as {
      generationLifecycle: { getActive(id: string): { generationId: string } | undefined };
    }).generationLifecycle;
    const incumbent = await writePreparedPlugin(
      root,
      pluginId,
      installId,
      (toolName) => `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "incumbent" } };
}
`,
    );
    const activated = await runtime.activatePreparedArtifact({
      installId,
      ...incumbent,
      durableCommit: async () => "incumbent-committed",
    });
    await activated.retirement;
    const incumbentGenerationId = lifecycle.getActive(pluginId)?.generationId;
    expect(incumbentGenerationId).toBeDefined();
    const generationsRoot = join(cacheRoot, pluginId, "generations");
    const generationsBefore = await readdir(generationsRoot);
    expect(generationsBefore).toHaveLength(1);

    const candidateRoot = join(root, "candidate");
    await mkdir(candidateRoot);
    const candidate = await writePreparedPlugin(
      candidateRoot,
      pluginId,
      installId,
      (toolName) => `export default async function createPlugin() {
  return { handlers: { ${toolName}: async () => "candidate" } };
}
`,
      { version: "1.1.0", requires: undefined },
    );
    expect(candidate.manifest.requires).toBeUndefined();
    const durableCommit = vi.fn(async () => "must-not-commit");

    const rejection = await runtime.activatePreparedArtifact({
      installId,
      ...candidate,
      durableCommit,
    }).then(() => undefined, (error: unknown) => error);

    expect(rejection).toBeInstanceOf(IncompatibleHostProtocolError);
    const expectedMessage = new IncompatibleHostProtocolError(pluginId, { declared: null }).message;
    expect((rejection as Error).message).toBe(expectedMessage);
    expect(durableCommit).not.toHaveBeenCalled();

    const boot = await bootRefusalOf(pluginId);
    expect(boot.audit).toHaveLength(1);
    expect(boot.message).toBe(expectedMessage);
    expect(audit.filter((entry) => entry.message === "plugin_incompatible_host_protocol")).toEqual(boot.audit);
    expect(boot.audit[0]).toEqual({
      level: "error",
      message: "plugin_incompatible_host_protocol",
      data: { pluginId, declared: null, served: [...HOST_PROTOCOL_VERSIONS_SERVED] },
    });

    const card = runtime.listPluginCards().find((entry) => entry.id === pluginId);
    expect(card?.loadStatus).toBe("loaded");
    expect(card?.version).toBe("1.0.0");
    expect(card?.installFailureKind).toBeUndefined();
    expect(card?.lastAttemptRefusal).toEqual({
      attempt: "update",
      kind: "incompatible-host-protocol",
      message: boot.message,
      at: expect.any(String),
    });

    expect(lifecycle.getActive(pluginId)?.generationId).toBe(incumbentGenerationId);
    await expect(runtime.call(`${pluginId.replaceAll("-", "_")}_ping`)).resolves.toBe("incumbent");
    expect(await readdir(generationsRoot)).toEqual(generationsBefore);
  });

  it("clears the recorded refusal when a later update commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-prepared-refused-clear-"));
    roots.push(root);
    const pluginId = "refused-then-fixed";
    const installId = "catalog-refused-then-fixed";
    const runtime = makeTestPluginRuntime(
      {
        rootDir: root,
        registryPath: join(root, "plugins", "registry.json"),
        pluginsRoot: join(root, "plugins"),
      },
      { installReceiptCacheRoot: join(root, "cache") },
    );
    const incumbent = await writePreparedPlugin(root, pluginId, installId);
    await (await runtime.activatePreparedArtifact({
      installId,
      ...incumbent,
      durableCommit: async () => "incumbent-committed",
    })).retirement;
    const refusedRoot = join(root, "refused");
    await mkdir(refusedRoot);
    const refused = await writePreparedPlugin(refusedRoot, pluginId, installId, undefined, {
      version: "1.1.0",
      requires: undefined,
    });
    await expect(runtime.activatePreparedArtifact({
      installId,
      ...refused,
      durableCommit: async () => "must-not-commit",
    })).rejects.toBeInstanceOf(IncompatibleHostProtocolError);
    expect(runtime.listPluginCards().find((entry) => entry.id === pluginId)?.lastAttemptRefusal?.attempt)
      .toBe("update");

    const fixedRoot = join(root, "fixed");
    await mkdir(fixedRoot);
    const fixed = await writePreparedPlugin(fixedRoot, pluginId, installId, undefined, { version: "1.2.0" });
    await (await runtime.activatePreparedArtifact({
      installId,
      ...fixed,
      durableCommit: async () => "fixed-committed",
    })).retirement;

    const card = runtime.listPluginCards().find((entry) => entry.id === pluginId);
    expect(card?.version).toBe("1.2.0");
    expect(card?.lastAttemptRefusal).toBeUndefined();
  });
});
