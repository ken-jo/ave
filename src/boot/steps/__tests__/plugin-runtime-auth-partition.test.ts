import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
import { directHostFetchTransport } from "../../../__tests__/support/host-fetch-transport.js";
/** Auth surfaces require capability checks; partition clearing is limited to the caller’s own partitions. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi } from "../../../plugins/public-contract.js";
import { pluginDataDirIn } from "../../../plugins/__tests__/test-helpers.js";

import { createTmpDirTracker } from "../../../__tests__/support/tmp-dir-teardown.js";

const tmpDirs = createTmpDirTracker();

const runtimeTestState = vi.hoisted(() => ({
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  clearAuthPartitionService: vi.fn(async (_partition: string) => {}),
  runtime: {
    // Install partition policy for every loaded plugin before starting any plugin.
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
    assertPluginEventAccess: vi.fn(),
    assertPluginEventEmitAccess: vi.fn(),
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
    setConfigOverride: vi.fn(),
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
    getAllWindows: vi.fn(() => []),
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
vi.mock("../../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));
vi.mock("../../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/ave-test/plugins",
    registryPath: "/tmp/ave-test/registry.json",
    cacheRoot: "/tmp/ave-test/cache",
  })),
}));
vi.mock("../../../plugins/registry.js", () => ({
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
}));

import { initPluginRuntime } from "../plugin-runtime.js";

type AuthHostApi = {
  authRedirect: PluginHostApi["authRedirect"];
  openAuthWindow: (opts: {
    url: string;
    cookieHosts?: string[];
  }) => Promise<unknown>;
  clearAuthPartition: (partition: string) => Promise<void>;
};

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    capabilities?: string[];
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
  installPluginId: string | null,
) => AuthHostApi;

const ACTIVE_INCARNATION = {
  registerDisposer: vi.fn(),
  trackOperation: <T>(operation: Promise<T>) => operation,
  isActive: () => true,
  isLifecycleHookActive: () => false,
};

async function initAndGetFactory(): Promise<CreateHostApi> {
  runtimeTestState.capturedRuntimeOptions = null;
  await initPluginRuntime({
    host: createBootHostFixture(),
    projectRoot: "/tmp/ave-test/project",
    settingsService: {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai" };
        if (key === "pluginConfigs") return {};
        return undefined;
      }),
      getSecret: vi.fn(() => undefined),
      getProviderConfigRevision: () => 0,
      getSecretGeneration: () => 0,
      onLeaseStateChanged: () => () => {},
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(),
    } as never,
    memoryManager: {} as never,
    toolRegistry: {
      unregisterByPlugin: vi.fn(),
      register: vi.fn(),
      listAll: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      replacePluginTools: vi.fn(),
    } as never,
    pythonPath: undefined,
    bootAuditLogger: { log: vi.fn() } as never,
    mainWindow: {} as never,
    networkFetch: directHostFetchTransport(vi.fn() as unknown as typeof fetch),
    openAuthWindowService: vi.fn(async () => []),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: runtimeTestState.clearAuthPartitionService,
    shellOpenExternal: vi.fn(),
    approvalGate: { requestAndWait: vi.fn() } as never,
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

beforeEach(() => {
  runtimeTestState.clearAuthPartitionService.mockClear();
});

afterEach(() => tmpDirs.cleanup());

describe("HostApi openAuthWindow capability gate", () => {
  it.each([["code", "plugin-code"], ["error", "access_denied"]] as const)("validates host state before delivering a %s callback", async (parameter, value) => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a", { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync(join(tmpdir(), "ave-auth-")))), ACTIVE_INCARNATION, "plugin-a",
    );
    const result = await api.authRedirect.open();
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callback = new URL(result.redirectUri);
    callback.hostname = "127.0.0.1";
    let completed = false;
    const waiting = api.authRedirect.wait({ handle: result.handle });
    void waiting.then(() => { completed = true; }, () => undefined);
    try {
      for (const path of ["/unrelated?x=1", `/other/?code=forged&state=${result.state}`, "/?code=forged&state=plugin-flow-state", "/?code=forged"]) {
        expect((await fetch(new URL(path, callback), { redirect: "manual" })).status).toBe(404);
        expect(completed).toBe(false);
      }
      const expected = { [parameter]: value, state: result.state };
      callback.search = new URLSearchParams(expected).toString();
      expect((await fetch(callback, { redirect: "manual" })).status).toBe(303);
      await expect(waiting).resolves.toEqual(expected);
      callback.search = new URLSearchParams({ code: "replay", state: result.state }).toString();
      expect((await fetch(callback, { redirect: "manual" })).status).toBe(404);
      await expect(api.authRedirect.wait({ handle: result.handle })).resolves.toEqual(expected);
    } finally { await api.authRedirect.close({ handle: result.handle }); }
  });

  it("rejects when the manifest has not declared external-auth-consumer", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: [] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-auth-"))),
      ACTIVE_INCARNATION,
      "plugin-a",
    );
    await expect(
      api.openAuthWindow({ url: "https://idp.example.com/authorize" }),
    ).rejects.toThrow(/capability not declared: external-auth-consumer/);
  });
});

describe("HostApi clearAuthPartition capability + partition gates", () => {
  it("rejects when the manifest has not declared external-auth-consumer", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: [] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-auth-"))),
      ACTIVE_INCARNATION,
      "plugin-a",
    );
    await expect(
      api.clearAuthPartition("persist:plugin-auth:plugin-a"),
    ).rejects.toThrow(/capability not declared: external-auth-consumer/);
    expect(runtimeTestState.clearAuthPartitionService).not.toHaveBeenCalled();
  });

  it("rejects a partition outside the plugin's own auth namespace", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-auth-"))),
      ACTIVE_INCARNATION,
      "plugin-a",
    );
    await expect(
      api.clearAuthPartition("persist:plugin-auth:other-plugin"),
    ).rejects.toThrow(/partition must be 'persist:plugin-auth:plugin-a'/);
    expect(runtimeTestState.clearAuthPartitionService).not.toHaveBeenCalled();
  });

  it("delegates a valid own-namespace partition to the injected clearAuthPartitionService", async () => {
    const createHostApi = await initAndGetFactory();
    const api = createHostApi(
      "plugin-a",
      { id: "plugin-a", config: {}, capabilities: ["external-auth-consumer"] },
      pluginDataDirIn(tmpDirs.track(mkdtempSync("/tmp/ave-auth-"))),
      ACTIVE_INCARNATION,
      "plugin-a",
    );
    await api.clearAuthPartition("persist:plugin-auth:plugin-a:tenant-1");
    expect(runtimeTestState.clearAuthPartitionService).toHaveBeenCalledWith(
      "persist:plugin-auth:plugin-a:tenant-1",
    );
  });
});
