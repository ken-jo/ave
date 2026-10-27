import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { createBootHostFixture, createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";
import { directHostFetchTransport } from "../../../__tests__/support/host-fetch-transport.js";
/** Drive the captured boot HostApi factory so config precedence and event identity are tested at their producer. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aveHome } from "../../../shared/ave-home.js";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { createTmpDirTracker } from "../../../__tests__/support/tmp-dir-teardown.js";
import { directHostApiChannel } from "../../../__tests__/support/host-protocol-wire.js";
import { HOSTAPI_DISPATCH_TABLE, HostApiDispatcher, createServiceHostApiPaths } from "../../../plugins/isolation/host-api-dispatcher.js";
import { startPluginChildRuntime } from "../../../plugins/isolation/plugin-child-runtime.js";
import type { PluginHostApi } from "../../../plugins/types.js";
import { runWithEffectGateContext } from "../../../permissions/effect-enforcement.js";
import { SettingsService } from "../../../data/settings-store.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { CredentialIssuanceStage } from "../../../main/host-api/resolve-api-key.js";

const tmpDirs = createTmpDirTracker();

const runtimeTestState = vi.hoisted(() => ({
  browserWindows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void };
  }>,
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async (): Promise<{ version: number; plugins: unknown[] }> => ({ version: 1, plugins: [] })),
  receiptReviewedAppVersion: vi.fn(async (): Promise<string | null> => null),
  officialPins: vi.fn(async () => ["a".repeat(64)]),
  /** The registry file whose identity the HostApi's entry cache watches. */
  registryPath: "/tmp/ave-test/registry.json",
  spawnWorker: vi.fn(),
  runtime: {
    // Install partition policies before starting any plugin.
    load: vi.fn(async () => {}),
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>,
    ),
    getPluginRoot: vi.fn((pluginId: string) => `/tmp/ave-test/plugins/${pluginId}`,
    ),
    getPluginManifest: vi.fn(() => null),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
    isPluginEnabled: vi.fn(() => true),
    getApprovedPluginAccess: vi.fn(() => undefined),
    registerDisposer: vi.fn(),
    isShuttingDown: vi.fn(() => false),
    assertPluginEventAccess: vi.fn(),
    assertPluginEventEmitAccess: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
    setConfigOverride: vi.fn(),
    mergeConfigOverride: vi.fn(),
    setWildcardConfigOverride: vi.fn(),
    getWildcardConfigOverride: vi.fn(() => ({}) as Record<string, unknown>),
    restartPlugin: vi.fn(async () => "started"),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/ave-test"),
    isPackaged: false,
    prependOnceListener: vi.fn(),
    once: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => runtimeTestState.browserWindows),
    getFocusedWindow: vi.fn(() => null),
  }),
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation(function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    runtimeTestState.capturedRuntimeOptions = options;
    return runtimeTestState.runtime;
  }),
}));

vi.mock("../../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../../permissions/worker-spawn.js", () => ({
  spawnWorker: runtimeTestState.spawnWorker,
}));

vi.mock("../../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/ave-test/plugins",
    registryPath: runtimeTestState.registryPath,
    cacheRoot: "/tmp/ave-test/cache",
  })),
}));

vi.mock("../../../plugins/registry.js", () => ({
  readPluginRegistry: runtimeTestState.readPluginRegistry,
}));

vi.mock("../plugin-runtime/grant-evidence.js", () => ({
  grantEvidenceReader: () => ({
    officialPins: runtimeTestState.officialPins,
    receiptArtifactSha256: async () => null,
    receiptReviewedAppVersion: runtimeTestState.receiptReviewedAppVersion,
  }),
}));

/** Official artifact provenance is required for host-secret grants. */
const OFFICIAL_ORIGIN = {
  sourceId: "ave",
  sourceOrigin: "official" as const,
  commit: "c".repeat(40),
  packagePath: "plugins/meeting",
  version: "1.0.0",
  rung: "release" as const,
  artifactSha256: "a".repeat(64),
  installedAt: "2026-09-24T00:00:00.000Z",
};

import { initPluginRuntime } from "../plugin-runtime.js";
import { emitEvent as emitHostEvent } from "../../types.js";
import { withPluginInstallLock } from "../../../plugins/install-lifecycle.js";
import type { PluginAccessSpec, PluginRegistryTrust } from "../../../plugins/types.js";
import { canonicalJSON } from "../../../plugins/secret-access/canonical-json.js";
import { recordManifestDocument } from "../../../plugins/runtime/manifest-validation.js";
import { agentPluginsDocument, pluginDataDirIn } from "../../../plugins/__tests__/test-helpers.js";
import { resolvePluginHostStorageDir } from "../../../plugins/plugin-storage-layout.js";
import type { PluginManifest } from "../../../plugins/types.js";

/** Pins hash the original manifest document, not its runtime projection. */
function granted(pluginId: string, secretKey: string, allowedDomains = ["api.openai.com"]): { manifest: PluginManifest; manifestSha256: string } {
  const networkAccess = { allowedDomains };
  const manifest = { id: pluginId, config: {}, hostSecrets: { read: [secretKey] }, networkAccess } as unknown as PluginManifest;
  const document = agentPluginsDocument({ id: pluginId, version: "1.0.0", hostSecrets: { read: [secretKey] }, networkAccess });
  recordManifestDocument(manifest, document);
  return { manifest, manifestSha256: createHash("sha256").update(canonicalJSON(document)).digest("hex") };
}

type ConfigHostApi = {
  config: {
    get: <T = unknown>(key: string) => T | undefined;
    set: <T = unknown>(key: string, value: T) => Promise<void>;
  };
  emitEvent: (type: string, data?: unknown) => void;
  onEvent: (type: string, handler: (data: unknown) => void) => () => void;
  onPluginsChanged: (
    handler: (event: { type: "installed" | "uninstalled"; pluginId: string; source?: string }) => void,
  ) => () => void;
  getSecret: (key: string) => string | undefined | null;
  storage: {
    readText: (rel: string) => Promise<string>;
    writeJson: (rel: string, value: unknown) => Promise<void>;
  };
  resolveApiKey: (opts: {
    purpose: "llm";
    vendor?: "openai" | "azure-openai" | "vertex" | "anthropic";
    exposure?: "lease" | "raw";
  }) => Promise<
    | { ok: false; reason: string }
    | { ok: true; exposure: "lease"; vendor: string; leaseId: string; release: () => Promise<void>; onClosed: (listener: (reason: "revoked" | "peer-gone") => void) => () => void }
    | { ok: true; exposure: "raw"; vendor: string; key: string; release: () => Promise<void> }
  >;
  hostFetch: (input: string, init?: { method?: string; auth?: { lease: string }; headers?: HeadersInit }) => Promise<Response>;
  spawnWorker: (spec: { workerId: string; command: string }) => Promise<{
    socketPath: string | null;
    pid: number | undefined;
    stop: () => void;
    onStdout: (listener: (chunk: string) => void) => void;
    onStderr: (listener: (chunk: string) => void) => void;
    onExit: (
      listener: (info: {
        code: number | null;
        signal: NodeJS.Signals | null;
      }) => void,
    ) => void;
  }>;
};

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    configSchema?: {
      properties?: Record<
        string,
        { type?: string; format?: string; default?: unknown }
      >;
    };
    capabilities?: string[];
    networkAccess?: { allowedDomains: string[] };
    emittedEvents?: string[];
    hostSecrets?: { read?: string[] };
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
  installPluginId: string | null,
  candidateRegistryEntry?: PluginRegistryTrust,
  candidateApprovedPluginAccess?: PluginAccessSpec | null,
) => ConfigHostApi;

