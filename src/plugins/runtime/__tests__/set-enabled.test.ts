/** Enabled state follows immutable-generation admission; re-enable verifies receipt-covered bytes before publishing. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestPluginRuntime } from "../../__tests__/test-helpers.js";
import { createNoopHostApiForTests } from "../sandbox.js";
import type { PluginRegistryTrust } from "../../types.js";
import { canonicalJSON } from "../../secret-access/canonical-json.js";
import { sha256Hex } from "../../../lib/hex-digest-equal.js";
import { PluginBundleLifecycle } from "../../plugin-bundle-lifecycle.js";
import { SkillStore } from "../../../main/skill-store.js";
import { PersonaPromptStore } from "../../../main/persona-prompt-store.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { withPluginInstallLock } from "../../install-lifecycle.js";
import {
  buildInstallReceipt,
  installReceiptPath,
  writeInstallReceipt,
} from "../../plugin-install-receipt.js";
import {
  servedAgentPluginsDocument,
  patchAveFields,
} from "../../__tests__/test-helpers.js";

const registryCommitGate = vi.hoisted(() => ({
  started: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
  release: undefined as (() => void) | undefined,
}));

vi.mock("../../registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../registry.js")>();
  return {
    ...actual,
    updatePluginRegistry: async (
      ...args: Parameters<typeof actual.updatePluginRegistry>
    ) => {
      registryCommitGate.started?.();
      if (registryCommitGate.wait) await registryCommitGate.wait;
      return actual.updatePluginRegistry(...args);
    },
  };
});

describe("PluginRuntime — active/inactive toggle (#1176)", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let manifestPath: string;

  async function makeTreeWritable(path: string): Promise<void> {
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isDirectory()) return;
    await chmod(path, 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeTreeWritable(join(path, entry.name));
    }
  }

  function holdRegistryCommit(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      registryCommitGate.release = resolve;
    });
    registryCommitGate.started = markStarted;
    registryCommitGate.wait = wait;
    return {
      started,
      release: () => {
        const release = registryCommitGate.release;
        registryCommitGate.started = undefined;
        registryCommitGate.wait = undefined;
        registryCommitGate.release = undefined;
        release?.();
      },
    };
  }

  function releaseRegistryCommit(): void {
    const release = registryCommitGate.release;
    registryCommitGate.started = undefined;
    registryCommitGate.wait = undefined;
    registryCommitGate.release = undefined;
    release?.();
  }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-set-enabled-"));
    installedDir = join(testDir, "plugins");
    const pluginDir = join(installedDir, "se-plugin");
    await mkdir(pluginDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
    manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { se_ping: async () => "pong" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: "se-plugin",
        name: "SE Plugin",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "se_ping", description: "se_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "set-enabled test",
      })),
      "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "se-plugin", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const { receipt } = await buildInstallReceipt(pluginDir, {
      pluginId: "se-plugin",
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "prod-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(testDir, receipt);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    releaseRegistryCommit();
    await makeTreeWritable(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  function makeRuntime(opts: {
    onDisable?: (id: string) => void;
    onEnable?: (id: string) => void;
    onActiveStateChange?: (id: string, enabled: boolean) => Promise<void> | void;
  } = {}) {
    return makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot: installedDir },
      { ...opts, installReceiptCacheRoot: testDir },
    );
  }

  it("defaults to active (enabled !== false) for a freshly loaded plugin", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
  });

  it("disable publishes an inactive pointer, drains runtime, persists false, and fires the callback", async () => {
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({ onActiveStateChange: (id, enabled) => changes.push({ id, enabled }) });
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain("se-plugin");

    await runtime.setPluginEnabled("se-plugin", false);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(runtime.listPluginIds()).not.toContain("se-plugin");
    expect(changes).toEqual([{ id: "se-plugin", enabled: false }]);

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);

    // Retain disabled metadata for verified explicit re-enable.
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("disabled");
    expect(card?.runtimeLoaded).toBe(false);
    expect(card?.active).toBe(false);
  });

  it("re-enable marks active + persists enabled=true + fires active-state callback", async () => {
    const changes: Array<{ id: string; enabled: boolean }> = [];
    const runtime = makeRuntime({ onActiveStateChange: (id, enabled) => changes.push({ id, enabled }) });
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    changes.length = 0;

    await runtime.setPluginEnabled("se-plugin", true);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(changes).toEqual([{ id: "se-plugin", enabled: true }]);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(true);
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("loaded");
    expect(card?.runtimeLoaded).toBe(true);
    expect(card?.active).toBe(true);
  });

  it("keeps a consumer inactive when its required provider is disabled", async () => {
    const providerId = "calendar-provider";
    const providerDir = join(installedDir, providerId);
    const providerManifestPath = join(providerDir, "plugin.json");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { calendar_provider_ping: async () => "pong" } };
}`,
      "utf-8",
    );
    await writeFile(
      providerManifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: providerId,
        name: "Calendar provider",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "calendar_provider_ping", description: "calendar provider ping", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        capabilities: ["calendar-source"],
        description: "set-enabled provider fixture",
      })),
      "utf-8");
    const consumerManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    patchAveFields(consumerManifest, {
      requires: { hostProtocol: "5", capabilities: ["calendar-source"] },
    });
    await writeFile(manifestPath, JSON.stringify(consumerManifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "se-plugin", manifestPath, enabled: false },
          { id: providerId, manifestPath: providerManifestPath, enabled: false },
        ],
      }),
      "utf-8",
    );
    const { receipt: consumerReceipt } = await buildInstallReceipt(join(installedDir, "se-plugin"), {
      pluginId: "se-plugin",
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "c".repeat(64),
      signerKeyId: "prod-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    const { receipt: providerReceipt } = await buildInstallReceipt(providerDir, {
      pluginId: providerId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "d".repeat(64),
      signerKeyId: "prod-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(testDir, consumerReceipt);
    await writeInstallReceipt(testDir, providerReceipt);

    const runtime = makeRuntime();
    await runtime.startAll();

    await expect(runtime.setPluginEnabled("se-plugin", true)).rejects.toThrow(
      "missing required capabilities: calendar-source",
    );
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(runtime.listPluginIds()).not.toContain("se-plugin");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
  });

  it("re-enables with the registry entry's origin, so a host-secret grant survives the toggle", async () => {
    const origin = {
      sourceId: "ave",
      sourceOrigin: "official" as const,
      commit: "c".repeat(40),
      packagePath: "plugins/se-plugin",
      version: "1.0.0",
      rung: "legacy" as const,
      artifactSha256: null,
      installedAt: new Date(0).toISOString(),
    };
    const manifestSha256 = sha256Hex(canonicalJSON(JSON.parse(await readFile(manifestPath, "utf-8"))));
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "se-plugin", manifestPath, enabled: true, installSource: "user", manifestSha256, origin }] }),
      "utf-8",
    );
    const candidates: Array<Readonly<PluginRegistryTrust> | undefined> = [];
    const runtime = makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot: installedDir },
      {
        installReceiptCacheRoot: testDir,
        createHostApi: (...args) => {
          candidates.push(args[5]);
          return createNoopHostApiForTests(args[0], args[1], args[2]);
        },
      },
    );
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    candidates.length = 0;
    await runtime.setPluginEnabled("se-plugin", true);

    expect(candidates).toEqual([{ installSource: "user", manifestSha256, origin }]);
  });

  it("re-enables a canonical manifest through its raw registry alias receipt", async () => {
    const installId = "se-plugin-marketplace";
    const pluginDir = join(installedDir, "se-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: installId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    await rm(installReceiptPath(testDir, "se-plugin"), { force: true });
    const { receipt } = await buildInstallReceipt(pluginDir, {
      pluginId: installId,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "b".repeat(64),
      signerKeyId: "prod-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(testDir, receipt);

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.resolvePluginInstallId("se-plugin")).toBe(installId);

    await runtime.setPluginEnabled(installId, false);
    await runtime.setPluginEnabled(installId, true);

    await expect(runtime.call("se_ping")).resolves.toBe("pong");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((plugin: { id: string }) => plugin.id === installId).enabled)
      .toBe(true);
  });

  it("uninstalls an inactive plugin and permits a clean same-id reinstall", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);

    const removed = await runtime.removePluginWithCommit(
      "se-plugin",
      async () => {
        await writeFile(
          registryPath,
          JSON.stringify({ version: 1, plugins: [] }),
          "utf-8",
        );
        return "removed";
      },
    );

    expect(removed).toBe("removed");
    expect(runtime.listPluginCards().find((card) => card.id === "se-plugin")).toBeUndefined();

    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "se-plugin", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    await expect(runtime.addPlugin("se-plugin")).resolves.toBe("started");
    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    await expect(runtime.call("se_ping")).resolves.toBe("pong");
  });

  it("preserves a later enable while an earlier disable commit is delayed", async () => {
    const changes: boolean[] = [];
    const runtime = makeRuntime({
      onActiveStateChange: (_id, enabled) => changes.push(enabled),
    });
    await runtime.startAll();
    const commit = holdRegistryCommit();

    const disable = runtime.setPluginEnabled("se-plugin", false);
    await commit.started;
    const enable = runtime.setPluginEnabled("se-plugin", true);
    commit.release();
    await Promise.all([disable, enable]);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    expect(changes).toEqual([false, true]);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(true);
  });

  it("preserves a later disable while an earlier enable commit is delayed", async () => {
    const changes: boolean[] = [];
    const runtime = makeRuntime({
      onActiveStateChange: (_id, enabled) => changes.push(enabled),
    });
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    changes.length = 0;
    const commit = holdRegistryCommit();

    const enable = runtime.setPluginEnabled("se-plugin", true);
    await commit.started;
    const disable = runtime.setPluginEnabled("se-plugin", false);
    commit.release();
    await Promise.all([enable, disable]);

    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(changes).toEqual([true, false]);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
  });

  it("admits no new runtime call after disable", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.setPluginEnabled("se-plugin", false);
    await expect(runtime.call("se_ping")).rejects.toThrow("Plugin method not found: se_ping");
  });

  it("throws for an unknown plugin id", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await expect(runtime.setPluginEnabled("nope", false)).rejects.toThrow("Plugin not found: nope");
  });

  it("fails closed when the loaded plugin is missing from registry.json", async () => {
    const runtime = makeRuntime();
    await runtime.startAll();
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");

    await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow(
      "Plugin not found in registry: se-plugin",
    );

    expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
    expect(card?.loadStatus).toBe("loaded");
    expect(card?.runtimeLoaded).toBe(true);
    expect(card?.active).toBe(true);
  });

  it("keeps committed state aligned when a post-commit host callback fails", async () => {
    const onActiveStateChange = vi.fn(async () => { throw new Error("MCP projection failed"); });
    const runtime = makeRuntime({ onActiveStateChange });
    await runtime.startAll();

    await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow("MCP projection failed");

    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
  });

  it("projects the committed inactive state even when runtime retirement fails", async () => {
    const onActiveStateChange = vi.fn();
    const runtime = makeRuntime({ onActiveStateChange });
    await runtime.startAll();
    const prepareRuntimeRetirement =
      runtime.prepareRuntimeRetirement.bind(runtime);
    vi.spyOn(runtime, "prepareRuntimeRetirement").mockImplementation(
      (projection) =>
        prepareRuntimeRetirement(projection).map((step) =>
          step.phase === "runtime.drain"
            ? Object.freeze({
                ...step,
                run: async () => {
                  throw new Error("retirement drain failed");
                },
              })
            : step),
    );

    await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow(
      /generation retirement failed/,
    );

    expect(onActiveStateChange).toHaveBeenCalledWith("se-plugin", false);
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(registry.plugins.find((p: { id: string }) => p.id === "se-plugin").enabled).toBe(false);
  });

  it.each([
    [2500, false, "recover"],
    [12000, false, "recover"],
    [12000, true, "recover"],
    [12000, false, "remove"],
    [12000, false, "reject"],
    [12000, false, "effects"],
  ] as const)("settles a committed disable after a %s ms release, queued enable=%s, action=%s", async (releaseMs, queuedEnable, action) => {
    const runtime = makeRuntime();
    const stateChanged = vi.fn();
    const unsubscribeStateChange = runtime.subscribePluginStateChange(stateChanged);
    const lifecycle = new PluginBundleLifecycle({
      pluginRuntime: runtime,
      receiptCacheRoot: testDir,
      skillStore: new SkillStore({ userDir: join(testDir, "skills") }),
      skillOverlay: { clearPluginGeneration: vi.fn() },
      personaPromptStore: new PersonaPromptStore({ userDir: join(testDir, "prompts") }),
      hookManager: new ScriptHookManager(),
      revokeOperationGeneration: vi.fn(),
      onContributionsUpdated: vi.fn(),
      mcpManager: {
        bundledServerIdsForPlugin: vi.fn(() => []),
        prepareBundledGeneration: vi.fn(async () => ({ records: [], predecessorServerIds: [], predecessorToolNames: [],
          registryReplacement: { publish: vi.fn(), cancel: vi.fn(), replacementTools: [] }, published: false })),
        publishBundledGeneration: vi.fn(),
        discardBundledGeneration: vi.fn(async () => undefined),
        retirePublishedMcpReplacement: vi.fn(async () => undefined),
        disconnectBundledGeneration: vi.fn(async () => undefined),
      } as never,
      loopbackManager: {
        prepareGeneration: vi.fn(async () => ({})),
        prepareRemoval: vi.fn(() => ({})),
        publishGeneration: vi.fn(), postPublishGeneration: vi.fn(),
        discardGeneration: vi.fn(async () => undefined), retireGeneration: vi.fn(async () => undefined),
      } as never,
    });
    runtime.setGenerationAccess(lifecycle);
    await runtime.startAll();
    const activeGeneration = lifecycle.getActive("se-plugin");
    const projection = runtime.getRuntimeGenerationProjection("se-plugin");
    expect(projection).toBeDefined();
    if (!projection?.instance.stop) throw new Error("Plugin stop fixture is missing");
    let entered!: () => void;
    const inStop = new Promise<void>(resolve => { entered = resolve; });
    const originalStop = projection.instance.stop.bind(projection.instance);
    let stopped = false;
    let confirmEarlyStop: (() => void) | undefined;
    const earlyStopGate = releaseMs === 12000 && !queuedEnable && action === "recover"
      ? new Promise<void>(resolve => { confirmEarlyStop = resolve; })
      : undefined;
    const stop = vi.spyOn(projection.instance, "stop").mockImplementation(async () => {
      entered();
      await new Promise(resolve => setTimeout(resolve, releaseMs));
      await earlyStopGate;
      await originalStop();
      stopped = true;
      if (action === "reject") throw new Error("late stop rejection");
    });
    let effectsBlocked = true;
    const retirementPasses = action === "effects" ? vi.spyOn(lifecycle, "deactivateWithCommit") : undefined;
    const dispose = vi.fn(() => {
      if (!stopped) throw new Error("effects await stop confirmation");
      if (effectsBlocked) throw new Error("effects retirement failed after stop");
    });
    if (action === "effects") {
      const prepareRuntimeRetirement = runtime.prepareRuntimeRetirement.bind(runtime);
      vi.spyOn(runtime, "prepareRuntimeRetirement").mockImplementation(view =>
        prepareRuntimeRetirement({ ...view, disposers: [...(view.disposers ?? []), dispose] }));
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let outcome: { error?: unknown } | undefined;
    const disable = runtime.setPluginEnabled("se-plugin", false).then(
      () => { outcome = {}; }, error => { outcome = { error }; },
    );
    await inStop;
    await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 20000 });
    await disable;
    if (releaseMs > 6000) {
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")).toMatchObject({
        loadStatus: "failed", installFailureMessage: expect.stringContaining("unconfirmed; retry"),
      });
      await expect(runtime.restartPlugin("se-plugin")).rejects.toThrow("shutdown is unconfirmed");
      if (releaseMs === 12000 && !queuedEnable && action === "recover") {
        const lifecycleQueue = vi.spyOn(lifecycle, "runInLifecycleQueue");
        const retirement = vi.spyOn(lifecycle, "deactivateWithCommit");
        let enableOutcome: { error?: unknown } | undefined;
        const earlyEnable = runtime.setPluginEnabled("se-plugin", true).then(
          () => { enableOutcome = {}; }, error => { enableOutcome = { error }; },
        );
        try {
          await vi.waitFor(() => expect(enableOutcome).toBeDefined(), { timeout: 20000 });
        } finally {
          if (!enableOutcome) {
            confirmEarlyStop?.();
            await vi.advanceTimersByTimeAsync(releaseMs);
          }
          await earlyEnable;
        }
        const enableError = enableOutcome?.error;
        expect(enableError).toBeInstanceOf(Error);
        expect((enableError as Error).message).toBe(
          "plugin shutdown is unconfirmed for se-plugin; retry the enabled-state change",
        );
        expect(lifecycleQueue).toHaveBeenCalledTimes(1);
        expect(retirement).toHaveBeenCalledTimes(1);
        lifecycleQueue.mockRestore();
        retirement.mockRestore();
        await withPluginInstallLock("se-plugin", async () => undefined);
        expect(stopped).toBe(false);
        expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
        expect(lifecycle.getActive("se-plugin")).toBeUndefined();
        expect(JSON.parse(await readFile(registryPath, "utf8")).plugins[0].enabled).toBe(false);
        expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.loadStatus).toBe("failed");
        expect(stop).toHaveBeenCalledTimes(1);
        expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.lifecycleQuarantined).toBeUndefined();
        confirmEarlyStop?.();
      }
    }
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
    expect(lifecycle.getActive("se-plugin")).toBeUndefined();
    expect(runtime.listPluginCards().find(card => card.id === "se-plugin")).toMatchObject({
      active: false, runtimeLoaded: false,
    });
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(registry.plugins[0].enabled).toBe(false);
    if (releaseMs > 6000) expect(outcome?.error).toBeDefined();
    else expect(outcome?.error).toBeUndefined();
    expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.lifecycleQuarantined).toBeUndefined();
    const durableRemoval = vi.fn(async () => {
      await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf8");
      return "removed";
    });
    if (action === "remove") {
      await expect(runtime.removePluginWithCommit("se-plugin", durableRemoval)).rejects.toThrow("shutdown is unconfirmed");
      await expect(runtime.removePlugin("se-plugin")).rejects.toThrow("shutdown is unconfirmed");
      expect(durableRemoval).not.toHaveBeenCalled();
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")).toMatchObject({
        active: false, runtimeLoaded: false, loadStatus: "failed",
        installFailureMessage: expect.stringContaining("unconfirmed; retry"),
      });
      expect(JSON.parse(await readFile(registryPath, "utf8")).plugins).toHaveLength(1);
      const getActive = vi.spyOn(lifecycle, "getActive").mockReturnValue(activeGeneration);
      await expect(runtime.setPluginEnabled("se-plugin", false)).rejects.toThrow("cannot retire disabled plugin with an active generation");
      getActive.mockRestore();
      expect(Reflect.get(runtime, "pendingDisabledRetirements").has("se-plugin")).toBe(true);
    }
    let unlock: (() => void) | undefined;
    let locked: (() => void) | undefined;
    const lockReady = new Promise<void>(resolve => { locked = resolve; });
    const lockHeld = queuedEnable ? withPluginInstallLock("se-plugin", async () => {
      locked?.();
      await new Promise<void>(resolve => { unlock = resolve; });
    }) : undefined;
    if (lockHeld) await lockReady;
    let queuedEnableError: unknown;
    const enable = queuedEnable ? runtime.setPluginEnabled("se-plugin", true).catch(error => {
      queuedEnableError = error;
    }) : undefined;
    const cancelPendingRestart = vi.spyOn(runtime, "cancelPendingRestart");
    await vi.advanceTimersByTimeAsync(releaseMs);
    await vi.waitFor(() => expect(stopped).toBe(true), { timeout: 20000 });
    unlock?.();
    await lockHeld;
    if (action === "effects") {
      await vi.waitFor(() => expect(retirementPasses).toHaveBeenCalledTimes(2), { timeout: 20000 });
      let automaticError: unknown;
      const automaticRetirement = retirementPasses?.mock.results[1]?.value as Promise<unknown>;
      void automaticRetirement.catch(error => { automaticError = error; });
      await vi.waitFor(() => expect(automaticError).toBeInstanceOf(Error), { timeout: 20000 });
      await withPluginInstallLock("se-plugin", async () => undefined);
      const disposalAttempts = dispose.mock.calls.length;
      expect(disposalAttempts).toBeGreaterThan(1);
      expect(stopped).toBe(true);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")).toMatchObject({
        active: false, runtimeLoaded: false, loadStatus: "failed",
      });
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.lifecycleQuarantined).toBeUndefined();
      expect(Reflect.get(runtime, "pendingDisabledRetirements").has("se-plugin")).toBe(true);
      expect(Reflect.get(runtime, "disabledStopSettlements").size).toBe(0);
      effectsBlocked = false;
      retirementPasses?.mockClear();
      await expect(runtime.setPluginEnabled("se-plugin", true)).rejects.toThrow(
        "previous plugin shutdown is now confirmed for se-plugin; enable again",
      );
      expect(retirementPasses).toHaveBeenCalledTimes(1);
      expect(dispose).toHaveBeenCalledTimes(disposalAttempts + 1);
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(lifecycle.getActive("se-plugin")).toBeUndefined();
      expect(JSON.parse(await readFile(registryPath, "utf8")).plugins[0].enabled).toBe(false);
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.loadStatus).toBe("disabled");
      expect(Reflect.get(runtime, "pendingDisabledRetirements").size).toBe(0);
      expect(Reflect.get(runtime, "disabledStopSettlements").size).toBe(0);
      expect(stateChanged).toHaveBeenCalledExactlyOnceWith("se-plugin", false);
      await runtime.setPluginEnabled("se-plugin", true);
      await expect(runtime.call("se_ping")).resolves.toBe("pong");
      expect(Reflect.get(runtime, "pendingDisabledRetirements").size).toBe(0);
      expect(Reflect.get(runtime, "disabledStopSettlements").size).toBe(0);
      await runtime.setPluginEnabled("se-plugin", false);
      return;
    }
    if (action === "reject") {
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.lifecycleQuarantined).toBeUndefined();
      let retryError: unknown;
      const retry = runtime.setPluginEnabled("se-plugin", false).catch(error => { retryError = error; });
      await vi.waitFor(() => expect(retryError).toBeInstanceOf(Error), { timeout: 20000 });
      await retry;
      expect((retryError as Error).message).toContain("generation retirement failed");
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")).toMatchObject({
        active: false, runtimeLoaded: false, loadStatus: "failed", lifecycleQuarantined: { grantsRetained: false },
      });
      await expect(runtime.restartPlugin("se-plugin")).rejects.toThrow(
        "shutdown is unconfirmed for se-plugin; host restart is required",
      );
      await expect(runtime.setPluginEnabled("se-plugin", true)).rejects.toThrow(
        "shutdown is unconfirmed for se-plugin; host restart is required",
      );
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(lifecycle.getActive("se-plugin")).toBeUndefined();
      expect(JSON.parse(await readFile(registryPath, "utf8")).plugins[0].enabled).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
      const journal = JSON.parse(await readFile(join(testDir, "plugin-retirement-journal.json"), "utf8"));
      expect(journal.retirements).not.toEqual([]);
      return;
    }
    if (enable) {
      await enable;
      expect(queuedEnableError).toBeInstanceOf(Error);
      expect((queuedEnableError as Error).message).toBe(
        "previous plugin shutdown is now confirmed for se-plugin; enable again",
      );
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(lifecycle.getActive("se-plugin")).toBeUndefined();
      await vi.waitFor(() => {
        expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.loadStatus).toBe("disabled");
      }, { timeout: 20000 });
      let confirmedEnable: Promise<void> | undefined;
      await withPluginInstallLock("se-plugin", async () => {
        confirmedEnable = runtime.setPluginEnabled("se-plugin", true);
      });
      await confirmedEnable;
      expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
    } else {
      await vi.waitFor(() => {
        expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.loadStatus).toBe("disabled");
      }, { timeout: 20000 });
      const journal = JSON.parse(await readFile(join(testDir, "plugin-retirement-journal.json"), "utf8"));
      expect(journal.retirements).toEqual([]);
      expect(cancelPendingRestart).not.toHaveBeenCalled();
      if (releaseMs === 12000 && action === "recover") {
        expect(stateChanged).toHaveBeenCalledExactlyOnceWith("se-plugin", false);
        unsubscribeStateChange();
      }
      await runtime.setPluginEnabled("se-plugin", false);
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")?.loadStatus).toBe("disabled");
    }
    expect(stop).toHaveBeenCalledTimes(1);
    const journal = JSON.parse(await readFile(join(testDir, "plugin-retirement-journal.json"), "utf8"));
    expect(journal.retirements).toEqual([]);
    if (action === "remove") {
      await expect(runtime.removePluginWithCommit("se-plugin", durableRemoval)).resolves.toBe("removed");
      expect(runtime.listPluginCards().find(card => card.id === "se-plugin")).toBeUndefined();
      expect(Reflect.get(runtime, "pendingDisabledRetirements").size).toBe(0);
      expect(Reflect.get(runtime, "disabledStopSettlements").size).toBe(0);
      return;
    }
    if (!enable) await runtime.setPluginEnabled("se-plugin", true);
    await expect(runtime.call("se_ping")).resolves.toBe("pong");
    await runtime.setPluginEnabled("se-plugin", false);
    expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
  });

  /** After restart a disabled install remains discoverable but has no admitted runtime until receipt verification. */
  describe("cross-restart: boot from persisted enabled=false", () => {
    let disabledCalls: string[];
    let enabledCalls: string[];
    let runtime: ReturnType<typeof makeRuntime>;

    beforeEach(async () => {
      await writeFile(
        registryPath,
        JSON.stringify({ version: 1, plugins: [{ id: "se-plugin", manifestPath, enabled: false }] }),
        "utf-8",
      );
      disabledCalls = [];
      enabledCalls = [];
      runtime = makeRuntime({
        onDisable: (id) => disabledCalls.push(id),
        onEnable: (id) => enabledCalls.push(id),
      });
      await runtime.startAll();
    });

    it("(a) plugin metadata is known but runtime is not loaded", () => {
      expect(runtime.listPluginIds()).not.toContain("se-plugin");
      expect(runtime.listPluginCards().find((card) => card.id === "se-plugin")).toBeDefined();
    });

    it("(b) isPluginEnabled returns false immediately after boot", () => {
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
      expect(card?.loadStatus).toBe("disabled");
      expect(card?.runtimeLoaded).toBe(false);
      expect(card?.active).toBe(false);
    });

    it("(c) inactivePluginIds seeded at boot without lifecycle teardown callbacks", () => {
      // Disabled boot publishes no runtime and needs no teardown callback.
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(disabledCalls).not.toContain("se-plugin");
    });

    it("(d) setPluginEnabled(true) succeeds after restart", async () => {
      await expect(runtime.setPluginEnabled("se-plugin", true)).resolves.toBeUndefined();
      expect(runtime.isPluginEnabled("se-plugin")).toBe(true);
      expect(enabledCalls).toContain("se-plugin");
      const card = runtime.listPluginCards().find((c) => c.id === "se-plugin");
      expect(card?.loadStatus).toBe("loaded");
      expect(card?.runtimeLoaded).toBe(true);
      expect(card?.active).toBe(true);
    });

    it("(e) rejects tampered installed bytes and keeps the inactive registry state", async () => {
      await writeFile(join(installedDir, "se-plugin", "entry.mjs"), "export default () => ({ handlers: {} });\n");
      await expect(runtime.setPluginEnabled("se-plugin", true)).rejects.toThrow(/verification failed/);
      expect(runtime.isPluginEnabled("se-plugin")).toBe(false);
      expect(runtime.listPluginIds()).not.toContain("se-plugin");
      const registry = JSON.parse(await readFile(registryPath, "utf8"));
      expect(registry.plugins[0].enabled).toBe(false);
    });
  });
});
