import { strict as assert } from "node:assert";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMSettingsPatch, SettingsService } from "../../data/settings-store.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import { mergeLlmPatch } from "../../data/settings-normalization.js";
import { systemSubagentRouteIdentity } from "../../shared/system-subagent-model.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import type { LLMProvider } from "../llm/types.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

const { createProvider, streamTurn } = vi.hoisted(() => {
  const streamTurn = vi.fn(async function* () {
    yield { type: "text_delta", text: "recap" };
    yield { type: "done", stopReason: "end_turn" };
  });
  return { streamTurn, createProvider: vi.fn((_config: unknown) => ({ vendor: "openai-compatible", streamTurn })) };
});
vi.mock("../llm/provider-factory.js", () => ({
  createProvider, secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
}));

import { createSystemSubagentProviderPlan, resolveSystemSubagentRoute, systemSubagentLlmSettings, systemSubagentModelOptions } from "../system-subagent-route.js";

function fixture() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.activeChatRuntime = { kind: "subscription", provider: "claude-code", model: "main-model" };
  settings.llm.provider = "openai-compatible";
  settings.llm.marketplaceProviderPresetId = "summary-a";
  settings.llm.vendors["openai-compatible"] = {
    ...getLlmVendorSettings(settings.llm.vendors, "openai-compatible"), model: "summary-model", baseUrl: "https://generic.example/v1",
  };
  settings.marketplace.installedProviderPresets = ["a", "b"].map((id) => ({
    providerId: `summary-${id}`, label: `Summary ${id.toUpperCase()}`, baseUrl: `https://summary-${id}.example/v1`,
    requiresApiKey: true, defaultModel: "summary-model", modelOptions: ["summary-model"], modelDiscoveryPolicy: "static" as const,
  }));
  const secrets: Record<string, string> = {
    "llm.apiKey.openai-compatible": "generic-key",
    [marketplaceProviderPresetSecretKey("summary-a")]: "preset-a-key",
    [marketplaceProviderPresetSecretKey("summary-b")]: "preset-b-key",
  };
  const getSecret = vi.fn(async (key: string): Promise<string | null> => secrets[key] ?? null);
  const settingsService = {
    get: (key: keyof typeof settings) => structuredClone(settings[key]), getSecret,
  } as unknown as SettingsService;
  const subscriptionProviderFactory = vi.fn(() => null as LLMProvider | null);
  const selection = (presetId?: string) => {
    const route = systemSubagentRouteIdentity(settings.llm, "openai-compatible", settings.marketplace.installedProviderPresets, presetId);
    assert(route);
    return { vendor: "openai-compatible" as const, model: "summary-model", route };
  };
  const storedSelection = () => {
    const selected = settings.llm.compactionModelSelection;
    assert(selected);
    return selected;
  };
  const patch = (value: LLMSettingsPatch) => {
    settings.llm = mergeLlmPatch(settings.llm, value, settings.marketplace.installedProviderPresets);
  };
  return { settings, secrets, getSecret, selection, storedSelection, patch,
    deps: { settingsService, networkFetch: unusedNetworkFetch, subscriptionProviderFactory } };
}

beforeEach(() => vi.clearAllMocks());