/** The logger passed to boot is the sink for runtime audit records. */
let lastBootAuditLogger: { log: ReturnType<typeof vi.fn> };

async function initAndGetFactory(
  settingsService: unknown,
  bootAuditLogger: { log: ReturnType<typeof vi.fn> } = { log: vi.fn() },
  networkFetch: typeof fetch = vi.fn(async () => new Response(null)) as unknown as typeof fetch,
  approvalGate: unknown = { requestAndWait: vi.fn() },
  options: {
    permissionManager?: PermissionManager;
    onCredentialIssuanceStage?: (stage: CredentialIssuanceStage) => Promise<void> | void;
    getAuthPartition?: (partition: string) => unknown;
  } = {},
): Promise<CreateHostApi> {
  runtimeTestState.capturedRuntimeOptions = null;
  // Keep the handle on the actual injected logger so assertions read the wired sink.
  lastBootAuditLogger = bootAuditLogger;
  await initPluginRuntime({
    host: createBootHostFixture({ desktop: createDesktopHostFixture({
      getAppWindows: () => runtimeTestState.browserWindows as never[],
      ...(options.getAuthPartition ? { getAuthPartition: options.getAuthPartition as never } : {}),
    }) }),
    projectRoot: "/tmp/ave-test/project",
    settingsService: settingsService as never,
    ...(options.onCredentialIssuanceStage
      ? { _onCredentialIssuanceStageForTest: options.onCredentialIssuanceStage }
      : {}),
    memoryManager: {} as never,
    toolRegistry: {
      unregisterByPlugin: vi.fn(),
      register: vi.fn(),
      listAll: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
    } as never,
    pythonPath: undefined,
    bootAuditLogger: lastBootAuditLogger as never,
    mainWindow: {} as never,
    networkFetch: directHostFetchTransport(networkFetch),
    openAuthWindowService: vi.fn(),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: vi.fn(async () => {}),
    shellOpenExternal: vi.fn(),
    approvalGate: approvalGate as never,
    ...(options.permissionManager ? { permissionManager: options.permissionManager } : {}),
    routinesStore: { list: () => [] } as never,
    getWorkBoardStore: () => undefined,
    getAlertsService: () => undefined,
  });
  const createHostApi = (
    runtimeTestState.capturedRuntimeOptions as {
      createHostApi?: CreateHostApi;
    } | null
  )?.createHostApi;
  expect(createHostApi).toBeDefined();
  return createHostApi!;
}

function makeSettingsService(store: Map<string, Record<string, unknown>>) {
  return {
    getProviderConfigRevision: () => 0,
    getSecretGeneration: () => 0,
    onLeaseStateChanged: (_listener: () => void) => () => {},
    get: vi.fn((key: string): unknown => {
      if (key === "llm") return { provider: "openai" };
      if (key === "marketplace") return { installedProviderPresets: [] };
      if (key === "pluginConfigs") return {};
      return undefined;
    }),
    getSecret: vi.fn((_key: string): string | undefined => undefined),
    getPluginConfig: vi.fn((pluginId: string) => store.get(pluginId) ?? {}),
    setPluginConfig: vi.fn(
      async (pluginId: string, record: Record<string, unknown>) => {
        store.set(pluginId, record);
      },
    ),
  };
}

function activeIncarnation() {
  return {
    registerDisposer: vi.fn(),
    trackOperation: <T>(operation: Promise<T>) => operation,
    isActive: () => true,
    isLifecycleHookActive: () => false,
  };
}

beforeEach(() => {
  runtimeTestState.officialPins.mockReset();
  runtimeTestState.officialPins.mockResolvedValue(["a".repeat(64)]);
  runtimeTestState.receiptReviewedAppVersion.mockReset();
  runtimeTestState.receiptReviewedAppVersion.mockResolvedValue(null);
  runtimeTestState.readPluginRegistry.mockReset();
  runtimeTestState.readPluginRegistry.mockResolvedValue({
    version: 1,
    plugins: [],
  });
  runtimeTestState.runtime.setConfigOverride.mockClear();
  runtimeTestState.runtime.restartPlugin.mockClear();
  runtimeTestState.runtime.getWildcardConfigOverride.mockReturnValue({});
  runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
  runtimeTestState.runtime.resolvePluginInstallId.mockClear();
  runtimeTestState.runtime.resolvePluginInstallId.mockImplementation(
    (pluginId: string) => pluginId,
  );
  runtimeTestState.spawnWorker.mockReset();
});

afterEach(() => tmpDirs.cleanup());

describe("HostApi.config.get merged-read precedence", () => {
  it("fails clearly when immutable install provenance is omitted", async () => {
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    const invokeWithoutInstallId = createHostApi as unknown as (
      pluginId: string,
      manifest: Parameters<CreateHostApi>[1],
      pluginDataDir: string,
      incarnation: ReturnType<typeof activeIncarnation>,
    ) => unknown;

    expect(() => invokeWithoutInstallId(
      "plugin-a",
      { id: "plugin-a", config: {} },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-missing-provenance-"))),
      activeIncarnation(),
    )).toThrow(/HostApi install provenance missing: plugin-a/);
    expect(runtimeTestState.runtime.resolvePluginInstallId).not.toHaveBeenCalled();
  });

  it("layers manifest.config < wildcard override < saved plugin config", async () => {
    const store = new Map<string, Record<string, unknown>>([
      ["plugin-a", { p: "cfg", shared: "cfg" }],
    ]);
    runtimeTestState.runtime.getWildcardConfigOverride.mockReturnValue({
      w: "wild",
      shared: "wild",
    });
    const createHostApi = await initAndGetFactory(makeSettingsService(store));
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: { a: "m", shared: "m" } },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-cfg-"))),
      activeIncarnation(),
      "plugin-a",
    );

    expect(api.config.get("a")).toBe("m");
    expect(api.config.get("w")).toBe("wild");
    expect(api.config.get("p")).toBe("cfg");
    expect(api.config.get("shared")).toBe("cfg");
    expect(api.config.get("missing")).toBeUndefined();
  });

  it("applies configSchema defaults as the lowest layer (AB1); higher layers still win", async () => {
    const store = new Map<string, Record<string, unknown>>([
      ["plugin-a", { savedKey: "saved" }],
    ]);
    const createHostApi = await initAndGetFactory(makeSettingsService(store));
    const api = createHostApi(
      "plugin-a",
      {
        id: "plugin-a",
        config: {},
        configSchema: {
          properties: {
            schemaOnly: { type: "string", default: "def" },
            savedKey: { type: "string", default: "def" },
          },
        },
      },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-cfg-def-"))),
      activeIncarnation(),
      "plugin-a",
    );

    expect(api.config.get("schemaOnly")).toBe("def");
    expect(api.config.get("savedKey")).toBe("saved");
    expect(api.config.get("nothing")).toBeUndefined();
  });
});

