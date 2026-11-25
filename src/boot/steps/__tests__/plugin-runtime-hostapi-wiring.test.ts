import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { createBootHostFixture, createDesktopHostFixture } from "../../../__tests__/support/host-runtime.js";
import { directHostFetchTransport } from "../../../__tests__/support/host-fetch-transport.js";
/** Drive the captured boot HostApi factory so config precedence and capability lifetimes are tested at their producer. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aveHome } from "../../../shared/ave-home.js";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import { cleanupTmpDir, createTmpDirTracker } from "../../../__tests__/support/tmp-dir-teardown.js";
import { directHostApiChannel } from "../../../__tests__/support/host-protocol-wire.js";
import { HOSTAPI_DISPATCH_TABLE, HostApiDispatcher, createServiceHostApiPaths } from "../../../plugins/isolation/host-api-dispatcher.js";
import { startPluginChildRuntime } from "../../../plugins/isolation/plugin-child-runtime.js";
import type { PluginHostApi } from "../../../plugins/types.js";
import { EffectBoundaryDeniedError, runWithEffectGateContext } from "../../../permissions/effect-enforcement.js";
import {
  __resetExtensionStartsForTest, ExtensionStartConsentRequiredError, listPendingExtensionStarts, setExtensionStartAsker, type ExtensionStartAsker,
} from "../../../permissions/extension-start-consent.js";
import { backgroundEffectSubject, PluginBackgroundEffectApprovals } from "../../../plugins/plugin-background-effects.js";
import { SettingsService } from "../../../data/settings-store.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import type { CredentialIssuanceStage } from "../../../main/host-api/resolve-api-key.js";

const tmpDirs = createTmpDirTracker();

// Fixture paths live under the configured test temp root; vi.mock factories read them through this hoisted value.
const fixture = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "ave-test-"));
  return { root, path: (...parts: string[]) => join(root, ...parts) };
});
afterAll(() => cleanupTmpDir(fixture.root));

const runtimeTestState = vi.hoisted(() => ({
  browserWindows: [] as Array<{ isDestroyed: () => boolean; webContents: { send: (channel: string, payload: unknown) => void };
  }>,
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async (): Promise<{ version: number; plugins: unknown[] }> => ({ version: 1, plugins: [] })),
  receiptReviewedAppVersion: vi.fn(async (): Promise<string | null> => null),
  officialPins: vi.fn(async () => ["a".repeat(64)]),
  /** The registry file whose identity the HostApi's entry cache watches. */
  registryPath: fixture.path("registry.json"),
  spawnWorker: vi.fn(),
  runtime: {
    // Install partition policies before starting any plugin.
    load: vi.fn(async () => {}),
    startAll: vi.fn(async () => {}),
    listToolNames: vi.fn(() => [] as string[]),
    listPluginIds: vi.fn(() => [] as string[]),
    listPluginManifests: vi.fn(() => [] as Array<{ pluginId: string; manifest: unknown }>,
    ),
    getPluginRoot: vi.fn((pluginId: string) => fixture.path("plugins", pluginId),
    ),
    getPluginManifest: vi.fn(() => null),
    resolvePluginInstallId: vi.fn((pluginId: string) => pluginId),
    isPluginEnabled: vi.fn(() => true),
    getApprovedPluginAccess: vi.fn(() => undefined),
    registerDisposer: vi.fn(),
    isShuttingDown: vi.fn(() => false),
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
    getPath: vi.fn(() => fixture.root),
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

vi.mock("../../../permissions/worker-spawn.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/worker-spawn.js")>(),
  spawnWorker: runtimeTestState.spawnWorker,
}));

vi.mock("../../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: fixture.path("plugins"),
    registryPath: runtimeTestState.registryPath,
    cacheRoot: fixture.path("cache"),
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
import { withPluginInstallLock } from "../../../plugins/install-lifecycle.js";
import type { PluginRegistryEntry, PluginRegistryTrust } from "../../../plugins/types.js";
import { HostApiGenerationScope } from "../../../plugins/plugin-host-effect-scope.js";
import { settleMacrotask } from "../../../__tests__/test-helpers.js";
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
    onChange: (key: string, callback: (value: unknown) => void) => () => void;
  };
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
  hostFetch: (input: string, init?: RequestInit & { auth?: { lease: string } }) => Promise<Response>;
  spawnWorker: (spec: { workerId: string; command: string; control: "output-only-v1" }) => Promise<{
    control: "output-only-v1";
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
    hostSecrets?: { read?: string[] };
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
    generationScope?: HostApiGenerationScope;
  },
  installPluginId: string | null,
  candidateRegistryEntry?: PluginRegistryTrust,
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
    backgroundEffectApprovals?: PluginBackgroundEffectApprovals;
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
    projectRoot: fixture.path("project"),
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
    getAlertsService: () => undefined,
    ...(options.backgroundEffectApprovals ? { backgroundEffectApprovals: options.backgroundEffectApprovals } : {}),
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

