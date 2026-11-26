// Use the host-supplied transport so model discovery honors system proxy and trust configuration.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { llmModelListCacheKey, type LlmModelListCache } from "../../../shared/llm-model-list.js";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listLlmModelsFromSettingsMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));
vi.mock("../../../engine/llm/model-list.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../engine/llm/model-list.js")>(),
  listLlmModelsFromSettings: listLlmModelsFromSettingsMock,
}));

const invoke = makeAppIpcInvoker(handlers);
const OPENAI_LISTING = {
  vendor: "openai", endpoint: "https://api.openai.com/v1/models", models: ["gpt-4o"],
  complete: true, fetchedAt: "2026-10-23T00:00:00.000Z",
} as const;

function makeDeps(singleHopNetworkFetch: typeof fetch) {
  return {
    settingsService: {
      getAll: vi.fn(() => ({ llm: { provider: "openai", activeChatRuntime: { kind: "api" } } })),
      get: vi.fn((key?: string) => {
        if (key === "marketplace") return { installedProviderIds: [] as string[] };
        if (key === "shortcuts") return {};
        if (key === "system") return {};
        return { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { openai: { baseUrl: null } } };
      }),
      getSecret: vi.fn(() => null),
      hasStoredSecret: vi.fn(async () => false),
      patch: vi.fn(async () => ({ llm: { provider: "openai", activeChatRuntime: { kind: "api" } } })),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
    singleHopNetworkFetch,
  };
}

beforeEach(() => {
  handlers.clear();
  listLlmModelsFromSettingsMock.mockReset();
  listLlmModelsFromSettingsMock.mockResolvedValue({
    ok: true,
    models: [],
    endpoint: "",
    fetchedAt: "",
  });
  vi.resetModules();
});

describe("model list IPC transport injection", () => {
  it("refuses a renderer-supplied listing cache", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const deps = makeDeps(vi.fn() as unknown as typeof fetch);
    registerSettingsHandlers(deps as never);

    await expect(invoke(CHANNELS.settings.update, { llm: { modelListCache: {} } })).resolves.toEqual({ ok: false, error: "model-list-cache-main-owned" });
    expect(deps.settingsService.patch).not.toHaveBeenCalled();
  });

  it("merges a host listing with cache changes made while discovery was pending", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const deps = makeDeps(vi.fn() as unknown as typeof fetch);
    const claude = { vendor: "claude", endpoint: "https://api.anthropic.com/v1/models", models: ["claude-sonnet-4-6"], fetchedAt: "2026-10-23T00:00:00.000Z" };
    const modelListCache: LlmModelListCache = {};
    const llm = { provider: "openai", activeChatRuntime: { kind: "api" }, vendors: { openai: { baseUrl: null } }, modelListCache };
    deps.settingsService.get.mockImplementation((key) => key === "llm" ? llm : {});
    listLlmModelsFromSettingsMock.mockImplementationOnce(async () => {
      await Promise.resolve();
      modelListCache[llmModelListCacheKey("claude")] = claude;
      return { ok: true, ...OPENAI_LISTING };
    });
    registerSettingsHandlers(deps as never);

    await invoke(CHANNELS.settings.listLlmModels, { vendor: "openai" });
    expect(deps.settingsService.patch).toHaveBeenCalledWith({ llm: { modelListCache: {
      [llmModelListCacheKey("openai")]: OPENAI_LISTING,
      [llmModelListCacheKey("claude")]: claude,
    } } }, undefined);
  });

  it("keeps discovered models available when settings cannot be written", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const deps = makeDeps(vi.fn() as unknown as typeof fetch);
    deps.settingsService.patch.mockRejectedValueOnce(new Error("Settings file is unavailable"));
    listLlmModelsFromSettingsMock.mockResolvedValueOnce({ ok: true, ...OPENAI_LISTING });
    registerSettingsHandlers(deps as never);

    await expect(invoke(CHANNELS.settings.listLlmModels, { vendor: "openai" })).resolves.toEqual({
      ok: true, ...OPENAI_LISTING, cacheSaveFailed: true,
    });
  });

  it("persists a notice dismissal without refreshing provider bindings", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const deps = {
      ...makeDeps(vi.fn() as unknown as typeof fetch),
      rewireReviewerAgent: vi.fn(),
      refreshActiveLlmWildcard: vi.fn(),
    };
    registerSettingsHandlers(deps as never);
    const patch = { llm: { dismissedModelDeprecations: [{ model: "gpt-4o", catalogEntry: "openai/gpt-4o" }] } };

    await invoke(CHANNELS.settings.update, patch);
    expect(deps.settingsService.patch).toHaveBeenCalledWith(patch);
    expect(deps.conversationLoop.refreshProvider).not.toHaveBeenCalled();
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
    expect(deps.refreshActiveLlmWildcard).not.toHaveBeenCalled();
  });

  it("passes a draft custom endpoint and its wire together", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(makeDeps(vi.fn() as unknown as typeof fetch) as never);
    await invoke(CHANNELS.settings.listLlmModels, { vendor: "openai-compatible", baseUrl: "https://draft.example/v1", wire: "google-gemini" });
    expect(listLlmModelsFromSettingsMock.mock.calls[0]?.[1]).toMatchObject({ baseUrl: "https://draft.example/v1", wire: "google-gemini" });
  });

  it("rejects an unknown draft wire before model discovery", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(makeDeps(vi.fn() as unknown as typeof fetch) as never);
    await expect(invoke(CHANNELS.settings.listLlmModels, { vendor: "openai-compatible", baseUrl: "https://draft.example/v1", wire: "invalid" })).rejects.toThrow(/wire/);
    expect(listLlmModelsFromSettingsMock).not.toHaveBeenCalled();
  });

  it("passes the host transport into the engine as fetchImpl", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const singleHopNetworkFetch = vi.fn() as unknown as typeof fetch;
    registerSettingsHandlers(makeDeps(singleHopNetworkFetch) as never);

    await invoke(CHANNELS.settings.listLlmModels, { vendor: "openai" });

    expect(listLlmModelsFromSettingsMock).toHaveBeenCalledOnce();
    const options = listLlmModelsFromSettingsMock.mock.calls[0]?.[2] as
      | { fetchImpl?: unknown }
      | undefined;
    expect(options?.fetchImpl).toBe(singleHopNetworkFetch);
  });

  it("never leaves the engine to pick up the ambient fetch", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    const singleHopNetworkFetch = vi.fn() as unknown as typeof fetch;
    registerSettingsHandlers(makeDeps(singleHopNetworkFetch) as never);

    await invoke(CHANNELS.settings.listLlmModels, { vendor: "openai" });

    const options = listLlmModelsFromSettingsMock.mock.calls[0]?.[2] as
      | { fetchImpl?: unknown }
      | undefined;
    expect(options?.fetchImpl).toBeDefined();
    expect(options?.fetchImpl).not.toBe(globalThis.fetch);
  });
});