describe("HostApi.storage containment refusals reach the boot audit log", () => {
  // Use directory junctions on Windows so containment tests need no Developer Mode.
  const dirLinkType = process.platform === "win32" ? "junction" : "dir";

  it("routes a symlink escape through the shared plugin-runtime audit sink", async () => {
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    const dataDir = pluginDataDirIn(tmpDirs.track(
      mkdtempSync(join(tmpdir(), "ave-storage-audit-boot-")),
    ));
    const outsideDir = tmpDirs.track(
      mkdtempSync(join(tmpdir(), "ave-storage-audit-boot-out-")),
    );
    writeFileSync(join(outsideDir, "secret.txt"), "shhh", "utf-8");
    symlinkSync(outsideDir, join(resolvePluginHostStorageDir(dataDir), "escape"), dirLinkType);

    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {} },
      dataDir,
      activeIncarnation(),
      "plugin-a",
    );

    await expect(api.storage.readText("escape/secret.txt")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );

    // Use the same storage-audit sink and transport as the runtime.
    const entries = lastBootAuditLogger.log.mock.calls.map(
      ([entry]) => entry as { type: string; sessionId: string; input: string; output?: string },
    );
    const refusals = entries.filter((e) =>
      e.input.includes("plugin_storage_path_rejected"),
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.type).toBe("error");
    expect(refusals[0]!.sessionId).toBe("plugin-runtime");
    expect(refusals[0]!.input).toBe("[ERROR] plugin_storage_path_rejected");
    const payload = JSON.parse(refusals[0]!.output!) as Record<string, unknown>;
    expect(payload).toMatchObject({
      pluginId: "plugin-a",
      reason: "storage: rejected symlink escape",
    });
  });

  it("stays silent for an in-sandbox write", async () => {
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    const dataDir = pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-storage-audit-ok-"))));
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {} },
      dataDir,
      activeIncarnation(),
      "plugin-a",
    );

    await api.storage.writeJson("prefs.json", { theme: "dark" });
    // Host storage stays beside data/, outside the confined child’s writable directory.
    expect(existsSync(join(resolvePluginHostStorageDir(dataDir), "prefs.json"))).toBe(true);
    expect(existsSync(join(dataDir, "prefs.json"))).toBe(false);

    const inputs = lastBootAuditLogger.log.mock.calls.map(
      ([entry]) => (entry as { input: string }).input,
    );
    expect(inputs.filter((i) => i.includes("plugin_storage_path_rejected"))).toEqual([]);
  });
});

describe("HostApi.config.set round-trip", () => {
  beforeEach(() => {
    runtimeTestState.runtime.getPluginManifest.mockImplementation(
      (pluginId: string) => (pluginId === "plugin-a" ? activeManifest : null),
    );
  });

  let activeManifest: Parameters<CreateHostApi>[1];

  async function createActiveApi(
    settings: ReturnType<typeof makeSettingsService>,
  ) {
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = { id: "plugin-a", config: {} };
    return createHostApi(
      "plugin-a",
      activeManifest,
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-cfg-set-"))),
      {
        registerDisposer: vi.fn(),
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () =>
          runtimeTestState.runtime.getPluginManifest("plugin-a") ===
          activeManifest,
        isLifecycleHookActive: () => false,
      },
      "plugin-a",
    );
  }

  it("persists via setPluginConfig, refreshes the override, restarts the plugin, and re-reads the value", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const api = await createActiveApi(settings);

    await api.config.set("k", "v");

    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      k: "v",
    });
    expect(runtimeTestState.runtime.setConfigOverride).toHaveBeenCalledWith(
      "plugin-a",
      { k: "v" },
    );
    expect(runtimeTestState.runtime.restartPlugin).toHaveBeenCalledWith(
      "plugin-a",
      { skipPreparation: true },
    );
    expect(api.config.get("k")).toBe("v");
  });

  it("rejects config.set for a secret-format key and does not persist", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = {
      id: "plugin-a",
      config: {},
      configSchema: {
        properties: { secretKey: { type: "string", format: "secret" } },
      },
    };
    const api = createHostApi(
      "plugin-a",
      activeManifest,
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-cfg-secret-"))),
      activeIncarnation(),
      "plugin-a",
    );

    await expect(api.config.set("secretKey", "leak")).rejects.toThrow(
      /secret fields must be saved via hostApi\.setSecret/,
    );
    expect(settings.setPluginConfig).not.toHaveBeenCalled();
  });

  it("rejects a queued write when uninstall invalidates the HostApi instance", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const api = await createActiveApi(settings);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const uninstall = withPluginInstallLock("plugin-a", async () => {
      entered();
      await gate;
    });
    await lockEntered;

    const write = api.config.set("k", "stale");
    try {
      await Promise.resolve();
      expect(settings.setPluginConfig).not.toHaveBeenCalled();

      runtimeTestState.runtime.getPluginManifest.mockReturnValue(null);
      expect(() => api.config.get("k")).toThrow(
        /plugin instance is no longer active/,
      );
    } finally {
      release();
      await uninstall;
      await write.catch(() => {});
    }
    await expect(write).rejects.toThrow(/plugin instance is no longer active/);
    expect(settings.setPluginConfig).not.toHaveBeenCalled();
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("persists config from a lifecycle hook without recursively restarting itself", async () => {
    const store = new Map<string, Record<string, unknown>>();
    const settings = makeSettingsService(store);
    const createHostApi = await initAndGetFactory(settings);
    activeManifest = { id: "plugin-a", config: {} };
    const trackOperation = vi.fn(<T>(operation: Promise<T>) => operation);
    const api = createHostApi(
      "plugin-a",
      activeManifest,
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-cfg-lifecycle-"))),
      {
        registerDisposer: vi.fn(),
        trackOperation,
        isActive: () => true,
        isLifecycleHookActive: () => true,
      },
      "plugin-a",
    );

    await expect(api.config.set("duringStart", true)).resolves.toBeUndefined();
    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      duringStart: true,
    });
    expect(trackOperation).toHaveBeenCalledTimes(1);
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("does not deadlock when stop-time config.set re-enters the uninstall lock", async () => {
    const settings = makeSettingsService(new Map());
    const api = await createActiveApi(settings);

    await expect(
      withPluginInstallLock("plugin-a", async () => {
        await api.config.set("duringStop", true);
      }),
    ).resolves.toBeUndefined();

    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      duringStop: true,
    });
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("reports a detached lifecycle config write failure to the owning mutation", async () => {
    const settings = makeSettingsService(new Map());
    settings.setPluginConfig.mockRejectedValueOnce(
      new Error("config persistence failed"),
    );
    const api = await createActiveApi(settings);

    const error = await withPluginInstallLock("plugin-a", async () => {
      void api.config.set("duringStop", true);
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "config persistence failed" }),
    ]);
    expect(runtimeTestState.runtime.restartPlugin).not.toHaveBeenCalled();
  });

  it("surfaces a non-started runtime reload result after config persistence", async () => {
    const settings = makeSettingsService(new Map());
    const api = await createActiveApi(settings);
    runtimeTestState.runtime.restartPlugin.mockResolvedValueOnce("failed");

    await expect(api.config.set("k", "v")).rejects.toThrow(
      /runtime reload returned failed/,
    );
    expect(settings.setPluginConfig).toHaveBeenCalledWith("plugin-a", {
      k: "v",
    });
  });
});

