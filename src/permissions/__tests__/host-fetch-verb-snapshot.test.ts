import { createBootHostFixture, stationaryLeaseState } from "../../__tests__/support/host-runtime.js";
// Read a plugin-controlled method getter exactly once; the same primitive verb must drive the recorded effect, audit and wire request so a recorded read cannot become a write. Mock request approval only to isolate this from DNS/SSRF policy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  capturedRuntimeOptions: null as Record<string, unknown> | null,
  readPluginRegistry: vi.fn(async () => ({ version: 1, plugins: [] })),
  appPrependOnceListener: vi.fn(),
  runtime: {
    // boot installs each loaded plugin's partition policy before starting any of them, so the double needs the cheap half of startAll too.
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
    resolveToolOwner: vi.fn((toolName: string) => `${toolName}-owner`),
  },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/ave-test"),
    isPackaged: false,
    prependOnceListener: harness.appPrependOnceListener,
    once: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    getAllWindows: vi.fn(() => []),
    getFocusedWindow: vi.fn(() => null),
  }),
  shell: { openExternal: vi.fn() },
}));

vi.mock("../../plugins/runtime.js", () => ({
  PluginRuntime: vi.fn().mockImplementation(function (
    this: unknown,
    options: Record<string, unknown>,
  ) {
    harness.capturedRuntimeOptions = options;
    return harness.runtime;
  }),
}));

vi.mock("../../plugins/dev-watcher.js", () => ({
  startPluginDevWatcher: vi.fn(() => ({ stop: vi.fn() })),
}));

vi.mock("../../main/html-preview-partition.js", () => ({
  installPluginPartitionPolicy: vi.fn(),
}));

vi.mock("../../plugins/plugin-paths.js", () => ({
  resolvePluginPaths: vi.fn(() => ({
    pluginsRoot: "/tmp/ave-test/plugins",
    registryPath: "/tmp/ave-test/registry.json",
    cacheRoot: "/tmp/ave-test/cache",
  })),
}));

vi.mock("../../plugins/registry.js", () => ({
  readPluginRegistry: harness.readPluginRegistry,
}));

// Deterministic egress allow: the verb the closure passes (`methodSnapshot`) flows straight back as decision.method/effect, isolating the verb-snapshot flow from the real DNS/SSRF/allow-list gate (unchanged; tested separately). PARTIAL mock: `evaluateHostFetch` is replaced with a deterministic allow so the verb-snapshot flow is isolated from DNS/SSRF (unchanged, covered by host-fetch-guard.test.ts) — but `runHostFetchHops` stays REAL, because the wire behaviour under test now lives inside it. The cases below never follow a hop, so the loop's own internal `evaluateHostFetch` (which the partial mock cannot reach) never runs and no live DNS is touched.
vi.mock("../../main/host-fetch-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../main/host-fetch-guard.js")>()),
  evaluateHostFetch: vi.fn(
    async (input: { rawUrl: string; method: string }) => ({
      ok: true,
      url: new URL(input.rawUrl),
      method: input.method,
      effect: ["GET", "HEAD", "OPTIONS"].includes(input.method)
        ? "read"
        : "write",
    }),
  ),
}));

import { initPluginRuntime } from "../../boot/steps/plugin-runtime.js";
import {
  createEffectLedger,
  runWithEffectLedger,
  type EffectEntry,
} from "../effect-ledger.js";
import type { PluginHostApi } from "../../plugins/types.js";
import { PermissionTestResources } from "./test-resources.js";
import { pluginDataDirIn } from "../../plugins/__tests__/test-helpers.js";

const resources = new PermissionTestResources();

afterEach(async () => {
  await resources.cleanup();
});

type CreateHostApi = (
  pluginId: string,
  manifest: {
    id: string;
    config?: Record<string, unknown>;
    capabilities?: string[];
    networkAccess?: {
      allowedDomains?: string[];
      allowPrivateNetworks?: boolean;
    };
  },
  pluginDataDir: string,
  incarnation: {
    registerDisposer: (dispose: () => void) => void;
    trackOperation: <T>(operation: Promise<T>) => Promise<T>;
    isActive: () => boolean;
    isLifecycleHookActive: () => boolean;
  },
  installPluginId: string | null,
) => PluginHostApi;