function leaseSettingsOptions(root: string) {
  return {
    userDataPath: root,
    encryption: {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => "external_key" as const,
      encryptStringAsync: async (value: string) => Buffer.from(value),
      decryptStringAsync: async (value: Buffer) => ({ shouldReEncrypt: false, result: value.toString() }),
    },
  };
}

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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-missing-provenance-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-cfg-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-cfg-def-")))),
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
      mkdtempSync(join(tmpdir(), `ave-storage-audit-boot-${"x".repeat(64)}-`)),
    ));
    const outsideDir = tmpDirs.track(
      mkdtempSync(join(tmpdir(), `ave-storage-audit-boot-out-${"x".repeat(64)}-`)),
    );
    writeFileSync(join(outsideDir, "secret.txt"), "shhh", "utf-8");
    symlinkSync(outsideDir, join(resolvePluginHostStorageDir(dataDir), "escape"), dirLinkType);

    const api = createHostApi(
      "alice",
      { id: "alice", config: {} },
      dataDir,
      activeIncarnation(),
      "alice",
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
    const serializedOutput = refusals[0]?.output ?? "";
    expect(serializedOutput.length).toBeLessThanOrEqual(500);
    const payload = JSON.parse(serializedOutput) as Record<string, unknown>;
    expect(payload).toMatchObject({
      truncated: true,
      originalLength: expect.any(Number),
      pluginId: "alice",
      reason: "storage: rejected symlink escape",
      preview: expect.any(String),
    });
    expect(payload.originalLength).toBeGreaterThan(500);
  });
  it("preserves short runtime audit metadata", async () => {
    await initAndGetFactory(makeSettingsService(new Map()));
    const auditLog = runtimeTestState.capturedRuntimeOptions?.auditLog as (level: string, message: string, data: unknown) => void;
    const data = { pluginId: "plugin-a", reason: "fixture refusal" };
    auditLog("error", "fixture_refusal", data);
    const entry = lastBootAuditLogger.log.mock.calls.at(-1)?.[0] as { output?: string } | undefined;
    const output = entry?.output ?? "";
    expect(JSON.parse(output)).toEqual(data);
  });

  it.each([
    { name: "long path", detail: `D:\\fixtures\\${"long-root\\".repeat(40)}output` },
    { name: "escaped text", detail: '"\\\r\n😀'.repeat(150) },
  ])("keeps oversized audit payloads parseable: $name", async ({ detail }) => {
    await initAndGetFactory(makeSettingsService(new Map()));
    const auditLog = runtimeTestState.capturedRuntimeOptions?.auditLog as (level: string, message: string, data: unknown) => void;
    const data = { pluginId: "plugin-a", reason: "fixture refusal", detail };
    auditLog("error", "fixture_refusal", data);
    const entry = lastBootAuditLogger.log.mock.calls.at(-1)?.[0] as { output?: string } | undefined;
    const output = entry?.output ?? "";
    const payload = JSON.parse(output) as { truncated: boolean; originalLength: number; preview: string };
    expect(output.length).toBeLessThanOrEqual(500);
    expect(payload).toMatchObject({ truncated: true, originalLength: JSON.stringify(data).length });
    expect(JSON.stringify(data).startsWith(payload.preview)).toBe(true);
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-cfg-set-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-cfg-secret-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-cfg-lifecycle-")))),
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

describe("HostApi incarnation authority", () => {
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-alias-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-fresh-admin-")))),
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
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-issuing-")))),
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
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-secret-read-")))),
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
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-stage-")));
    const settings = new SettingsService(leaseSettingsOptions(root));
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
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-stage-plugin-")))),
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
    const settings = new SettingsService(leaseSettingsOptions(root));
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
    const settings = new SettingsService(leaseSettingsOptions(root));
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
    const settings = new SettingsService(leaseSettingsOptions(root));
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
    const settings = new SettingsService(leaseSettingsOptions(root));
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
      "meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-source-table-")))), activeIncarnation(),
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
    const dir = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-registry-")));
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
      const api = createHostApi("meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-bound-")))), activeIncarnation(), "meeting");

      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: false, reason: "not-whitelisted" });

      runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [{ ...entry, origin: OFFICIAL_ORIGIN }] });
      writeFileSync(runtimeTestState.registryPath, "bound to the official source");
      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
    } finally {
      runtimeTestState.registryPath = fixture.path("registry.json");
    }
  });

  it("lets a committed candidate see a registry entry bound after it started", async () => {
    // Re-enabled legacy entries have no origin until migration binds one.
    const dir = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-candidate-bound-")));
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
        pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-candidate-")))),
        activeIncarnation(),
        "meeting",
        { installSource: "user", manifestSha256 },
      );

      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: false, reason: "not-whitelisted" });

      runtimeTestState.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [{ ...entry, origin: OFFICIAL_ORIGIN }] });
      writeFileSync(runtimeTestState.registryPath, "bound to the official source");
      expect(await api.resolveApiKey({ purpose: "llm", vendor: "openai" })).toMatchObject({ ok: true, exposure: "lease" });
    } finally {
      runtimeTestState.registryPath = fixture.path("registry.json");
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
      createHostApi("meeting", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-other-")))), activeIncarnation(), "meeting", entry);

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
      return createHostApi("meeting", running, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-hostapi-pin-")))), activeIncarnation(), "meeting").resolveApiKey({ purpose: "llm", vendor: "openai" });
    };

    expect(await call(manifest, manifestSha256)).toMatchObject({ ok: true, exposure: "lease" });
    // A manifest not read from a document matches no pin, not even one taken over its projection.
    expect(await call(unread, projectionSha256)).toMatchObject({ ok: false, reason: "not-whitelisted" });
  });

  it("asks the tool call's own session for a worker nothing confines, and leaves one outside a tool call waiting", async () => {
    const handle = { control: "output-only-v1", pid: 7, stop: vi.fn(), onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn() };
    runtimeTestState.spawnWorker.mockImplementation(async (spec: { extensionStart?: unknown }) => {
      if (spec.extensionStart === undefined) throw new ExtensionStartConsentRequiredError("no-backend");
      return handle;
    });
    const ask = vi.fn<ExtensionStartAsker["ask"]>(async () => "yes");
    setExtensionStartAsker({ ask, notify: vi.fn() });
    try {
      const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-worker-start-")));
      const permissionManager = new PermissionManager(join(root, "permissions.json"));
      permissionManager.setMode("allow");
      const createHostApi = await initAndGetFactory(
        makeSettingsService(new Map()), { log: vi.fn() }, vi.fn() as unknown as typeof fetch, { requestAndWait: vi.fn() }, { permissionManager });
      const api = createHostApi(
        "plugin-a", { id: "plugin-a", config: {} } as never,
        pluginDataDirIn(root),
        { registerDisposer: () => {}, trackOperation: <T>(operation: Promise<T>) => operation, isActive: () => true, isLifecycleHookActive: () => false },
        "plugin-a",
      );
      const spawn = () => api.spawnWorker({ workerId: "w", command: "node", control: "output-only-v1" } as never);
      await runWithEffectGateContext({ headless: false, approvalSurface: "interactive", sessionId: "tool-session", toolName: "sample" }, spawn);
      expect(ask.mock.calls.map(([start, session]) => [start.key, session.sessionId, session.attended])).toEqual([["worker:plugin-a/w", "tool-session", true]]);
      expect(runtimeTestState.spawnWorker).toHaveBeenCalledTimes(2);

      await expect(spawn()).rejects.toThrow("extension-start-consent-required");
      expect(ask).toHaveBeenCalledTimes(1);
      expect(listPendingExtensionStarts()).toMatchObject([{ key: "worker:plugin-a/w", kind: "worker", state: "pending" }]);
    } finally {
      __resetExtensionStartsForTest();
    }
  });

  it("gives a worker only the floor pierces its plugin's reviewed declaration asked for", async () => {
    // Only host-interpreted manifest grants can name reads inside the protected floor.
    runtimeTestState.spawnWorker.mockResolvedValue({
      control: "output-only-v1", pid: 7, stop: vi.fn(), onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn(),
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
        pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-worker-pierces-")))),
        lifecycle,
        "plugin-a",
      );
      await api.spawnWorker({ workerId: "w", command: "node", control: "output-only-v1", floorPierces: ["/"] } as never);
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
      control: "output-only-v1",
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-issued-capabilities-")))),
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
      control: "output-only-v1",
    });
    if (worker.control !== "output-only-v1") throw new Error("expected an output-only handle");
    const stdoutListener = vi.fn();
    const stderrListener = vi.fn();
    const exitListener = vi.fn();
    worker.onStdout(stdoutListener);
    worker.onStderr(stderrListener);
    worker.onExit(exitListener);

    workerOnStdout.mock.calls[0]?.[0]("before");
    workerOnStderr.mock.calls[0]?.[0]("before-error");
    workerOnExit.mock.calls[0]?.[0]({ code: 0, signal: null, reason: "exited" });
    expect(stdoutListener).toHaveBeenCalledWith("before");
    expect(stderrListener).toHaveBeenCalledWith("before-error");
    expect(exitListener).toHaveBeenCalledWith({ code: 0, signal: null, reason: "exited" });
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-raw-denial-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-raw-grant-")))), activeIncarnation(), "plugin-a",
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-egress-")))),
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-cookie-matrix-")))), activeIncarnation(), "plugin-a",
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
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-body-audit-")))), activeIncarnation(), "plugin-a",
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
    const managerRoot = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-effect-policy-")));
    const permissionManager = new PermissionManager(join(managerRoot, "permissions.json"));
    permissionManager.setMode("strict");
    const createHostApi = await initAndGetFactory(settings, { log: vi.fn() }, transport, approvalGate, { permissionManager });
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["api.openai.com"] } },
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-approval-")))), activeIncarnation(), "plugin-a",
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

  it("carries a lease from a standalone child request only within the background effects approved for its source and scope", async () => {
    const settings = makeSettingsService(new Map());
    settings.getSecret.mockImplementation((key: string) =>
      key === "plugin.plugin-a.llm.apiKey.openai" ? "synthetic-secret" : undefined);
    const transport = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-lease-wire-")));
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode("allow");
    const requestAndWait = vi.fn(async () => ({ choice: "allow-once" }));
    const approvals = new PluginBackgroundEffectApprovals();
    const createHostApi = await initAndGetFactory(settings, { log: vi.fn() }, transport, { requestAndWait }, {
      permissionManager, backgroundEffectApprovals: approvals,
    });
    const manifestOf = (version: string, allowedDomains = ["api.openai.com"]) => ({
      id: "plugin-a", name: "Sample", version, entry: "dist/plugin.js",
      description: "sample", tools: [], config: {},
      capabilities: ["external-auth-consumer"],
      networkAccess: { allowedDomains },
    }) as PluginManifest;
    const entryFrom = (sourceId: string, installedAt = "2026-11-01T00:00:00.000Z"): PluginRegistryTrust => ({
      installSource: "user",
      origin: {
        sourceId, sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/a", version: "1.0.0",
        rung: "release", artifactSha256: "b".repeat(64), installedAt,
      },
    });
    const source = entryFrom("example-source");
    const childFor = async (manifest: PluginManifest, entry = source) => {
      const api = createHostApi("plugin-a", manifest, pluginDataDirIn(root), activeIncarnation(), null, entry);
      let child!: Awaited<ReturnType<typeof startPluginChildRuntime>>;
      const host = new HostApiDispatcher({
        pluginId: "plugin-a", isActive: () => true, reportUnknownField: vi.fn(),
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
          aveHome: "/Users/example/.ave",
        },
        channel: directHostApiChannel({
          handle: (request) => host.handle(request),
          handleNotification: (notification) => host.handleNotification(notification),
        }),
        loadFactory: async () => () => ({ handlers: {} }),
      });
      return child;
    };
    const fetchWithLease = async (child: Awaited<ReturnType<typeof childFor>>) => {
      const key = await child.hostApi.resolveApiKey!({ purpose: "llm", vendor: "openai" });
      if (!key.ok || key.exposure !== "lease") throw new Error("expected lease");
      try {
        return await (await child.hostApi.hostFetch!("https://api.openai.com/v1/models", { auth: { lease: key.leaseId } })).text();
      } finally {
        await key.release();
      }
    };
    const first = manifestOf("1.0.0");
    const child = await childFor(first);
    await expect(child.hostApi.hostFetch!("https://refused.example.test")).rejects.toThrow("Host request failed.");
    expect(lastBootAuditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("not in networkAccess.allowedDomains"),
    }));
    await expect(fetchWithLease(child)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    approvals.approve(backgroundEffectSubject(first, source));
    await expect(fetchWithLease(child)).resolves.toBe("ok");
    const networkInit = (transport as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit & { auth?: unknown };
    expect(networkInit.auth).toBeUndefined();
    expect(new Headers(networkInit.headers).get("authorization")).toBe("Bearer synthetic-secret");
    // The approval covers the declared destinations only.
    await expect(child.hostApi.hostFetch?.("https://refused.example.test")).rejects.toThrow("Host request failed.");
    expect(transport).toHaveBeenCalledOnce();
    // A version-only update keeps the approval, though it writes a new install stamp.
    await expect(fetchWithLease(await childFor(manifestOf("1.1.0"), entryFrom("example-source", "2026-11-02T00:00:00.000Z"))))
      .resolves.toBe("ok");
    expect(transport).toHaveBeenCalledTimes(2);
    // A changed scope or another source under the same id is not covered until approved itself.
    const widened = manifestOf("1.2.0", ["api.openai.com", "upload.example.test"]);
    const widenedChild = await childFor(widened);
    await expect(fetchWithLease(widenedChild)).rejects.toThrow();
    const otherSource = entryFrom("other-source");
    await expect(fetchWithLease(await childFor(first, otherSource))).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
    approvals.approve(backgroundEffectSubject(widened, source));
    await expect(fetchWithLease(widenedChild)).resolves.toBe("ok");
    await expect(fetchWithLease(child)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(3);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("moves a background approval to an update's stamp only once the registry commits it and the generation publishes", async () => {
    const dir = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-background-update-")));
    runtimeTestState.registryPath = join(dir, "registry.json");
    try {
      const manifest = {
        id: "plugin-a", name: "Sample", version: "1.1.0", entry: "dist/plugin.js", description: "sample", tools: [], config: {},
        networkAccess: { allowedDomains: ["api.openai.com"] },
      } as PluginManifest;
      const manifestSha256 = "c".repeat(64);
      const trustAt = (installedAt: string): PluginRegistryTrust => ({
        installSource: "user", manifestSha256,
        origin: {
          sourceId: "example-source", sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/a", version: "1.1.0",
          rung: "release", artifactSha256: "b".repeat(64), installedAt,
        },
      });
      const registryAt = (installedAt: string, pendingUpdate?: PluginRegistryEntry["pendingUpdate"]) => ({
        version: 1, plugins: [{ id: "plugin-a", manifestPath: "plugin-a/plugin.json", ...trustAt(installedAt), pendingUpdate }],
      });
      const approvalsPath = join(dir, "approvals.json");
      const approvedAt = (installedAt: string) =>
        new PluginBackgroundEffectApprovals(approvalsPath).isApproved(backgroundEffectSubject(manifest, trustAt(installedAt), true));
      const approvals = new PluginBackgroundEffectApprovals(approvalsPath);
      runtimeTestState.readPluginRegistry.mockResolvedValue(
        registryAt("2026-11-01T00:00:00.000Z", { kind: "marketplace", previousManifestFileSha256: null, previousReceiptRaw: null }));
      writeFileSync(runtimeTestState.registryPath, "update pending");
      const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), undefined, undefined, undefined, {
        backgroundEffectApprovals: approvals,
      });
      approvals.approve(backgroundEffectSubject(manifest, trustAt("2026-11-01T00:00:00.000Z"), true));
      const before = readFileSync(approvalsPath, "utf8");
      const scope = new HostApiGenerationScope("plugin-a");
      createHostApi("plugin-a", manifest, pluginDataDirIn(dir), { ...activeIncarnation(), generationScope: scope }, "plugin-a",
        trustAt("2026-11-02T00:00:00.000Z"));
      const candidate = await approvals.currentSubject("plugin-a");
      for (let turn = 0; turn < 5; turn += 1) await settleMacrotask();
      expect(readFileSync(approvalsPath, "utf8")).toBe(before);
      expect(candidate).toMatchObject({ installedAt: "2026-11-02T00:00:00.000Z", committed: false });

      runtimeTestState.readPluginRegistry.mockResolvedValue(registryAt("2026-11-02T00:00:00.000Z"));
      writeFileSync(runtimeTestState.registryPath, "update committed");
      scope.bindGeneration({} as never, "update");
      scope.publish();
      await vi.waitFor(() => expect(approvedAt("2026-11-02T00:00:00.000Z")).toBe(true));
      expect(approvedAt("2026-11-01T00:00:00.000Z")).toBe(false);
    } finally {
      runtimeTestState.registryPath = fixture.path("registry.json");
    }
  });

  it("binds a local development install's background approval to the stamp its committed registry entry carries", async () => {
    const dir = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-background-local-")));
    runtimeTestState.registryPath = join(dir, "registry.json");
    try {
      const manifest = {
        id: "plugin-a", name: "Sample", version: "1.0.0", entry: "dist/plugin.js", description: "sample", tools: [], config: {},
        networkAccess: { allowedDomains: ["api.openai.com"] },
      } as PluginManifest;
      const local: PluginRegistryTrust = { installSource: "local-dev", manifestSha256: "c".repeat(64) };
      runtimeTestState.readPluginRegistry.mockResolvedValue({
        version: 1, plugins: [{ id: "plugin-a", manifestPath: "plugin-a/plugin.json", ...local, installedAt: "2026-11-01T00:00:00.000Z" }],
      });
      writeFileSync(runtimeTestState.registryPath, "local install committed");
      const approvals = new PluginBackgroundEffectApprovals(join(dir, "approvals.json"));
      const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), undefined, undefined, undefined, {
        backgroundEffectApprovals: approvals,
      });
      createHostApi("plugin-a", manifest, pluginDataDirIn(dir), activeIncarnation(), "plugin-a", local);
      expect(await approvals.currentSubject("plugin-a")).toMatchObject({ installedAt: "2026-11-01T00:00:00.000Z", committed: true });
    } finally {
      runtimeTestState.registryPath = fixture.path("registry.json");
    }
  });

  it.each(["strict", "default"] as const)("in %s mode keeps approved background effects to their declared targets", async (mode) => {
    const transport = vi.fn(async (input: string | URL | Request) => String(input).includes("/hop")
      ? new Response(null, { status: 302, headers: { location: "https://93.184.216.35/landing" } })
      : new Response("ok")) as unknown as typeof fetch;
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-background-kinds-")));
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode(mode);
    const requestAndWait = vi.fn(async () => ({ choice: "allow-once" }));
    const approvals = new PluginBackgroundEffectApprovals();
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), { log: vi.fn() }, transport, { requestAndWait }, {
      permissionManager, backgroundEffectApprovals: approvals,
    });
    const manifest = {
      id: "plugin-a", name: "Sample", version: "1.0.0", entry: "dist/plugin.js", description: "sample", tools: [], config: {}, capabilities: ["external-auth-consumer"],
      networkAccess: { allowedDomains: ["93.184.216.34", "127.0.0.1"] },
      alerts: {
        reasoning: "Tells you when a digest is ready.",
        kinds: [{
          id: "digest", label: { en: "Morning digest" }, defaultEnabled: true, visibility: "summary-only",
          slots: { topics: { kind: "list", maxItems: 5, maxLength: 120 } },
          summary: { en: "Today: {topics}" }, prompt: { en: "Summarise these topics for me: {topics}" },
        }],
        suggestions: ["overlay:sample-routine"],
      },
    } as unknown as PluginManifest;
    const entry: PluginRegistryTrust = {
      installSource: "user",
      origin: {
        sourceId: "example-source", sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/a", version: "1.0.0",
        rung: "release", artifactSha256: "b".repeat(64), installedAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const api = createHostApi("plugin-a", manifest, pluginDataDirIn(root), activeIncarnation(), null, entry) as unknown as Required<PluginHostApi>;
    approvals.approve(backgroundEffectSubject(manifest, entry));
    const background = <T>(run: () => Promise<T>) => runWithEffectGateContext({ headless: false, standalone: true, toolName: "background" }, run);
    const refused = async (run: () => Promise<unknown>) => {
      const error = await background(run).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeDefined();
      return error;
    };

    await expect(background(async () => (await api.hostFetch("https://93.184.216.34/x")).text())).resolves.toBe("ok");
    await expect(background(async () => (await api.hostFetch("http://127.0.0.1:8080/x")).text())).resolves.toBe("ok");
    expect(transport).toHaveBeenCalledTimes(2);
    await refused(() => api.hostFetch("https://93.184.216.35/x"));
    await refused(() => api.hostFetch("https://93.184.216.34/hop", { redirect: "follow" }));
    expect((transport as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => String(input))).not.toContain("https://93.184.216.35/landing");
    expect(await refused(() => api.raiseAlert({ kind: "undeclared", slots: {} } as never))).toBeInstanceOf(EffectBoundaryDeniedError);
    expect(await refused(() => api.raiseAlert({ kind: "digest", slots: { topics: ["a"] } } as never))).not.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(await refused(() => api.triggerConversation({ source: "overlay:undeclared", prompt: "x" } as never))).toBeInstanceOf(EffectBoundaryDeniedError);
    await refused(() => api.storage.write("../escape.txt", "x"));
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["strict", "default", "auto"] as const)("in %s mode writes a plugin's own storage outside a tool call with no card or approval, and nothing past it", async (mode) => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-background-own-storage-")));
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode(mode);
    const requestAndWait = vi.fn(async () => ({ choice: "allow-once" }));
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), { log: vi.fn() }, undefined, { requestAndWait }, {
      permissionManager, backgroundEffectApprovals: new PluginBackgroundEffectApprovals(),
    });
    const manifest = {
      id: "plugin-a", name: "Sample", version: "1.0.0", entry: "dist/plugin.js", description: "sample", tools: [], config: {}, capabilities: ["external-auth-consumer"],
      networkAccess: { allowedDomains: ["93.184.216.34"] },
    } as unknown as PluginManifest;
    const api = createHostApi("plugin-a", manifest, pluginDataDirIn(root), activeIncarnation(), null, undefined) as unknown as Required<PluginHostApi>;
    const background = <T>(run: () => Promise<T>) => runWithEffectGateContext({ headless: false, standalone: true, toolName: "background" }, run);

    await background(() => api.storage.writeJson("state.json", { n: 1 }));
    await background(() => api.storage.write("notes/a.txt", "x"));
    await expect(background(() => api.storage.readJson("state.json"))).resolves.toEqual({ n: 1 });
    await expect(background(() => api.storage.write("../escape.txt", "x"))).rejects.toThrow();
    await expect(background(() => api.hostFetch("https://93.184.216.34/x"))).rejects.toBeInstanceOf(EffectBoundaryDeniedError);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("reviews the newest live HostApi's background scope, falling back when a candidate is discarded", async () => {
    const approvals = new PluginBackgroundEffectApprovals();
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), { log: vi.fn() }, undefined, undefined, {
      backgroundEffectApprovals: approvals,
    });
    const entry: PluginRegistryTrust = {
      installSource: "user",
      origin: {
        sourceId: "example-source", sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/a", version: "1.0.0",
        rung: "release", artifactSha256: "b".repeat(64), installedAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const manifestFor = (allowedDomains: string[]) => ({
      id: "plugin-a", name: "Sample", version: "1.0.0", entry: "dist/plugin.js", description: "sample", tools: [], config: {},
      networkAccess: { allowedDomains },
    }) as PluginManifest;
    const incarnation = () => {
      const disposers: Array<() => void> = [];
      return { ...activeIncarnation(), registerDisposer: (dispose: () => void) => { disposers.push(dispose); }, dispose: () => { for (const dispose of disposers) dispose(); } };
    };
    const running = incarnation();
    createHostApi("plugin-a", manifestFor(["api.example.test"]), pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-bind-a-")))), running, null, entry);
    const candidate = incarnation();
    createHostApi("plugin-a", manifestFor(["api.example.test", "upload.example.test"]), pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-bind-b-")))), candidate, null, entry);
    expect((await approvals.currentSubject("plugin-a"))?.effects.networkDestinations).toEqual(["api.example.test", "upload.example.test"]);
    candidate.dispose();
    expect((await approvals.currentSubject("plugin-a"))?.effects.networkDestinations).toEqual(["api.example.test"]);
    running.dispose();
    expect(await approvals.currentSubject("plugin-a")).toBeNull();
  });

  it.each(["strict", "default"] as const)("in %s mode runs background model calls and helper processes only when declared and approved", async (mode) => {
    runtimeTestState.spawnWorker.mockResolvedValue({
      control: "output-only-v1", pid: 7, stop: vi.fn(), onStdout: vi.fn(), onStderr: vi.fn(), onExit: vi.fn(),
    });
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-background-llm-")));
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode(mode);
    const requestAndWait = vi.fn(async () => ({ choice: "allow-once" }));
    const approvals = new PluginBackgroundEffectApprovals();
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), { log: vi.fn() }, undefined, { requestAndWait }, {
      permissionManager, backgroundEffectApprovals: approvals,
    });
    const entry: PluginRegistryTrust = {
      installSource: "user",
      origin: {
        sourceId: "example-source", sourceOrigin: "custom", commit: "a".repeat(40), packagePath: "plugins/a", version: "1.0.0",
        rung: "release", artifactSha256: "b".repeat(64), installedAt: "2026-11-01T00:00:00.000Z",
      },
    };
    const approvedApi = (capabilities: string[]) => {
      const manifest = {
        id: "plugin-a", name: "Sample", version: "1.0.0", entry: "dist/plugin.js", description: "sample", tools: [], config: {},
        networkAccess: { allowedDomains: ["api.example.test"] }, capabilities,
      } as unknown as PluginManifest;
      const api = createHostApi("plugin-a", manifest, pluginDataDirIn(tmpDirs.track(mkdtempSync(join(root, "data-")))), activeIncarnation(), null, entry) as unknown as Required<PluginHostApi>;
      approvals.approve(backgroundEffectSubject(manifest, entry));
      return api;
    };
    const outcome = (run: () => Promise<unknown>) => runWithEffectGateContext({ headless: false, standalone: true, toolName: "background" }, run)
      .then(() => "ran", (caught: unknown) => caught instanceof EffectBoundaryDeniedError ? "denied" : "ran");
    const spawn = (api: Required<PluginHostApi>) => () => api.spawnWorker({ workerId: "w", command: "node", control: "output-only-v1" } as never);

    const neither = approvedApi([]);
    expect(await outcome(() => neither.callLlm("hello"))).toBe("denied");
    expect(await outcome(spawn(neither))).toBe("denied");
    const llmOnly = approvedApi(["background:call-llm"]);
    expect(await outcome(() => llmOnly.callLlm("hello"))).toBe("ran");
    expect(await outcome(spawn(llmOnly))).toBe("denied");
    expect(runtimeTestState.spawnWorker).not.toHaveBeenCalled();
    const both = approvedApi(["background:call-llm", "background:spawn-worker"]);
    expect(await outcome(spawn(both))).toBe("ran");
    expect(runtimeTestState.spawnWorker).toHaveBeenCalledTimes(1);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("revokes every callable HostApi surface when its incarnation is deactivated", async () => {
    const createHostApi = await initAndGetFactory(
      makeSettingsService(new Map()),
    );
    let active = true;
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {} },
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-revoked-hostapi-")))),
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
    expect(() => api.config.onChange("after", vi.fn())).toThrow(
      /plugin instance is no longer active/,
    );
  });
});

