import { act, renderHook, waitFor } from "@testing-library/react";
import { assert, describe, expect, it, vi } from "vitest";
import { useSettingsOrchestration } from "../use-settings-orchestration.js";
import type { AppSettings, AveApi } from "../../types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { fakeAppSettings } from "../../../../../test/renderer/fake-app-settings.js";
import { marketplaceProviderPresetSecretId } from "../../../../shared/marketplace-package-assets.js";
import { mergeLlmPatch } from "../../../../data/settings-normalization.js";
import type { LLMSettingsPatch } from "../../../../data/settings-store.js";

function openaiBlock(settings: AppSettings) {
  const block = settings.llm.vendors.openai;
  assert.exists(block, "Expected the fixture's configured vendor block");
  return block;
}

function settingsBroadcast(api: ReturnType<typeof makeSettingsApi>): (next: AppSettings) => void {
  const call = api.onSettingsUpdated.mock.calls[0];
  assert.exists(call, "Expected a settings subscription");
  const handler = call[0];
  assert.isFunction(handler);
  return handler;
}

function makeSettings(): AppSettings {
  return fakeAppSettings({
    llm: {
      provider: "openai",
      vendors: {
        openai: {
          model: "gpt-4o",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      streamSmoothing: "none",
      fallbackChain: [],
    },
    chat: { systemPrompt: "", autoCompact: true },
    webSearch: { provider: "duckduckgo" },
    privacy: { piiRedactEnabled: false },
    marketplace: { updateCheckEnabled: true },
  });
}

function withProcessingDisplayLevel(
  settings: AppSettings,
  processingDisplayLevel: AppSettings["chat"]["processingDisplayLevel"],
): AppSettings {
  const updated = structuredClone(settings);
  updated.chat.processingDisplayLevel = processingDisplayLevel;
  return updated;
}

function makeSettingsApi(
  options: Parameters<typeof makeMockAveApi>[0],
  overrides: ReturnType<typeof makeMockAveApi>["api"] = {},
) {
  const { api } = makeMockAveApi(options);
  Object.assign(api, {
    hasWebApiKey: vi.fn(async () => false),
    hasMarketplaceApiKey: vi.fn(async () => false),
    ...overrides,
  });
  return api;
}

function settingsOrchestrationApi(updateResult: Awaited<ReturnType<AveApi["updateSettings"]>>): AveApi {
  const api = makeSettingsApi({ settings: makeSettings(), hasApiKey: false }, {
    updateSettings: vi.fn(async () => updateResult),
  });
  return api as unknown as AveApi;
}

function makeSettingsWithVendor(vendor: string): AppSettings {
  const base = makeSettings();
  return {
    ...base,
    llm: {
      ...base.llm,
      provider: vendor as AppSettings["llm"]["provider"],
      vendors: {
        ...base.llm.vendors,
        [vendor]: {
          model: "some-model",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
    },
  } as AppSettings;
}

describe("useSettingsOrchestration", () => {
  it("exposes an initial load failure and recovers on an explicit user retry", async () => {
    const settings = makeSettings();
    let completeRetry!: (settings: AppSettings) => void;
    const getSettings = vi.fn().mockRejectedValueOnce(new Error("Storage unavailable")).mockImplementationOnce(() => new Promise<AppSettings>((resolve) => { completeRetry = resolve; }));
    const api = makeSettingsApi({ settings }, { getSettings });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.loadError).toBeTruthy());
    expect(result.current.settingsLoaded).toBe(false);
    expect(getSettings).toHaveBeenCalledOnce();
    act(() => result.current.retryLoad());
    expect(result.current.loadError).toBeTruthy();
    await act(async () => { completeRetry(settings); await Promise.resolve(); });
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.loadError).toBeNull();
    expect(getSettings).toHaveBeenCalledTimes(2);
    expect(result.current.model).toBe(openaiBlock(settings).model);
  });

  it("keeps a newer feature edit across unrelated broadcasts and an older write failure", async () => {
    const settings = makeSettings();
    settings.features = { ...settings.features, idlePreferenceRefresh: false };
    let failFirst!: (value: { ok: false; error: string }) => void;
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { failFirst = resolve; }))
      .mockResolvedValue(settings) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setIdlePreferenceRefresh(true));
    const broadcast = settingsBroadcast(api);
    act(() => broadcast(settings));
    expect(result.current.idlePreferenceRefresh).toBe(true);
    act(() => result.current.setIdlePreferenceRefresh(false));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2));
    await act(async () => { failFirst({ ok: false, error: "invalid-args" }); await Promise.resolve(); });
    expect(result.current.idlePreferenceRefresh).toBe(false);
    expect(result.current.lastSaveError).toBeNull();
  });

  it("saves reasoning without replaying model, endpoint, provider or unrelated Chat drafts", async () => {
    const settings = makeSettings();
    const api = makeSettingsApi({ settings });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => { result.current.setEnableThinking(false); result.current.setStreamSmoothing("char"); });
    await act(async () => { await result.current.save("llm"); });
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ llm: { vendors: { openai: { enableThinking: false, thinkingBudgetTokens: 10_000 } } } });
  });

  it("rolls a failed control back to the latest authoritative broadcast", async () => {
    const settings = makeSettings();
    let finish!: (value: { ok: false; error: string }) => void;
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setAutoCompact(false));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save("chat"); });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledOnce());
    const broadcast = settingsBroadcast(api);
    const newer = structuredClone(settings);
    newer.chat.autoCompact = false;
    act(() => broadcast(newer));
    await act(async () => { finish({ ok: false, error: "invalid-args" }); await saving; });
    expect(result.current.autoCompact).toBe(false);
  });

  it("rolls a refused privacy toggle back without marking it saved", async () => {
    const settings = makeSettings();
    const saved = vi.fn();
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(async () => ({ ok: false, error: "invalid-args" })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, saved));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setPiiRedactEnabled(true));
    await act(async () => { expect(await result.current.save("chat")).toBe(false); });
    expect(api.updateSettings).toHaveBeenCalledExactlyOnceWith({ privacy: { piiRedactEnabled: true } });
    expect(result.current.piiRedactEnabled).toBe(false);
    expect(result.current.lastSaveError?.tab).toBe("chat");
    expect(saved).not.toHaveBeenCalled();
  });

  it("rolls back a refused immediate model pick while preserving an explicit fallback draft", async () => {
    const settings = makeSettings();
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(async () => ({ ok: false, error: "invalid-args" })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => { result.current.setModel("unsaved-model"); result.current.setFallbackChain([{ provider: "openai", model: "unsaved-fallback" }]); });
    await act(async () => { expect(await result.current.save("llm")).toBe(false); });
    expect(result.current.model).toBe(openaiBlock(settings).model);
    expect(result.current.fallbackChain).toEqual([{ provider: "openai", model: "unsaved-fallback" }]);
  });

  it("does not report a failed provider secret write as saved", async () => {
    const saved = vi.fn();
    const api = makeSettingsApi({ settings: makeSettings() }, { setApiKey: vi.fn(async () => ({ ok: false, error: "secret-store-unavailable" })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, saved));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    await act(async () => { expect(await result.current.saveProviderCredential({ vendorId: "claude", credentialProviderId: "claude", apiKey: "fixture-key" })).toBe(false); });
    expect(result.current.lastSaveError?.tab).toBe("llm");
    expect(saved).not.toHaveBeenCalled();
  });

  it.each([
    ["idlePreferenceRefresh", "setIdlePreferenceRefresh"],
    ["idleMemoryConsolidation", "setIdleMemoryConsolidation"],
    ["subAgentAutonomousWake", "setSubAgentAutonomousWake"],
  ] as const)("rolls back %s with a visible error when its write is refused", async (field, setter) => {
    const settings = makeSettings();
    const saved = vi.fn();
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(async () => ({ ok: false, error: "invalid-args" })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, saved));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const previous = result.current[field];
    act(() => result.current[setter](!previous));
    await waitFor(() => expect(result.current.lastSaveError?.tab).toBe("chat"));
    expect(result.current[field]).toBe(previous);
    expect(saved).not.toHaveBeenCalled();
  });

  it("persists fallback drafts only through their own explicit save and reconciles the saved chain", async () => {
    const settings = makeSettings();
    const normalized = structuredClone(settings);
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(async () => normalized) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setFallbackChain([{ provider: "openai-compatible", model: "draft" }]));
    await act(async () => { await result.current.save("llm"); });
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(result.current.fallbackChain).toEqual([{ provider: "openai-compatible", model: "draft" }]);
    await act(async () => { await result.current.save("llm-fallback"); });
    expect(api.updateSettings).toHaveBeenLastCalledWith({ llm: { fallbackChain: [{ provider: "openai-compatible", model: "draft" }] } });
    expect(result.current.fallbackChain).toEqual([]);
  });

  it("does not overwrite a newer fallback draft with an older save response", async () => {
    const settings = makeSettings();
    let finish!: (value: AppSettings) => void;
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(() => new Promise<AppSettings>((resolve) => { finish = resolve; })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setFallbackChain([{ provider: "openai", model: "first" }]));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save("llm-fallback"); });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledOnce());
    act(() => result.current.setFallbackChain([{ provider: "openai", model: "newer" }]));
    await act(async () => { finish(settings); await saving; });
    expect(result.current.fallbackChain).toEqual([{ provider: "openai", model: "newer" }]);
  });

  it("never persists a web key draft from automatic tab saves and clears it on provider change", async () => {
    const settings = makeSettings();
    const api = makeSettingsApi({ settings });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setWebProvider("tavily"));
    act(() => result.current.setWebKeyInput("provider-bound-key"));
    await act(async () => { await result.current.save("chat"); await result.current.save("web"); });
    expect(api.setWebApiKey).not.toHaveBeenCalled();
    act(() => result.current.setWebProvider("serper"));
    expect(result.current.webKeyInput).toBe("");
    await act(async () => { expect(await result.current.saveWebApiKey()).toBe(false); });
    expect(api.setWebApiKey).not.toHaveBeenCalled();
    act(() => result.current.setWebKeyInput("second-provider-key"));
    await act(async () => { expect(await result.current.saveWebApiKey()).toBe(true); });
    expect(api.setWebApiKey).toHaveBeenCalledExactlyOnceWith("serper", "second-provider-key");
  });

  it("keeps an unsaved web provider choice when another window's provider arrives", async () => {
    const settings = makeSettings();
    let finish!: (value: AppSettings) => void;
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(() => new Promise<AppSettings>((resolve) => { finish = resolve; })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);
    act(() => result.current.setWebProvider("serper"));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save("web"); });
    act(() => broadcast({ ...settings, webSearch: { provider: "tavily" } }));
    expect(result.current.webProvider).toBe("serper");
    // The host broadcasts this window's own write before replying to it.
    act(() => broadcast({ ...settings, webSearch: { provider: "serper" } }));
    await act(async () => { finish({ ...settings, webSearch: { provider: "serper" } }); await saving; });
    expect(result.current.webProvider).toBe("serper");
    act(() => broadcast({ ...settings, webSearch: { provider: "tavily" } }));
    expect(result.current.webProvider).toBe("tavily");
  });

  it("follows a newer provider another window saved before this window's earlier reply arrived", async () => {
    const settings = makeSettings();
    let finish!: (value: AppSettings) => void;
    const api = makeSettingsApi({ settings }, { updateSettings: vi.fn(() => new Promise<AppSettings>((resolve) => { finish = resolve; })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);
    act(() => result.current.setWebProvider("serper"));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save("web"); });
    // This window's write committed and was broadcast, then another window saved a newer provider before the reply landed.
    act(() => broadcast({ ...settings, webSearch: { provider: "serper" } }));
    act(() => broadcast({ ...settings, webSearch: { provider: "tavily" } }));
    await act(async () => { finish({ ...settings, webSearch: { provider: "serper" } }); await saving; });
    expect(result.current.webProvider).toBe("tavily");
  });

  it("retains a web key draft and reports a refused explicit secret save", async () => {
    const settings = makeSettings();
    const onSaved = vi.fn();
    const api = makeSettingsApi({ settings }, { setWebApiKey: vi.fn(async () => ({ ok: false, error: "secret-store-unavailable" })) });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, onSaved));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => { result.current.setWebProvider("tavily"); });
    act(() => { result.current.setWebKeyInput("keep-me"); });
    await act(async () => { expect(await result.current.saveWebApiKey()).toBe(false); });
    expect(result.current.webKeyInput).toBe("keep-me");
    expect(result.current.lastSaveError?.tab).toBe("web");
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("preserves an external model and reasoning change through a Chat-tab save", async () => {
    const settings = makeSettings();
    const api = makeSettingsApi({ settings });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);
    const next = structuredClone(settings);
    openaiBlock(next).model = "external-model";
    openaiBlock(next).enableThinking = false;
    act(() => broadcast(next));
    expect(result.current.model).toBe("external-model");
    expect(result.current.enableThinking).toBe(false);
    act(() => result.current.setAutoCompact(false));
    await act(async () => { await result.current.save("chat"); });
    expect(api.updateSettings).toHaveBeenCalledWith({ chat: { autoCompact: false } });
  });

  it("keeps local model and thinking drafts while hydrating clean fields from a broadcast", async () => {
    const settings = makeSettings();
    const api = makeSettingsApi({ settings });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);
    act(() => { result.current.setModel("local-draft"); result.current.setEnableThinking(false); });
    const next = structuredClone(settings);
    openaiBlock(next).model = "external-model";
    openaiBlock(next).baseUrl = "https://new.example/v1";
    next.llm.fallbackChain = [{ provider: "openai", model: "fallback-model" }];
    act(() => broadcast(next));
    expect(result.current.model).toBe("local-draft");
    expect(result.current.enableThinking).toBe(false);
    expect(result.current.baseUrl).toBe("https://new.example/v1");
    expect(result.current.fallbackChain).toEqual(next.llm.fallbackChain);
  });

  it("does not mark a newer model draft clean when an older save finishes", async () => {
    const settings = makeSettings();
    let finish!: (value: AppSettings) => void;
    const api = makeSettingsApi({ settings }, {
      updateSettings: vi.fn(() => new Promise<AppSettings>((resolve) => { finish = resolve; })),
    });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setModel("first"));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save("llm"); });
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledOnce());
    act(() => result.current.setModel("second"));
    await act(async () => { finish(settings); await saving; });
    const broadcast = settingsBroadcast(api);
    act(() => broadcast(settings));
    expect(result.current.model).toBe("second");
  });

  it("saves an empty model as an explicit unselected route", async () => {
    const settings = makeSettings();
    openaiBlock(settings).model = "";
    const api = makeSettingsApi({ settings, hasApiKey: true });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.model).toBe("");
    act(() => result.current.setModel(""));
    await act(async () => result.current.save("llm"));
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ vendors: expect.objectContaining({ openai: expect.objectContaining({ model: "" }) }) }),
    }));
  });

  it.each(["chat", "web", "llm"])("keeps retirement pending when %s settings are saved without a provider choice", async (tab) => {
    let settings = makeSettings();
    settings.llm.retiredProvider = "copilot";
    const { api } = makeMockAveApi({ settings });
    api.updateSettings = vi.fn(async (patch: Parameters<AveApi["updateSettings"]>[0]) => {
      settings = {
        ...settings,
        llm: mergeLlmPatch(settings.llm, patch.llm as LLMSettingsPatch ?? {}, settings.marketplace.installedProviderPresets),
      };
      return settings;
    });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.setProcessingDisplayLevel("tools"));
    await act(async () => { expect(await result.current.save(tab)).toBe(true); });
    expect(settings.llm.retiredProvider).toBe("copilot");
    expect(api.updateSettings.mock.calls[0]?.[0].llm ?? {}).not.toHaveProperty("provider");
  });

  it("releases retirement after choosing the same provider and model explicitly", async () => {
    let settings = makeSettings();
    settings.llm.retiredProvider = "copilot";
    const { api } = makeMockAveApi({ settings });
    api.updateSettings = vi.fn(async (patch: Parameters<AveApi["updateSettings"]>[0]) => {
      settings = {
        ...settings,
        llm: mergeLlmPatch(settings.llm, patch.llm as LLMSettingsPatch ?? {}, settings.marketplace.installedProviderPresets),
      };
      return settings;
    });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    act(() => result.current.selectApiVendorModel("openai", "gpt-4o"));
    await act(async () => { expect(await result.current.save("llm")).toBe(true); });
    expect(settings.llm.retiredProvider).toBeUndefined();
    expect(api.updateSettings.mock.calls[0]?.[0].llm).toHaveProperty("provider", "openai");
  });

  it("carries the retirement marker to the chooser and clears it on a fresh settings snapshot", async () => {
    const settings = makeSettings();
    settings.llm.retiredProvider = "copilot";
    const { api } = makeMockAveApi({ settings });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.retiredLlmProvider).toBe("copilot"));
    const next = structuredClone(settings);
    delete next.llm.retiredProvider;
    const broadcast = settingsBroadcast(api);
    act(() => broadcast(next));
    expect(result.current.retiredLlmProvider).toBeNull();
  });
  it("hydrates and saves the processing detail through the chat patch", async () => {
    const settings = makeSettings();
    settings.chat.processingDisplayLevel = "reasoning";
    const saved = withProcessingDisplayLevel(settings, "tools");
    const api = makeSettingsApi({ settings }, {
      updateSettings: vi.fn(async () => saved),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn()),
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.processingDisplayLevel).toBe("reasoning");

    act(() => result.current.setProcessingDisplayLevel("tools"));
    await act(async () => {
      await result.current.save("chat");
    });

    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ processingDisplayLevel: "tools" }),
    }));
    expect(result.current.processingDisplayLevel).toBe("tools");
  });

  it("syncs external processing detail without clobbering a pending local edit", async () => {
    const settings = makeSettings();
    settings.chat.processingDisplayLevel = "full";
    const saved = withProcessingDisplayLevel(settings, "tools");
    const api = makeSettingsApi({ settings }, {
      updateSettings: vi.fn(async () => saved),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn()),
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);

    const external = structuredClone(settings);
    external.chat.processingDisplayLevel = "reasoning";
    act(() => broadcast(external));
    expect(result.current.processingDisplayLevel).toBe("reasoning");

    act(() => result.current.setProcessingDisplayLevel("tools"));
    act(() => broadcast(external));
    expect(result.current.processingDisplayLevel).toBe("tools");

    await act(async () => {
      await result.current.save("chat");
    });
    expect(api.updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ processingDisplayLevel: "tools" }),
    }));

    const afterSave = structuredClone(settings);
    afterSave.chat.processingDisplayLevel = "reasoning";
    act(() => broadcast(afterSave));
    expect(result.current.processingDisplayLevel).toBe("reasoning");
  });

  it("reconciles an authoritative save result after a broadcast arrived while the draft was dirty", async () => {
    const settings = makeSettings();
    settings.chat.processingDisplayLevel = "full";
    const authoritative = withProcessingDisplayLevel(settings, "reasoning");
    let resolveFirstSave!: (value: AppSettings) => void;
    const updateSettings = vi.fn(() => new Promise<AppSettings>((resolve) => {
      resolveFirstSave = resolve;
    }));
    const api = makeSettingsApi({ settings }, {
      updateSettings,
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn()),
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);

    act(() => result.current.setProcessingDisplayLevel("tools"));
    let firstSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.save("chat");
    });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    act(() => broadcast(authoritative));
    expect(result.current.processingDisplayLevel).toBe("tools");

    await act(async () => {
      resolveFirstSave(authoritative);
      await firstSave;
    });

    expect(result.current.processingDisplayLevel).toBe("reasoning");
  });

  it("keeps a newer processing detail edit dirty when an older save finishes", async () => {
    const settings = makeSettings();
    settings.chat.processingDisplayLevel = "full";
    const firstSaveResult = withProcessingDisplayLevel(settings, "tools");
    const secondSaveResult = withProcessingDisplayLevel(settings, "reasoning");
    let resolveFirstSave!: (value: AppSettings) => void;
    const updateSettings = vi.fn()
      .mockImplementationOnce(() => new Promise<AppSettings>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockResolvedValue(secondSaveResult);
    const api = makeSettingsApi({ settings }, {
      updateSettings,
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn()),
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    const broadcast = settingsBroadcast(api);

    act(() => result.current.setProcessingDisplayLevel("tools"));
    let firstSave!: Promise<boolean>;
    act(() => {
      firstSave = result.current.save("chat");
    });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledOnce());
    act(() => result.current.setProcessingDisplayLevel("reasoning"));
    await act(async () => {
      resolveFirstSave(firstSaveResult);
      await firstSave;
    });

    expect(result.current.processingDisplayLevel).toBe("reasoning");

    const oldSnapshot = structuredClone(settings);
    oldSnapshot.chat.processingDisplayLevel = "tools";
    act(() => broadcast(oldSnapshot));
    expect(result.current.processingDisplayLevel).toBe("reasoning");

    await act(async () => {
      await result.current.save("chat");
    });
    expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      chat: expect.objectContaining({ processingDisplayLevel: "reasoning" }),
    }));

    const laterSnapshot = structuredClone(settings);
    laterSnapshot.chat.processingDisplayLevel = "full";
    act(() => broadcast(laterSnapshot));
    expect(result.current.processingDisplayLevel).toBe("full");
  });

  it("preserves effort intent across output broadcasts without overwriting form edits", async () => {
    const settings = makeSettings();
    settings.llm.vendors.openai = {
      ...openaiBlock(settings), thinkingBudgetTokens: 14_000, outputTokenLimit: 32_000,
    };
    const api = makeSettingsApi({ settings }, {
      updateSettings: vi.fn(async () => settings),
    });
    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.thinkingBudget).toBe(14_000);
    await act(async () => result.current.setModel("unsaved-model"));
    const broadcast = settingsBroadcast(api);
    await act(async () => broadcast({
      ...settings, llm: { ...settings.llm, vendors: { openai: {
        ...openaiBlock(settings), outputTokenLimit: 16_000,
      } } },
    }));
    expect(result.current.outputTokenLimit).toBe(16_000);
    expect(result.current.thinkingBudget).toBe(14_000);
    expect(result.current.model).toBe("unsaved-model");
    await act(async () => result.current.save("llm"));
    const update = api.updateSettings.mock.calls[0];
    assert.exists(update);
    const patch = update[0] as { llm: { vendors: { openai: Record<string, unknown> } } };
    expect(patch.llm.vendors.openai).toEqual({ model: "unsaved-model" });
    expect(patch.llm.vendors.openai).not.toHaveProperty("outputTokenLimit");
    await act(async () => broadcast({
      ...settings, llm: { ...settings.llm, vendors: { openai: {
        ...openaiBlock(settings), outputTokenLimit: 64_000,
      } } },
    }));
    expect(result.current.outputTokenLimit).toBe(64_000);
    expect(result.current.thinkingBudget).toBe(14_000);
  });

  // Start with no selected provider so the pre-hydration UI cannot flash a stale default.
  it("initialises vendor to empty string before settings load (no stale 'claude' flash)", () => {
    const { api } = makeMockAveApi({ settings: makeSettingsWithVendor("openai") });
    // Pause getSettings so we can inspect the pre-hydration state.
    let resolve: () => void;
    const blocked = new Promise<void>((r) => { resolve = r; });
    const blockedGetSettings = vi.fn(async () => { await blocked; return makeSettingsWithVendor("openai"); });
    Object.assign(api, { getSettings: blockedGetSettings });

    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    // Before hydration the vendor must be "" — not "claude".
    expect(result.current.vendor).toBe("");
    expect(result.current.settingsLoaded).toBe(false);
    // Unblock so further tests are clean.
    resolve!();
  });

  it("hydrates vendor from persisted settings on mount (not the old 'claude' default)", async () => {
    const settings = makeSettingsWithVendor("openai");
    const api = makeSettingsApi({ settings, hasApiKey: false });

    const { result } = renderHook(() => useSettingsOrchestration(api as unknown as AveApi, vi.fn()));
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    // After hydration: vendor must be "openai", not "claude".
    expect(result.current.vendor).toBe("openai");
  });

  it("aborts a card's key persistence when settings:update returns reviewer-rewire-failed", async () => {
    const api = settingsOrchestrationApi({ ok: false, error: "reviewer-rewire-failed" });
    const onSaved = vi.fn();
    const { result } = renderHook(() => useSettingsOrchestration(api, onSaved));

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    let saved = true;
    await act(async () => {
      saved = await result.current.saveProviderCredential({
        credentialProviderId: "openai-compatible",
        vendorId: "openai-compatible",
        apiKey: "sk-new-key",
        vendorBlock: { baseUrl: "https://gateway.example/v1" },
      });
    });

    expect(saved).toBe(false);
    expect(api.updateSettings).toHaveBeenCalled();
    // A key must never land beside an endpoint the store refused.
    expect(api.setApiKey).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(result.current.lastSaveError).toMatchObject({
      tab: "llm",
      message: expect.stringContaining("권한 검토 모델"),
    });
  });

  it("queues a card's save behind an in-flight one instead of dropping it", async () => {
    // Queue credential saves behind debounced tab saves instead of silently refusing them.
    let releaseFirstSave: (() => void) | undefined;
    const settings = makeSettings();
    const api = makeSettingsApi({ settings, hasApiKey: false }, {
      updateSettings: vi.fn(async () => {
        await new Promise<void>((resolve) => { releaseFirstSave = resolve; });
        return settings;
      }),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => result.current.setModel("queued-model"));
    let queued: Promise<boolean> | undefined;
    await act(async () => {
      void result.current.save("llm");
      await Promise.resolve();
      queued = result.current.saveProviderCredential({
        credentialProviderId: "claude",
        vendorId: "claude",
        apiKey: "sk-ant-queued",
      });
    });
    // Still in the queue: the key has not been written yet.
    expect(api.setApiKey).not.toHaveBeenCalled();

    await act(async () => {
      releaseFirstSave?.();
      expect(await queued).toBe(true);
    });
    expect(api.setApiKey).toHaveBeenCalledWith("claude", "sk-ant-queued");
  });

  it("writes a card's own block and secret without touching the active provider", async () => {
    const api = makeSettingsApi({ settings: makeSettings(), hasApiKey: false }, {
      updateSettings: vi.fn(async () => ({ ok: true })),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.vendor).toBe("openai");

    await act(async () => {
      await result.current.saveProviderCredential({
        credentialProviderId: "claude",
        vendorId: "claude",
        apiKey: "sk-ant-1",
      });
    });

    expect(api.setApiKey).toHaveBeenCalledWith("claude", "sk-ant-1");
    // No settings write at all: a fixed-endpoint vendor owns no field here, and `llm.provider` is not this call's to move.
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(result.current.vendor).toBe("openai");
  });

  it("persists custom marketplace provider presets through openai-compatible with a preset-scoped key", async () => {
    const settings = makeSettings();
    const futureRouter = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [futureRouter],
    };
    const api = makeSettingsApi({ settings, hasApiKey: false }, {
      updateSettings: vi.fn(async () => settings),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, onSaved)
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => {
      result.current.selectMarketplaceProviderPreset(futureRouter);
    });
    await waitFor(() => expect(result.current.vendor).toBe("openai-compatible"));
    expect(result.current.model).toBe("");

    let saved = false;
    await act(async () => {
      saved = await result.current.saveProviderCredential({
        credentialProviderId: marketplaceProviderPresetSecretId("future-router"),
        vendorId: "openai-compatible",
        apiKey: "fr-secret",
      });
      saved = await result.current.save("llm");
    });

    expect(saved).toBe(true);
    expect(api.updateSettings).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({
        provider: "openai-compatible",
        marketplaceProviderPresetId: "future-router",
        vendors: {
          // Write the preset's own model slot; the vendor block belongs to the generic provider row.
          "openai-compatible": expect.objectContaining({
            presetModels: { "future-router": "" },
          }),
        },
      }),
    }));
    const savedBlock = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { llm?: { vendors?: Record<string, { model?: string }> } })
      .filter((call) => Boolean(call.llm?.vendors))
      .at(-1)?.llm?.vendors?.["openai-compatible"];
    expect(savedBlock).not.toHaveProperty("model");
    // Read preset endpoints from the registry; never overwrite the generic row's stored endpoint.
    const presetSave = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { llm?: { vendors?: Record<string, { baseUrl?: string }> } })
      .filter((call) => Boolean(call.llm?.vendors))
      .at(-1);
    expect(presetSave?.llm?.vendors?.["openai-compatible"]?.baseUrl)
      .not.toBe("https://future.example/v1");
    expect(api.setApiKey).toHaveBeenCalledWith(
      marketplaceProviderPresetSecretId("future-router"),
      "fr-secret",
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it("leaves the generic OpenAI-compatible endpoint alone across a preset selection", async () => {
    const settings = makeSettings();
    const futureRouter = {
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free"],
      requiresApiKey: true,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [futureRouter],
    };
    const api = makeSettingsApi({ settings, hasApiKey: false }, {
      updateSettings: vi.fn(async () => settings),
      setApiKey: vi.fn(async () => ({ ok: true })),
    });
    settings.llm.vendors["openai-compatible"] = {
      model: "local-model",
      baseUrl: "http://localhost:8001/v1",
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    };
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => {
      result.current.selectMarketplaceProviderPreset(futureRouter);
    });
    await waitFor(() => expect(result.current.vendor).toBe("openai-compatible"));
    // Selecting a preset must not park the preset's address in the generic row's endpoint: that field is written back on every
    // save.
    expect(result.current.baseUrl).toBe("http://localhost:8001/v1");

    act(() => {
      result.current.clearMarketplaceProviderPreset();
    });
    // And switching back restores the generic row's own endpoint rather than resetting it to defaults.
    await waitFor(() => expect(result.current.baseUrl).toBe("http://localhost:8001/v1"));

    await act(async () => {
      await result.current.save("llm");
    });

    const payload = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(payload).toMatchObject({
      llm: {
        provider: "openai-compatible",
        marketplaceProviderPresetId: "",
      },
    });
    expect(payload.llm.vendors["openai-compatible"]).not.toHaveProperty("baseUrl");
  });

  it("defaults idle long-term consolidation off and persists an explicit opt-in immediately", async () => {
    const settings = makeSettings();
    const updated: AppSettings = {
      ...settings,
      features: { idleMemoryConsolidation: true },
    };
    const api = makeSettingsApi({ settings, hasApiKey: false }, {
      updateSettings: vi.fn(async () => updated),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, onSaved)
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.idleMemoryConsolidation).toBe(false);

    act(() => {
      result.current.setIdleMemoryConsolidation(true);
    });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      features: { idleMemoryConsolidation: true },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(result.current.idleMemoryConsolidation).toBe(true);
  });

  it("defaults autonomous sub-agent wake off and persists an opt-in immediately", async () => {
    // No persisted `features` block at all: the renderer must read that as "off".
    const { features: _hostDefaults, ...settings } = makeSettings();
    const updated: AppSettings = {
      ...settings,
      features: { subAgentAutonomousWake: true },
    };
    const api = makeSettingsApi({ settings, hasApiKey: false }, {
      updateSettings: vi.fn(async () => updated),
    });
    const onSaved = vi.fn();
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, onSaved)
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.subAgentAutonomousWake).toBe(false);

    act(() => {
      result.current.setSubAgentAutonomousWake(true);
    });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({
      features: { subAgentAutonomousWake: true },
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(result.current.subAgentAutonomousWake).toBe(true);
  });

  it("hydrates autonomous sub-agent wake from persisted settings", async () => {
    const settings = makeSettings();
    settings.features = { subAgentAutonomousWake: true };
    const api = makeSettingsApi({ settings, hasApiKey: false });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn())
    );

    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
    expect(result.current.subAgentAutonomousWake).toBe(true);
  });

  it("keeps every openai-compatible row's model to itself", async () => {
    // Keep model choices independent for rows sharing the same underlying vendor.
    const alpha = {
      providerId: "alpha-gw",
      label: "Alpha Gateway",
      baseUrl: "https://alpha.example/v1",
      defaultModel: "alpha/seed",
      modelOptions: ["alpha/seed"],
      requiresApiKey: true,
    };
    const beta = { ...alpha, providerId: "beta-gw", label: "Beta Gateway", baseUrl: "https://beta.example/v1", defaultModel: "beta/seed", modelOptions: ["beta/seed"] };
    const settings = makeSettings();
    settings.llm.vendors["openai-compatible"] = {
      model: "local-model",
      baseUrl: "http://localhost:8001/v1",
      presetModels: { "beta-gw": "beta/chosen" },
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    };
    settings.marketplace = {
      ...settings.marketplace,
      installedProviderPresets: [alpha, beta],
    };
    const api = makeSettingsApi({ settings, hasApiKey: false }, {
      updateSettings: vi.fn(async () => settings),
    });
    const { result } = renderHook(() =>
      useSettingsOrchestration(api as unknown as AveApi, vi.fn())
    );
    await waitFor(() => expect(result.current.settingsLoaded).toBe(true));

    act(() => { result.current.selectMarketplaceProviderPreset(alpha); });
    await waitFor(() => expect(result.current.marketplaceProviderPresetId).toBe("alpha-gw"));
    expect(result.current.model).toBe("");
    act(() => { result.current.setModel("alpha/chosen"); });
    await act(async () => { await result.current.save("llm"); });

    const block = (api.updateSettings as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => call[0] as { llm?: { vendors?: Record<string, {
        model?: string; presetModels?: Record<string, string>;
      }> } })
      .filter((call) => Boolean(call.llm?.vendors))
      .at(-1)?.llm?.vendors?.["openai-compatible"];
    // Alpha's key ALONE — the stored map is merged on the main side, so this save cannot carry a stale copy of beta's model
    // back over a newer one. The generic row's `model` is not written at all, so it survives too.
    expect(block?.presetModels).toEqual({ "alpha-gw": "alpha/chosen" });
    expect(block).not.toHaveProperty("model");

    // Switching rows restores what each row was last set to.
    act(() => { result.current.selectMarketplaceProviderPreset(beta); });
    await waitFor(() => expect(result.current.model).toBe("beta/chosen"));
    act(() => { result.current.clearMarketplaceProviderPreset(); });
    await waitFor(() => expect(result.current.model).toBe("local-model"));
  });});