async function buildRealHostApi(): Promise<{
  hostApi: PluginHostApi;
  networkFetch: ReturnType<typeof vi.fn>;
}> {
  harness.capturedRuntimeOptions = null;
  const networkFetch = vi.fn(async () => new Response(""));
  await initPluginRuntime({
    host: createBootHostFixture(),
    projectRoot: "/tmp/ave-test/project",
    settingsService: {
        ...stationaryLeaseState,
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai" };
        if (key === "pluginConfigs") return {};
        return undefined;
      }),
      getSecret: vi.fn(() => undefined),
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
    networkFetch: networkFetch as never,
    openAuthWindowService: vi.fn(),
    openLinkWindowService: vi.fn(),
    openAuthPartitionViewerService: vi.fn(),
    clearAuthPartitionService: vi.fn(),
    shellOpenExternal: vi.fn(),
    approvalGate: { requestAndWait: vi.fn(), resolve: vi.fn() } as never,
    routinesStore: { list: () => [] } as never,
    // This harness has no Work Board; the proposal verbs are not exercised here.
    getWorkBoardStore: () => undefined,
    getAlertsService: () => undefined,
  });

  const createHostApi = harness.capturedRuntimeOptions?.createHostApi as
    | CreateHostApi
    | undefined;
  expect(
    createHostApi,
    "initPluginRuntime must register a createHostApi factory",
  ).toBeDefined();
  const pluginDataDir = pluginDataDirIn(resources.makeTmpDir("ave-hostfetch-verb-"));
  const hostApi = createHostApi!(
    "verb-snapshot-plugin",
    {
      id: "verb-snapshot-plugin",
      config: {},
      capabilities: ["external-auth-consumer"],
      networkAccess: { allowedDomains: ["api.example.com"] },
    },
    pluginDataDir,
    {
      registerDisposer: vi.fn(),
      trackOperation: <T>(operation: Promise<T>) => operation,
      isActive: () => true,
      isLifecycleHookActive: () => false,
    },
    null,
  );
  return { hostApi, networkFetch };
}

async function driveHostFetch(
  hostApi: PluginHostApi,
  networkFetch: ReturnType<typeof vi.fn>,
  url: string | URL,
  init?: RequestInit,
): Promise<{ effects: EffectEntry[]; wireInit: RequestInit }> {
  const ledger = createEffectLedger("cid-verb");
  await runWithEffectLedger(ledger, async () => {
    await hostApi.hostFetch!(url, init);
  });
  const wireInit = (networkFetch.mock.calls[0]?.[1] ?? {}) as RequestInit;
  return { effects: ledger.summary().effects, wireInit };
}

describe("hostFetch verb snapshot — single read, recorded effect == wire verb", () => {
  beforeEach(() => {
    harness.readPluginRegistry.mockReset();
    harness.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  });

  it("a STATEFUL init.method getter (GET then POST) is read EXACTLY ONCE — shadow and wire agree", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    let accessCount = 0;
    const statefulInit = {
      get method(): string {
        accessCount += 1;
        // GET on the first read; POST on any later read. With a single read the ONLY value either consumer can observe is "GET".
        return accessCount === 1 ? "GET" : "POST";
      },
    } as unknown as RequestInit;

    const { effects, wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
      statefulInit,
    );

    // The getter was invoked exactly once — there is NO second, independent read the recorder/wire could disagree on.
    expect(accessCount).toBe(1);
    // The recorded shadow effect reflects that single read (GET → read)…
    expect(effects).toEqual([
      { kind: "hostFetch", effect: "read", target: "https://api.example.com" },
    ]);
    // …and the WIRE verb is the SAME primitive — NOT a later re-read that would send POST. Before the fix the spread re-read the live getter → POST on the wire while the shadow said read (the forgery).
    expect(wireInit.method).toBe("GET");
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it("a genuine mutating verb records WRITE and sends that same verb on the wire", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    let accessCount = 0;
    const statefulInit = {
      get method(): string {
        accessCount += 1;
        return "POST";
      },
    } as unknown as RequestInit;

    const { effects, wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
      statefulInit,
    );

    expect(accessCount).toBe(1);
    expect(effects).toEqual([
      { kind: "hostFetch", effect: "write", target: "https://api.example.com" },
    ]);
    expect(wireInit.method).toBe("POST");
  });

  it("omitted method defaults to GET (read) on both the shadow and the wire", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    const { effects, wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
    );
    expect(effects).toEqual([
      { kind: "hostFetch", effect: "read", target: "https://api.example.com" },
    ]);
    expect(wireInit.method).toBe("GET");
  });
});

// The wire must use manual redirects; only the host loop may follow, after rerunning the full gate on each hop.
describe("hostFetch redirect boundary — the transport is never told to follow", () => {
  beforeEach(() => {
    harness.readPluginRegistry.mockReset();
    harness.readPluginRegistry.mockResolvedValue({ version: 1, plugins: [] });
  });

  it('the wire sees "manual" even when the plugin asks to follow', async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    const { wireInit } = await driveHostFetch(
      hostApi,
      networkFetch,
      "https://api.example.com/x",
      { redirect: "follow" },
    );
    expect(wireInit.redirect).toBe("manual");
  });

  it("the default policy still refuses a redirect — one hop, then a thrown refusal", async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    networkFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://api.example.com/next" } }),
    );
    const ledger = createEffectLedger("cid-redirect");
    await expect(
      runWithEffectLedger(ledger, async () => {
        await hostApi.hostFetch!("https://api.example.com/x");
      }),
    ).rejects.toThrow(/redirect refused/);
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it('"manual" hands the 3xx to the plugin with its location readable', async () => {
    const { hostApi, networkFetch } = await buildRealHostApi();
    networkFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://sso.example.com/login" } }),
    );
    const ledger = createEffectLedger("cid-manual");
    let response: Response | undefined;
    await runWithEffectLedger(ledger, async () => {
      response = await hostApi.hostFetch!("https://api.example.com/x", { redirect: "manual" });
    });
    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://sso.example.com/login");
    expect(networkFetch).toHaveBeenCalledOnce();
  });
});