describe("system subagent routes", () => {
  it("calls a configured provider independently of the active subscription", async () => {
    const { deps, settings, selection } = fixture();
    const selected = selection("summary-a");
    const route = await resolveSystemSubagentRoute(deps, selected);
    const events = [];
    for await (const event of route.provider.streamTurn({
      systemPrompt: "Summarize", messages: [{ role: "user", content: "History" }], tools: [], model: route.model,
    })) events.push(event);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      vendor: selected.vendor, model: selected.model, apiKey: "preset-a-key", baseUrl: "https://summary-a.example/v1",
    }));
    expect(streamTurn).toHaveBeenLastCalledWith(expect.objectContaining({ model: "summary-model" }));
    expect(events).toContainEqual({ type: "text_delta", text: "recap" });
    expect(deps.subscriptionProviderFactory).not.toHaveBeenCalled();
    expect(route.llmSettings).toEqual(systemSubagentLlmSettings(deps.settingsService, selected));
    expect(route.llmSettings.activeChatRuntime).toEqual({ kind: "api" });
    expect(route.llmSettings.vendors["openai-compatible"]?.presetModels).toMatchObject({ "summary-a": "summary-model" });
    expect(settings.llm.activeChatRuntime).toEqual({ kind: "subscription", provider: "claude-code", model: "main-model" });
  });

  it("offers independently authenticated generic and preset destinations", async () => {
    const { deps, selection } = fixture();
    const options = await systemSubagentModelOptions(deps.settingsService);
    expect(options).toEqual(expect.arrayContaining([selection(), selection("summary-a"), selection("summary-b")]));
    expect(options.filter((ref) => ref.vendor === "openai-compatible" && ref.model === "summary-model")).toHaveLength(3);
  });

  it.each([
    { provider: "openai" as const },
    { provider: "openai-compatible" as const, marketplaceProviderPresetId: "summary-b" },
  ])("retains a saved preset destination across chat changes %j", async (chatPatch) => {
    const { deps, settings, selection, storedSelection, patch } = fixture();
    const selected = selection("summary-a");
    patch({ compactionModelSelection: selected });
    patch(chatPatch);
    expect(settings.llm.compactionModelSelection).toEqual(selected);
    await resolveSystemSubagentRoute(deps, storedSelection());
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "summary-model", apiKey: "preset-a-key", baseUrl: "https://summary-a.example/v1",
    }));
    expect(deps.subscriptionProviderFactory).not.toHaveBeenCalled();
  });

  it("uses the generic route credential even when chat selects a preset", async () => {
    const { deps, selection, storedSelection, patch } = fixture();
    patch({ compactionModelSelection: selection() });
    patch({ marketplaceProviderPresetId: "summary-b" });
    await resolveSystemSubagentRoute(deps, storedSelection());
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "summary-model", apiKey: "generic-key", baseUrl: "https://generic.example/v1",
    }));
    expect(createProvider.mock.lastCall?.[0]).not.toHaveProperty("providerMetadata");
  });

  it.each(["removed", "endpoint-changed", "credential-scope-changed"] as const)(
    "refuses a saved destination when %s", async (change) => {
      const { deps, settings, selection, storedSelection, patch } = fixture();
      const selected = selection("summary-a");
      patch({ compactionModelSelection: selected });
      patch({ marketplaceProviderPresetId: "summary-b" });
      if (change === "removed") {
        settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.filter((preset) => preset.providerId !== "summary-a");
      } else if (change === "endpoint-changed") {
        settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.map((preset) =>
          preset.providerId === "summary-a" ? { ...preset, baseUrl: "https://replacement.example/v1" } : preset);
      } else {
        patch({ compactionModelSelection: { ...selected, route: { ...selected.route, credentialScope: marketplaceProviderPresetSecretKey("summary-b") } } });
      }
      await expect(resolveSystemSubagentRoute(deps, storedSelection()))
        .rejects.toThrow("System subagent model is unavailable: openai-compatible/summary-model");
      expect(createProvider).not.toHaveBeenCalled();
      expect(deps.subscriptionProviderFactory).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "summary-a"])("migrates the historical destination %s across later chat changes", async (presetId) => {
    const { deps, settings, selection, storedSelection, patch } = fixture();
    const historical = selection(presetId);
    delete settings.llm.compactionModelSelection;
    settings.llm.compactionModel = "summary-model";
    settings.llm.compactionModelRoute = JSON.stringify(["api", llmModelListCacheKey(
      "openai-compatible", historical.route.baseUrl, presetId,
    ), "", ""]);
    patch({});
    expect(settings.llm.compactionModelSelection).toEqual(historical);
    patch({ marketplaceProviderPresetId: "summary-b" });
    patch({ provider: "openai" });
    await resolveSystemSubagentRoute(deps, storedSelection());
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      baseUrl: historical.route.baseUrl, apiKey: presetId ? "preset-a-key" : "generic-key",
    }));
  });

  it("keeps a selected connected route available when the chat route is retired", async () => {
    const { deps, settings, selection } = fixture();
    settings.llm.retiredProvider = { vendor: "openai", model: "retired-chat-model", reason: "unlisted" } as never;
    const route = await resolveSystemSubagentRoute(deps, selection("summary-a"));
    expect(route.model).toBe("summary-model");
    expect(route.llmSettings.retiredProvider).toBeUndefined();
  });

  it("rejects a summary model removed from the connected endpoint listing", async () => {
    const { deps, settings, selection } = fixture();
    const selected = selection("summary-a");
    settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.map((preset) => ({ ...preset, modelDiscoveryPolicy: "models-api" }));
    settings.llm.modelListCache[llmModelListCacheKey("openai-compatible", selected.route.baseUrl, "summary-a")] = {
      vendor: "openai-compatible", baseUrl: selected.route.baseUrl, credentialScope: "summary-a",
      endpoint: "https://summary-a.example/v1/models", models: ["replacement-model"], complete: true,
      fetchedAt: "2026-11-11T00:00:00.000Z",
    };
    await expect(resolveSystemSubagentRoute(deps, selected))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/summary-model");
  });

  it("refuses a changed destination while credential reads are pending", async () => {
    const { deps, getSecret, settings, selection } = fixture();
    const selected = selection("summary-a");
    getSecret.mockImplementationOnce(async (key) => {
      settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.map((preset) =>
        preset.providerId === "summary-a" ? { ...preset, baseUrl: "https://replacement.example/v1" } : preset);
      return key === marketplaceProviderPresetSecretKey("summary-a") ? "preset-a-key" : "generic-key";
    });
    await expect(resolveSystemSubagentRoute(deps, selected))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/summary-model");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("fails when the selected provider disconnects or the selected model disappears", async () => {
    const { deps, getSecret, selection } = fixture();
    const selected = selection("summary-a");
    await expect(resolveSystemSubagentRoute(deps, { ...selected, model: "removed-model" }))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/removed-model");
    getSecret.mockResolvedValue(null);
    expect(await systemSubagentModelOptions(deps.settingsService)).not.toContainEqual(selected);
    await expect(resolveSystemSubagentRoute(deps, selected))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/summary-model");
    expect(deps.subscriptionProviderFactory).not.toHaveBeenCalled();
  });

  it("refuses a provider plan when its credential requirements change before construction", () => {
    const { deps, settings, selection } = fixture();
    settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.map((preset) =>
      preset.providerId === "summary-a" ? { ...preset, requiresApiKey: false } : preset);
    const selected = selection("summary-a");
    const plan = createSystemSubagentProviderPlan(deps, selected.vendor, selected.model, selected.route);
    assert(plan);
    expect(plan.isConnected(null)).toBe(true);
    settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.map((preset) =>
      preset.providerId === "summary-a" ? { ...preset, requiresApiKey: true } : preset);
    expect(plan.build(null)).toBeNull();
    expect(createProvider).not.toHaveBeenCalled();
  });
});
