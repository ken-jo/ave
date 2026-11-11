import { describe, expect, it, vi } from "vitest";
import type { SettingsService } from "../../data/settings-store.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import type { LLMProvider } from "../llm/types.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

const { createProvider, streamTurn } = vi.hoisted(() => {
  const streamTurn = vi.fn(async function* () {
    yield { type: "text_delta", text: "recap" };
    yield { type: "done", stopReason: "end_turn" };
  });
  return { streamTurn, createProvider: vi.fn(() => ({ vendor: "openai-compatible", streamTurn })) };
});
vi.mock("../llm/provider-factory.js", () => ({
  createProvider, secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
}));

import { resolveSystemSubagentRoute, systemSubagentLlmSettings, systemSubagentModelOptions } from "../system-subagent-route.js";

function fixture() {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.llm.activeChatRuntime = { kind: "subscription", provider: "claude-code", model: "main-model" };
  settings.llm.provider = "openai-compatible";
  settings.llm.marketplaceProviderPresetId = "summary-route";
  settings.marketplace.installedProviderPresets = [{
    providerId: "summary-route", baseUrl: "https://summary.example/v1", requiresApiKey: true,
    defaultModel: "summary-model", modelOptions: ["summary-model"], modelDiscoveryPolicy: "static",
  } as never];
  const getSecret = vi.fn(async () => "connected-key" as string | null);
  const settingsService = {
    get: (key: keyof typeof settings) => settings[key], getSecret,
  } as unknown as SettingsService;
  const subscriptionProviderFactory = vi.fn(() => null as LLMProvider | null);
  return {
    settings, getSecret,
    deps: { settingsService, networkFetch: unusedNetworkFetch, subscriptionProviderFactory },
  };
}

describe("system subagent routes", () => {
  it("calls a configured provider independently of the active subscription", async () => {
    createProvider.mockClear();
    streamTurn.mockClear();
    const { deps, settings } = fixture();
    const selected = { vendor: "openai-compatible" as const, model: "summary-model" };
    const route = await resolveSystemSubagentRoute(deps, selected);
    const events = [];
    for await (const event of route.provider.streamTurn({
      systemPrompt: "Summarize", messages: [{ role: "user", content: "History" }],
      tools: [], model: route.model,
    })) events.push(event);
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      vendor: selected.vendor, model: selected.model, apiKey: "connected-key", baseUrl: "https://summary.example/v1",
    }));
    expect(streamTurn).toHaveBeenLastCalledWith(expect.objectContaining({ model: "summary-model" }));
    expect(events).toContainEqual({ type: "text_delta", text: "recap" });
    expect(deps.subscriptionProviderFactory).not.toHaveBeenCalled();
    expect(route.llmSettings).toEqual(systemSubagentLlmSettings(deps.settingsService, selected));
    expect(route.llmSettings.activeChatRuntime).toEqual({ kind: "api" });
    expect(route.llmSettings.vendors["openai-compatible"]?.presetModels).toMatchObject({ "summary-route": "summary-model" });
    expect(settings.llm.activeChatRuntime).toEqual({ kind: "subscription", provider: "claude-code", model: "main-model" });
  });

  it("keeps a selected connected route available when the chat route is retired", async () => {
    const { deps, settings } = fixture();
    settings.llm.retiredProvider = { vendor: "openai", model: "retired-chat-model", reason: "unlisted" } as never;
    const route = await resolveSystemSubagentRoute(deps, { vendor: "openai-compatible", model: "summary-model" });
    expect(route.model).toBe("summary-model");
    expect(route.llmSettings.retiredProvider).toBeUndefined();
  });

  it("rejects a summary model removed from the connected endpoint listing", async () => {
    const { deps, settings } = fixture();
    settings.marketplace.installedProviderPresets = settings.marketplace.installedProviderPresets.map((preset) => ({
      ...preset, modelDiscoveryPolicy: "models-api",
    }));
    settings.llm.modelListCache = {
      "openai-compatible\nhttps://summary.example/v1\nsummary-route": {
        vendor: "openai-compatible", baseUrl: "https://summary.example/v1", credentialScope: "summary-route",
        endpoint: "https://summary.example/v1/models", models: ["replacement-model"], complete: true,
        fetchedAt: "2026-11-11T00:00:00.000Z",
      },
    };
    await expect(resolveSystemSubagentRoute(deps, { vendor: "openai-compatible", model: "summary-model" }))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/summary-model");
  });

  it("keeps provider construction and request limits on one route across credential reads", async () => {
    createProvider.mockClear();
    const { deps, getSecret, settings } = fixture();
    getSecret.mockImplementationOnce(async () => {
      settings.marketplace = {
        ...settings.marketplace,
        installedProviderPresets: settings.marketplace.installedProviderPresets.map((preset) => ({
          ...preset, baseUrl: "https://replacement.example/v1",
        })),
      };
      return "connected-key";
    });
    const route = await resolveSystemSubagentRoute(deps, { vendor: "openai-compatible", model: "summary-model" });
    expect(createProvider).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: "https://summary.example/v1" }));
    expect(route.llmSettings.marketplaceProviderPresetId).toBe("summary-route");
  });

  it("fails when the selected provider has disconnected or the selected model disappeared", async () => {
    const { deps, getSecret } = fixture();
    await expect(resolveSystemSubagentRoute(deps, { vendor: "openai-compatible", model: "removed-model" }))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/removed-model");
    getSecret.mockResolvedValue(null);
    expect(await systemSubagentModelOptions(deps.settingsService)).not.toContainEqual({
      vendor: "openai-compatible", model: "summary-model",
    });
    await expect(resolveSystemSubagentRoute(deps, { vendor: "openai-compatible", model: "summary-model" }))
      .rejects.toThrow("System subagent model is unavailable: openai-compatible/summary-model");
    expect(deps.subscriptionProviderFactory).not.toHaveBeenCalled();
  });
});