describe("HostApi emitEvent/onEvent round-trip", () => {
  it("authorizes candidate subscriptions against the candidate-scoped access grant", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    const candidateGrant = {
      plugins: [{
        pluginId: "sampleassistant",
        events: ["sampleassistant.snapshot.requested"],
      }],
    };
    const api = createHostApi(
      "samplemail",
      { id: "samplemail", config: {}, capabilities: [] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-candidate-event-grant-"))),
      activeIncarnation(),
      "samplemail",
      { installSource: "admin", manifestSha256: "candidate-sha" },
      candidateGrant,
    );

    api.onEvent("sampleassistant.snapshot.requested", vi.fn());

    expect(runtimeTestState.runtime.assertPluginEventAccess).toHaveBeenCalledWith(
      "samplemail",
      "sampleassistant.snapshot.requested",
      candidateGrant,
    );
  });

  it("uses the raw registry install identity for canonical alias HostApi provenance", async () => {
    const installAlias = "marketplace-install-alias";
    // The registry alias must not change grant provenance.
    const pluginId = "meeting";
    const secretKey = "llm.apiKey.openai";
    const { manifest, manifestSha256 } = granted(pluginId, secretKey);
    runtimeTestState.readPluginRegistry.mockResolvedValueOnce({
      version: 1,
      plugins: [{
        id: installAlias,
        manifestPath: `${installAlias}/plugin.json`,
        installSource: "user",
        manifestSha256,
        origin: OFFICIAL_ORIGIN,
      }],
    });
    runtimeTestState.runtime.resolvePluginInstallId.mockImplementation(
      (requestedPluginId: string) =>
        requestedPluginId === pluginId ? installAlias : requestedPluginId,
    );
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === secretKey ? "host-secret-value" : undefined
    );

    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      pluginId,
      manifest,
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-alias-"))),
      activeIncarnation(),
      installAlias,
    );

    expect(await api.getSecret(secretKey)).toBeNull();
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
    expect(runtimeTestState.runtime.resolvePluginInstallId)
      .not.toHaveBeenCalled();
  });

  it("uses immutable candidate trust before the durable registry cache refresh", async () => {
    const pluginId = "meeting";
    const secretKey = "llm.apiKey.openai";
    const { manifest, manifestSha256 } = granted(pluginId, secretKey);
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === secretKey ? "fresh-admin-secret" : undefined
    );
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      pluginId,
      manifest,
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-fresh-admin-"))),
      activeIncarnation(),
      "marketplace-fresh-install",
      { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );

    expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
    expect(runtimeTestState.readPluginRegistry).toHaveBeenCalledOnce();
  });

  it("rejects issuance when configuration changes while the provenance gate is pending", async () => {
    const { manifest, manifestSha256 } = granted("meeting", "llm.apiKey.openai");
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "llm.apiKey.openai" ? "host-secret-value" : undefined);
    let revision = 0;
    const listeners = new Set<() => void>();
    settings.getProviderConfigRevision = () => revision;
    settings.onLeaseStateChanged = (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    let passGate: ((pins: string[]) => void) | undefined;
    runtimeTestState.officialPins.mockImplementationOnce(() =>
      new Promise((resolve) => { passGate = resolve; }));
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-issuing-"))),
      activeIncarnation(), "meeting",
      { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    const pending = api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    await vi.waitFor(() => expect(runtimeTestState.officialPins).toHaveBeenCalledOnce());
    revision += 1;
    for (const listener of listeners) listener();
    passGate!(["a".repeat(64)]);
    await expect(pending).resolves.toEqual({ ok: false, reason: "stale-authorization" });
  });

  it("rejects issuance when the host key rotates during the secret read", async () => {
    const { manifest, manifestSha256 } = granted("meeting", "llm.apiKey.openai");
    const settings = makeSettingsService(new Map());
    let generation = 0;
    const listeners = new Set<() => void>();
    settings.getSecretGeneration = () => generation;
    settings.onLeaseStateChanged = (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    settings.getSecret.mockImplementation((key: string) => {
      if (key !== "llm.apiKey.openai") return undefined;
      generation += 1;
      for (const listener of listeners) listener();
      return "host-secret-value";
    });
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-secret-read-"))),
      activeIncarnation(), "meeting",
      { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    await expect(api.resolveApiKey({ purpose: "llm", vendor: "openai" }))
      .resolves.toEqual({ ok: false, reason: "stale-authorization" });
  });

  it.each(
    (["before-gate", "after-gate", "after-secret-read", "before-reply"] as const)
      .flatMap((stage) => (["rotate", "revoke", "endpoint-switch", "retire"] as const)
        .map((change) => ({ stage, change }))),
  )("fences issuance at $stage after $change", async ({ stage, change }) => {
    const root = tmpDirs.track(mkdtempSync("/tmp/ave-lease-stage-"));
    const settings = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    await settings.patch({ llm: { provider: "openai", vendors: { openai: { baseUrl: "https://api.openai.com" } } } } as never);
    await settings.setSecret("llm.apiKey.openai", "synthetic-secret");
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    const disposers: Array<() => void> = [];
    let active = true;
    let reached = 0;
    const createHostApi = await initAndGetFactory(settings, undefined, undefined, undefined, {
      permissionManager,
      onCredentialIssuanceStage: async (at) => {
        if (at !== stage) return;
        reached += 1;
        if (change === "rotate") await settings.setSecret("llm.apiKey.openai", "rotated-secret");
        else if (change === "revoke") permissionManager.revokePluginAccess("meeting", "test withdrawal");
        else if (change === "endpoint-switch") {
          await settings.patch({ llm: { vendors: { openai: { baseUrl: "https://replacement.example.test" } } } } as never);
        } else {
          active = false;
          for (const dispose of disposers) dispose();
        }
      },
    });
    const { manifest, manifestSha256 } = granted(
      "meeting", "llm.apiKey.openai", ["api.openai.com", "replacement.example.test"],
    );
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-stage-plugin-"))),
      {
        registerDisposer: (dispose: () => void) => { disposers.push(dispose); },
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () => active,
        isLifecycleHookActive: () => false,
      },
      "meeting", { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    const result = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    expect(reached).toBe(1);
    expect(result).toEqual({ ok: false, reason: "stale-authorization" });
  });

  it("fences issuance when a provider preset is installed after the secret read", async () => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-preset-install-")));
    const settings = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    await settings.setSecret("llm.apiKey.openai", "synthetic-key");
    const preset = {
      providerId: "fixture-router", label: "Fixture Router", baseUrl: "https://router.example.test/v1",
      defaultModel: "fixture", modelOptions: ["fixture"], requiresApiKey: true,
    };
    const createHostApi = await initAndGetFactory(settings, undefined, undefined, undefined, {
      onCredentialIssuanceStage: async (stage) => {
        if (stage === "after-secret-read") await settings.installMarketplaceProviderPreset(preset);
      },
    });
    const { manifest, manifestSha256 } = granted("meeting", "llm.apiKey.openai");
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(root), activeIncarnation(), "meeting",
      { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" }))
      .toEqual({ ok: false, reason: "stale-authorization" });
  });

  it.each(["update", "uninstall"] as const)("closes a lease when a provider preset is %s", async (change) => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-preset-change-")));
    const settings = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    await settings.setSecret("llm.apiKey.openai", "synthetic-key");
    const preset = {
      providerId: "fixture-router", label: "Fixture Router", baseUrl: "https://router.example.test/v1",
      defaultModel: "fixture", modelOptions: ["fixture"], requiresApiKey: true,
    };
    await settings.installMarketplaceProviderPreset(preset);
    const transport = vi.fn(async () => new Response(null));
    const createHostApi = await initAndGetFactory(settings, undefined, transport as typeof fetch);
    const { manifest, manifestSha256 } = granted("meeting", "llm.apiKey.openai");
    manifest.capabilities = ["external-auth-consumer"];
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(root), activeIncarnation(), "meeting",
      { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    const lease = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    if (!lease.ok || lease.exposure !== "lease") throw new Error("lease missing");
    const closed = vi.fn();
    lease.onClosed(closed);
    if (change === "update") await settings.installMarketplaceProviderPreset({ ...preset, baseUrl: "https://other.example.test/v1" });
    else await settings.uninstallMarketplaceProviderPreset(preset.providerId);
    expect(closed).toHaveBeenCalledWith("revoked");
    await expect(api.hostFetch("https://api.openai.com/v1/models", { auth: { lease: lease.leaseId } }))
      .rejects.toMatchObject({ code: "lease-unavailable" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports caller cancellation during issuance as aborted", async () => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-abort-")));
    const settings = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    await settings.setSecret("llm.apiKey.openai", "synthetic-key");
    const controller = new AbortController();
    const createHostApi = await initAndGetFactory(settings, undefined, undefined, undefined, {
      onCredentialIssuanceStage: (stage) => { if (stage === "after-gate") controller.abort(); },
    });
    const { manifest, manifestSha256 } = granted("meeting", "llm.apiKey.openai");
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(root), activeIncarnation(), "meeting",
      { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai", signal: controller.signal } as never))
      .toEqual({ ok: false, reason: "aborted" });
  });

  it("refuses an own key when the plugin audience is empty", async () => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-empty-audience-")));
    const settings = new SettingsService({
      userDataPath: root,
      encryption: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "external_key",
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
    });
    await settings.setSecret("plugin.plugin-a.llm.apiKey.openai", "synthetic-key");
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi("plugin-a", { id: "plugin-a", networkAccess: { allowedDomains: [] } }, pluginDataDirIn(root), activeIncarnation(), "plugin-a");
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" }))
      .toEqual({ ok: false, reason: "audience-not-allowlisted" });
  });

  it("denies unsupported sources and a host endpoint that has not been configured", async () => {
    const settings = makeSettingsService(new Map());
    settings.get.mockImplementation((key: string) => {
      if (key === "llm") return { provider: "azure-foundry", vendors: {} };
      if (key === "marketplace") return { installedProviderPresets: [] };
      if (key === "pluginConfigs") return {};
      return undefined;
    });
    settings.getSecret.mockImplementation((key: string) =>
      key === "llm.apiKey.azure-foundry" ? "host-secret-value" : undefined);
    const { manifest, manifestSha256 } = granted("meeting", "llm.apiKey.azure-foundry", ["azure.example.test"]);
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-source-table-"))), activeIncarnation(),
      "meeting", { installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN },
    );
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "vertex" }))
      .toEqual({ ok: false, reason: "vendor-unsupported" });
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "azure-openai" }))
      .toEqual({ ok: false, reason: "endpoint-unavailable" });
    const gemini = await api.resolveApiKey({ purpose: "llm", vendor: "gemini" as "openai" });
    expect(gemini).toEqual({ ok: false, reason: "vendor-unsupported" });
  });

  it("re-reads a registry entry another writer bound after the plugin started", async () => {
    // Background origin migration emits no install event.
    const dir = tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-registry-"));
    runtimeTestState.registryPath = join(dir, "registry.json");
    try {
      const secretKey = "llm.apiKey.openai";
      const { manifest, manifestSha256 } = granted("meeting", secretKey);
      const entry = { id: "meeting", manifestPath: "meeting/plugin.json", installSource: "user", manifestSha256 };
      writeFileSync(runtimeTestState.registryPath, "unbound");
      runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [entry] });
      const settings = makeSettingsService(new Map());
      settings.getSecret.mockImplementation((key: string) => (key === secretKey ? "bound-secret" : undefined));
      const createHostApi = await initAndGetFactory(settings);
      const api = createHostApi("meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-bound-"))), activeIncarnation(), "meeting");

      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: false, reason: "not-whitelisted" });

      runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [{ ...entry, origin: OFFICIAL_ORIGIN }] });
      writeFileSync(runtimeTestState.registryPath, "bound to the official source");
      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
    } finally {
      runtimeTestState.registryPath = "/tmp/ave-test/registry.json";
    }
  });

  it("lets a committed candidate see a registry entry bound after it started", async () => {
    // Re-enabled legacy entries have no origin until migration binds one.
    const dir = tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-candidate-bound-"));
    runtimeTestState.registryPath = join(dir, "registry.json");
    try {
      const secretKey = "llm.apiKey.openai";
      const { manifest, manifestSha256 } = granted("meeting", secretKey);
      const entry = { id: "meeting", manifestPath: "meeting/plugin.json", installSource: "user", manifestSha256 };
      writeFileSync(runtimeTestState.registryPath, "unbound");
      runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [entry] });
      const settings = makeSettingsService(new Map());
      settings.getSecret.mockImplementation((key: string) => (key === secretKey ? "bound-secret" : undefined));
      const createHostApi = await initAndGetFactory(settings);
      const api = createHostApi(
        "meeting",
        manifest,
        pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-candidate-"))),
        activeIncarnation(),
        "meeting",
        { installSource: "user", manifestSha256 },
      );

      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: false, reason: "not-whitelisted" });

      runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [{ ...entry, origin: OFFICIAL_ORIGIN }] });
      writeFileSync(runtimeTestState.registryPath, "bound to the official source");
      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
    } finally {
      runtimeTestState.registryPath = "/tmp/ave-test/registry.json";
    }
  });

  it("never lends a candidate from another source the registry's official origin", async () => {
    const secretKey = "llm.apiKey.openai";
    const { manifest, manifestSha256 } = granted("meeting", secretKey);
    runtimeTestState.readPluginRegistry.mockResolvedValue({
      version: 1,
      plugins: [{ id: "meeting", manifestPath: "meeting/plugin.json", installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN }],
    });
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) => (key === secretKey ? "official-secret" : undefined));
    const createHostApi = await initAndGetFactory(settings);
    const candidate = (entry: PluginRegistryTrust) =>
      createHostApi("meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-other-"))), activeIncarnation(), "meeting", entry);

    const custom = { ...OFFICIAL_ORIGIN, sourceId: "team-mirror", sourceOrigin: "custom" as const };
    expect(await candidate({ installSource: "user", manifestSha256, origin: custom }).resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: false, reason: "not-whitelisted" });
    expect(await candidate({ installSource: "local-dev", manifestSha256 }).resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: false, reason: "not-whitelisted" });
    expect(await candidate({ installSource: "user", manifestSha256, origin: OFFICIAL_ORIGIN }).resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
  });

  it("compares the pin with the running document, never with the flat projection", async () => {
    const secretKey = "llm.apiKey.openai";
    const { manifest, manifestSha256 } = granted("meeting", secretKey);
    const unread = { id: "meeting", config: {}, hostSecrets: { read: [secretKey] }, networkAccess: { allowedDomains: ["api.openai.com"] } } as unknown as PluginManifest;
    const projectionSha256 = createHash("sha256").update(canonicalJSON(unread)).digest("hex");
    expect(projectionSha256).not.toBe(manifestSha256);
    const call = async (running: PluginManifest, pin: string) => {
      runtimeTestState.readPluginRegistry.mockResolvedValue({
        version: 1,
        plugins: [{ id: "meeting", manifestPath: "meeting/plugin.json", installSource: "user", manifestSha256: pin, origin: OFFICIAL_ORIGIN }],
      });
      const settings = makeSettingsService(new Map());
      settings.getSecret.mockImplementation((key: string) => (key === secretKey ? "official-secret" : undefined));
      const createHostApi = await initAndGetFactory(settings);
      return createHostApi("meeting", running, pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-hostapi-pin-"))), activeIncarnation(), "meeting").resolveApiKey({ purpose: "llm", vendor: "openai" });
    };

    expect(await call(manifest, manifestSha256)).toMatchObject({ ok: true, exposure: "lease" });
    // A manifest not read from a document matches no pin, not even one taken over its projection.
    expect(await call(unread, projectionSha256)).toMatchObject({ ok: false, reason: "not-whitelisted" });
  });

  it("delivers an emitted event to a same-plugin subscriber with the pluginId injected, and unsubscribe stops delivery", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: [] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-evt-"))),
      activeIncarnation(),
      "plugin-a",
    );

    const handler = vi.fn();
    const unsubscribe = api.onEvent("plugin-a.updated", handler);

    api.emitEvent("plugin-a.updated", { value: 7 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ value: 7, pluginId: "plugin-a" });

    unsubscribe();
    api.emitEvent("plugin-a.updated", { value: 8 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops delivering host notifications into a live incarnation once the runtime begins shutting down", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: [] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-evt-shutdown-"))),
      activeIncarnation(),
      "plugin-a",
    );
    const eventHandler = vi.fn();
    const pluginsChanged = vi.fn();
    api.onEvent("plugin-a.updated", eventHandler);
    api.onPluginsChanged(pluginsChanged);

    api.emitEvent("plugin-a.updated", { value: 1 });
    expect(eventHandler).toHaveBeenCalledTimes(1);

    // The incarnation is still active; only the runtime's shutdown has begun.
    runtimeTestState.runtime.isShuttingDown.mockReturnValue(true);
    try {
      api.emitEvent("plugin-a.updated", { value: 2 });
      emitHostEvent("plugin.installed", { pluginId: "plugin-b", source: "marketplace" });
      emitHostEvent("plugin.uninstalled", { pluginId: "plugin-b" });
    } finally {
      runtimeTestState.runtime.isShuttingDown.mockReturnValue(false);
    }
    expect(eventHandler).toHaveBeenCalledTimes(1);
    expect(pluginsChanged).not.toHaveBeenCalled();
    emitHostEvent("plugin.installed", { pluginId: "plugin-b", source: "marketplace" });
    expect(pluginsChanged).toHaveBeenCalledWith({ type: "installed", pluginId: "plugin-b", source: "marketplace" });
  });

  it("gives a worker only the floor pierces its plugin's reviewed declaration asked for", async () => {
    // Only host-interpreted manifest grants can name reads inside the protected floor.
    runtimeTestState.spawnWorker.mockResolvedValue({
      socketPath: null, pid: 7, stop: vi.fn(), onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn(),
    });
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()));
    const lifecycle = {
      registerDisposer: () => {},
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
    };
    const spawnFor = async (sandbox?: unknown) => {
      runtimeTestState.spawnWorker.mockClear();
      const api = createHostApi(
        "plugin-a",
        { id: "plugin-a", config: {}, ...(sandbox ? { sandbox } : {}) } as never,
        pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-worker-pierces-"))),
        lifecycle,
        "plugin-a",
      );
      await api.spawnWorker({ workerId: "w", command: "node", floorPierces: ["/"] } as never);
      return (runtimeTestState.spawnWorker.mock.calls[0]?.[0] as { floorPierces?: string[] }).floorPierces;
    };
    expect(await spawnFor()).toEqual([]);
    expect(await spawnFor({
      read: [
        { kind: "hostDirectory", segments: ["runtime"], why: "runtime" },
        { kind: "hostDirectory", segments: ["certs"], why: "trust anchors" },
      ],
    })).toEqual([join(aveHome(), "certs")]);
  });

  it("releases returned API-key and worker capabilities when the incarnation is disposed", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai"
        ? "sk-incarnation"
        : undefined,
    );
    const workerStop = vi.fn();
    const workerOnStdout = vi.fn();
    const workerOnStderr = vi.fn();
    const workerOnExit = vi.fn();
    runtimeTestState.spawnWorker.mockResolvedValue({
      socketPath: "/tmp/plugin-a.sock",
      pid: 42,
      stop: workerStop,
      onStdout: workerOnStdout,
      onStderr: workerOnStderr,
      onExit: workerOnExit,
    });
    const disposers: Array<() => void> = [];
    let active = true;
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, networkAccess: { allowedDomains: ["api.openai.com"] } },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-issued-capabilities-"))),
      {
        registerDisposer: (dispose) => disposers.push(dispose),
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () => active,
        isLifecycleHookActive: () => false,
      },
      "plugin-a",
    );

    const key = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    expect(key.ok).toBe(true);
    if (!key.ok) throw new Error("expected API key capability");
    expect(key.exposure).toBe("lease");
    if (key.exposure !== "lease") throw new Error("expected lease");
    expect(key.leaseId).toMatch(/^lease_/);
    const worker = await api.spawnWorker({
      workerId: "worker-a",
      command: "node",
    });
    const stdoutListener = vi.fn();
    const stderrListener = vi.fn();
    const exitListener = vi.fn();
    worker.onStdout(stdoutListener);
    worker.onStderr(stderrListener);
    worker.onExit(exitListener);

    workerOnStdout.mock.calls[0]?.[0]("before");
    workerOnStderr.mock.calls[0]?.[0]("before-error");
    workerOnExit.mock.calls[0]?.[0]({ code: 0, signal: null });
    expect(stdoutListener).toHaveBeenCalledWith("before");
    expect(stderrListener).toHaveBeenCalledWith("before-error");
    expect(exitListener).toHaveBeenCalledWith({ code: 0, signal: null });
    stdoutListener.mockClear();
    stderrListener.mockClear();
    exitListener.mockClear();

    active = false;
    for (const dispose of disposers) dispose();

    await expect(key.release()).resolves.toBeUndefined();
    expect(() => worker.onStdout(vi.fn())).toThrow(
      /plugin instance is no longer active/,
    );
    workerOnStdout.mock.calls[0]?.[0]("after");
    workerOnStderr.mock.calls[0]?.[0]("after-error");
    workerOnExit.mock.calls[0]?.[0]({ code: null, signal: "SIGTERM" });
    expect(stdoutListener).not.toHaveBeenCalled();
    expect(stderrListener).not.toHaveBeenCalled();
    expect(exitListener).not.toHaveBeenCalled();
    expect(workerStop).toHaveBeenCalledTimes(1);
    worker.stop();
    expect(workerStop).toHaveBeenCalledTimes(1);
  });

  it("denies raw exposure before reading even an own-namespace key without a current review receipt", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockReturnValue("synthetic-secret");
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["secrets:raw-api-key"] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-raw-denial-"))),
      activeIncarnation(),
      "plugin-a",
    );
    expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai", exposure: "raw" }))
      .toEqual({ ok: false, reason: "raw-exposure-denied" });
    expect(settings.getSecret).not.toHaveBeenCalled();
  });

  it("returns one raw copy only after the reviewed capability and keeps its release id", async () => {
    runtimeTestState.receiptReviewedAppVersion.mockResolvedValue("0.12.0");
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    const createHostApi = await initAndGetFactory(settings);
    const api = createHostApi(
      "plugin-a", { id: "plugin-a", config: {}, capabilities: ["secrets:raw-api-key"] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-raw-grant-"))), activeIncarnation(), "plugin-a",
    );
    const result = await api.resolveApiKey({ purpose: "llm", vendor: "openai", exposure: "raw" });
    expect(result).toMatchObject({ ok: true, exposure: "raw", key: "synthetic-secret" });
    if (!result.ok || result.exposure !== "raw") throw new Error("expected raw result");
    expect((result as typeof result & { handleId: string }).handleId).toMatch(/^raw_/);
    await result.release();
    await expect(result.release()).resolves.toBeUndefined();
  });

  it("attaches a lease at the factory and keeps auth out of the transport init", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    const transport = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const createHostApi = await initAndGetFactory(settings, { log: vi.fn() }, transport);
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["api.openai.com"] } },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-egress-"))),
      activeIncarnation(),
      "plugin-a",
    );
    const result = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.exposure !== "lease") throw new Error("expected lease");
    let methodReads = 0;
    let leaseReads = 0;
    const headers = new Headers({ "x-request-id": "before" });
    const init = {
      auth: { get lease() { leaseReads += 1; return leaseReads === 1 ? result.leaseId : "foreign"; } },
      headers,
      get method() { methodReads += 1; return methodReads === 1 ? "GET" : "POST"; },
    };
    const pending = api.hostFetch("https://api.openai.com/v1/models", init);
    headers.set("cookie", "late=mutation");
    headers.set("x-request-id", "after");
    const response = await pending;
    expect(await response.text()).toBe("ok");
    expect(methodReads).toBe(1);
    expect(leaseReads).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const networkInit = (transport as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit & { auth?: unknown };
    expect(networkInit.auth).toBeUndefined();
    expect(networkInit.method).toBe("GET");
    expect(new Headers(networkInit.headers).get("authorization")).toBe("Bearer synthetic-secret");
    expect(new Headers(networkInit.headers).get("cookie")).toBeNull();
    expect(new Headers(networkInit.headers).get("x-request-id")).toBe("before");
    expect(JSON.stringify(networkInit)).not.toContain(result.leaseId);
    for (const header of ["Authorization", "Proxy-Authorization", "Cookie", "api-key", "x-api-key", "ocp-apim-subscription-key"]) {
      await expect(api.hostFetch("https://api.openai.com/v1/models", {
        auth: { lease: result.leaseId }, headers: { [header]: "caller-secret" },
      })).rejects.toMatchObject({ code: "credential-conflict" });
    }
    expect(transport).toHaveBeenCalledTimes(1);
    await api.hostFetch("https://api.openai.com/v1/models", { headers: { Authorization: "Bearer plugin-owned" } });
    expect(new Headers(((transport as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as RequestInit).headers)
      .get("authorization")).toBe("Bearer plugin-owned");
  });

  it.each(
    [false, true].flatMap((lease) => [false, true].flatMap((partition) =>
      [false, true].map((callerCookie) => ({ lease, partition, callerCookie })))),
  )("applies the cookie matrix with lease=$lease partition=$partition callerCookie=$callerCookie", async ({
    lease, partition, callerCookie,
  }) => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    const transport = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(null));
    const getAuthPartition = vi.fn(() => ({ cookies: { get: vi.fn(async () => [
      { name: "SID", value: "host-cookie", domain: "api.openai.com", path: "/" },
    ]) } }));
    const createHostApi = await initAndGetFactory(
      settings, undefined, transport as unknown as typeof fetch, undefined, { getAuthPartition },
    );
    const api = createHostApi(
      "plugin-a",
      {
        id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"],
        networkAccess: {
          allowedDomains: ["api.openai.com"],
          ...(partition ? { authCookiePartition: "main" } : {}),
        },
      },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-cookie-matrix-"))), activeIncarnation(), "plugin-a",
    );
    const resolved = lease ? await api.resolveApiKey({ purpose: "llm", vendor: "openai" }) : null;
    if (lease && (!resolved?.ok || resolved.exposure !== "lease")) throw new Error("expected lease");
    const init = {
      ...(lease && resolved?.ok && resolved.exposure === "lease" ? { auth: { lease: resolved.leaseId } } : {}),
      ...(callerCookie ? { headers: { Cookie: "caller-cookie" } } : {}),
    };
    const pendingFetch = api.hostFetch("https://api.openai.com/v1/models", init);
    if (lease && callerCookie) await expect(pendingFetch).rejects.toMatchObject({ code: "credential-conflict" });
    else if (partition && callerCookie) await expect(pendingFetch).rejects.toThrow(/must not send its own Cookie/);
    else await expect(pendingFetch).resolves.toBeInstanceOf(Response);
    const refused = callerCookie && (lease || partition);
    expect(transport).toHaveBeenCalledTimes(refused ? 0 : 1);
    expect(getAuthPartition).toHaveBeenCalledTimes(partition && !callerCookie ? 1 : 0);
    if (refused) return;
    const networkInit = transport.mock.calls[0]?.[1] as RequestInit & { auth?: unknown };
    const headers = new Headers(networkInit.headers);
    expect(networkInit.auth).toBeUndefined();
    expect(headers.get("authorization")).toBe(lease ? "Bearer synthetic-secret" : null);
    expect(headers.get("cookie")).toBe(partition ? "SID=host-cookie" : callerCookie ? "caller-cookie" : null);
    // The vaulted cookie replays under the same identity it was minted with: net.request takes app.userAgentFallback (set at boot).
    expect(headers.has("user-agent")).toBe(false);
  });

  it("audits a lease revoked after response headers but before body consumption", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    let generation = 0;
    const listeners = new Set<() => void>();
    settings.getSecretGeneration = () => generation;
    settings.onLeaseStateChanged = (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    const auditLog = vi.fn();
    const createHostApi = await initAndGetFactory(
      settings, { log: auditLog }, vi.fn(async () => new Response("body")) as unknown as typeof fetch,
    );
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["api.openai.com"] } },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-body-audit-"))), activeIncarnation(), "plugin-a",
    );
    const result = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    if (!result.ok || result.exposure !== "lease") throw new Error("expected lease");
    const response = await api.hostFetch("https://api.openai.com/v1/models", { auth: { lease: result.leaseId } });
    generation += 1;
    for (const listener of listeners) listener();
    await expect(response.text()).rejects.toMatchObject({ code: "lease-unavailable" });
    const denials = auditLog.mock.calls.map(([entry]) => entry as { type: string; input: string })
      .filter((entry) => entry.type === "plugin_hostapi_denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]?.input).toContain("code=lease-unavailable count=1 stage=after-await");
  });

  it("refuses a lease revoked while a mutating request waits for approval", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    const originalGet = settings.get.getMockImplementation()!;
    settings.get.mockImplementation((key: string) =>
      key === "features" ? { hostClassifiesRisk: true } : originalGet(key));
    let revision = 0;
    const listeners = new Set<() => void>();
    settings.getProviderConfigRevision = () => revision;
    settings.onLeaseStateChanged = (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    };
    let approve: ((decision: { choice: "allow-once" }) => void) | undefined;
    const approvalGate = {
      requestAndWait: vi.fn(() => new Promise((resolve) => { approve = resolve as typeof approve; })),
    };
    const transport = vi.fn(async () => new Response("sent")) as unknown as typeof fetch;
    const createHostApi = await initAndGetFactory(settings, { log: vi.fn() }, transport, approvalGate);
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["api.openai.com"] } },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-approval-"))), activeIncarnation(), "plugin-a",
    );
    const result = await api.resolveApiKey({ purpose: "llm", vendor: "openai" });
    if (!result.ok || result.exposure !== "lease") throw new Error("expected lease");
    const pending = runWithEffectGateContext(
      { headless: false, approvalSurface: "interactive", toolName: "sample" },
      () => api.hostFetch("https://api.openai.com/v1/models", {
        method: "POST", auth: { lease: result.leaseId },
      }),
    );
    await vi.waitFor(() => expect(approvalGate.requestAndWait).toHaveBeenCalledOnce());
    expect(approve).toBeDefined();
    revision += 1;
    for (const listener of listeners) listener();
    approve!({ choice: "allow-once" });
    await expect(pending).rejects.toMatchObject({ code: "lease-unavailable" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("carries a lease through child, dispatcher and factory into the gated transport", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    const transport = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const createHostApi = await initAndGetFactory(settings, { log: vi.fn() }, transport);
    const manifest = {
      id: "plugin-a", name: "Sample", version: "1.0.0", entry: "dist/plugin.js",
      description: "sample", tools: [], config: {},
      capabilities: ["external-auth-consumer"],
      networkAccess: { allowedDomains: ["api.openai.com"] },
    } as PluginManifest;
    const api = createHostApi(
      "plugin-a", manifest,
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-lease-wire-"))), activeIncarnation(), "plugin-a",
    );
    let host!: HostApiDispatcher;
    let child!: Awaited<ReturnType<typeof startPluginChildRuntime>>;
    const channel = directHostApiChannel({
      handle: (request) => host.handle(request),
      handleNotification: (notification) => host.handleNotification(notification),
    });
    host = new HostApiDispatcher({
      log: vi.fn(), pluginId: "plugin-a", isActive: () => true, reportUnknownField: vi.fn(),
      shutdownChild: (id) => child.runShutdownHandler(id),
      notifications: { deliver: (notification) => { child.deliver(notification); } },
      table: {
        ...HOSTAPI_DISPATCH_TABLE,
        ...createServiceHostApiPaths(api as unknown as PluginHostApi, { read: [], write: [] }),
      },
    });
    child = await startPluginChildRuntime({
      input: new PassThrough(), output: new PassThrough(), manifest,
      context: {
        pluginId: "plugin-a", pluginRoot: "/plugins/a", hostRoot: "/app",
        pluginDataDir: "/plugins/a/data", userHome: "/Users/example",
        aveHome: "/Users/example/.ave", installedPluginIds: [],
      },
      channel,
      loadFactory: async () => () => ({ handlers: {} }),
    });
    const key = await child.hostApi.resolveApiKey!({ purpose: "llm", vendor: "openai" });
    expect(key).toMatchObject({ ok: true, exposure: "lease" });
    if (!key.ok || key.exposure !== "lease") throw new Error("expected lease");
    const response = await child.hostApi.hostFetch!("https://api.openai.com/v1/models", { auth: { lease: key.leaseId } });
    expect(await response.text()).toBe("ok");
    const networkInit = (transport as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit & { auth?: unknown };
    expect(networkInit.auth).toBeUndefined();
    expect(new Headers(networkInit.headers).get("authorization")).toBe("Bearer synthetic-secret");
    expect(JSON.stringify(networkInit)).not.toContain(key.leaseId);
    await key.release();
  });

  it("audits a capability-denied emit from the production HostApi emit closure", async () => {
    // Emit authorization comes from emittedEvents; capabilities must not unlock it.
    const bootAuditLogger = { log: vi.fn() };
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
      bootAuditLogger,
    );
    const api = createHostApi(
      "plugin-a",
      {
        id: "plugin-a",
        config: {},
        capabilities: ["mail-source"],
        emittedEvents: ["plugin-a.updated"],
      },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-emit-denied-"))),
      activeIncarnation(),
      "plugin-a",
    );

    expect(() => api.emitEvent("email.new", { subject: "hi" })).toThrow(
      /not allowed to emit undeclared event 'email\.new'/,
    );

    const denials = bootAuditLogger.log.mock.calls
      .map(([entry]) => entry as { sessionId: string; type: string; input: string })
      .filter((entry) =>
        String(entry?.input ?? "").includes("plugin_emit_capability_denied"),
      );
    expect(denials).toHaveLength(1);
    expect(denials[0].sessionId).toBe("plugin");
    expect(denials[0].type).toBe("error");
    expect(denials[0].input).toBe(
      "[plugin:plugin-a] plugin_emit_capability_denied eventType=email.new"
      + " required=mail-source declaredEmittedEvents=plugin-a.updated",
    );

    api.emitEvent("plugin-a.updated", { value: 1 });
    expect(
      bootAuditLogger.log.mock.calls.filter(([entry]) =>
        String((entry as { input?: string })?.input ?? "")
          .includes("plugin_emit_capability_denied"),
      ),
    ).toHaveLength(1);
  });

  it("revokes every callable HostApi surface when its incarnation is deactivated", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    let active = true;
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, emittedEvents: ["plugin-a.updated"] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-revoked-hostapi-"))),
      {
        registerDisposer: vi.fn(),
        trackOperation: <T>(operation: Promise<T>) => operation,
        isActive: () => active,
        isLifecycleHookActive: () => false,
      },
      "plugin-a",
    );
    expect(api.config.get("before")).toBeUndefined();

    active = false;
    expect(() => api.config.get("after")).toThrow(
      /plugin instance is no longer active/,
    );
    expect(() => api.getSecret("token")).toThrow(
      /plugin instance is no longer active/,
    );
    expect(() => api.emitEvent("plugin-a.updated", {})).toThrow(
      /plugin instance is no longer active/,
    );
    expect(() => api.onEvent("plugin-a.updated", vi.fn())).toThrow(
      /plugin instance is no longer active/,
    );
  });
});
