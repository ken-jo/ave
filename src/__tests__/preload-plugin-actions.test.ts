import { beforeEach, describe, expect, it, vi } from "vitest";

const exposed = new Map<string, unknown>();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

// Named exports only — mirrors the named-import shape in preload.ts.
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn((key: string, value: unknown) => {
      exposed.set(key, value);
    }),
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
  },
}));

type ExposedApi = {
  takePluginMarketplaceApi: () => {
    uninstallMarketplacePlugin: (pluginId: string, options?: unknown) => Promise<unknown>;
  } | null;
};

async function loadExposedApi(): Promise<ExposedApi> {
  await import("../preload.js");
  const api = exposed.get("aveHost");
  if (!api || typeof api !== "object") {
    throw new Error("aveHost was not exposed");
  }
  return api as ExposedApi;
}

describe("preload plugin action normalization", () => {
  beforeEach(() => {
    exposed.clear();
    mockInvoke.mockReset();
    mockOn.mockReset();
    mockRemoveListener.mockReset();
    vi.resetModules();
  });

  it.each([
    ["an install result", { pluginId: "meeting", installed: true }],
    ["no plugin id", { uninstalled: true }],
    ["a non-object", "done"],
  ])("rejects an uninstall answer with %s as invalid-result", async (_label, answer) => {
    mockInvoke.mockResolvedValueOnce(answer);
    const api = await loadExposedApi();
    const hostApi = api.takePluginMarketplaceApi();
    if (!hostApi) throw new Error("host plugin marketplace api unavailable");

    await expect(hostApi.uninstallMarketplacePlugin("meeting")).resolves.toEqual({
      ok: false,
      error: "invalid-result",
      // preload resolves i18n at the English default — it has no settings
      // context to switch language, and this suite re-imports it via
      // resetModules so the runtime locale is the default.
      message: "Plugin action result is invalid.",
    });
  });

  it("preserves valid uninstall payloads", async () => {
    mockInvoke.mockResolvedValueOnce({ pluginId: "meeting", uninstalled: true });
    const api = await loadExposedApi();
    const hostApi = api.takePluginMarketplaceApi();
    if (!hostApi) throw new Error("host plugin marketplace api unavailable");

    await expect(hostApi.uninstallMarketplacePlugin("meeting")).resolves.toEqual({
      ok: true,
      pluginId: "meeting",
      uninstalled: true,
    });
  });

  it("forwards Doctor cleanup options to the uninstall IPC channel", async () => {
    mockInvoke.mockResolvedValueOnce({ pluginId: "meeting", uninstalled: true });
    const api = await loadExposedApi();
    const hostApi = api.takePluginMarketplaceApi();
    if (!hostApi) throw new Error("host plugin marketplace api unavailable");

    const options = { doctorCleanup: { installFailureKind: "catalog-grant-mismatch" } };
    await hostApi.uninstallMarketplacePlugin("meeting", options);

    expect(mockInvoke).toHaveBeenCalledWith("ave:plugins:uninstall", "meeting", options);
  });

  it("allows the host marketplace api to be claimed only once", async () => {
    const api = await loadExposedApi();

    expect(api.takePluginMarketplaceApi()).not.toBeNull();
    expect(api.takePluginMarketplaceApi()).toBeNull();
  });
});