describe("host fetch binds approved request bodies to transport", () => {
  it("multipart transport data stays approved", async () => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-form-data-")));
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode("strict");
    let approve!: (decision: { choice: "allow-once" }) => void;
    const approvalGate = { requestAndWait: vi.fn(() => new Promise((resolve) => { approve = resolve as typeof approve; })) };
    const sent: unknown[] = [];
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = init?.body as FormData;
      sent.push(Array.from(body.entries()));
      return new Response("sent");
    }) as unknown as typeof fetch;
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), { log: vi.fn() }, transport, approvalGate, { permissionManager });
    const api = createHostApi("plugin-a", { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["93.184.216.34"] } }, pluginDataDirIn(root), activeIncarnation(), "plugin-a");
    const body = new FormData();
    body.set("payload", "approved");
    const pending = runWithEffectGateContext({ headless: false, approvalSurface: "interactive", toolName: "sample" }, () => api.hostFetch("https://93.184.216.34/resource", { method: "POST", body }));
    await vi.waitFor(() => expect(approvalGate.requestAndWait).toHaveBeenCalledOnce());
    body.set("payload", "changed");
    body.append("extra", "not approved");
    approve({ choice: "allow-once" });
    await pending;
    expect(sent).toEqual([[["payload", "approved"]]]);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("stream bodies fail before tool network effects", async () => {
    const root = tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-stream-body-")));
    const permissionManager = new PermissionManager(join(root, "permissions.json"));
    permissionManager.setMode("allow");
    const approvalGate = { requestAndWait: vi.fn() };
    const transport = vi.fn(async () => new Response("unused")) as unknown as typeof fetch;
    const createHostApi = await initAndGetFactory(makeSettingsService(new Map()), { log: vi.fn() }, transport, approvalGate, { permissionManager });
    const api = createHostApi("plugin-a", { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["93.184.216.34"] } }, pluginDataDirIn(root), activeIncarnation(), "plugin-a");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    await runWithEffectGateContext({ headless: false, approvalSurface: "interactive", toolName: "sample" }, async () => {
      await expect(api.hostFetch("https://93.184.216.34/resource", { method: "POST", body })).rejects.toThrow("Tool network effects require a snapshotable request body");
    });
    expect(approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
});
