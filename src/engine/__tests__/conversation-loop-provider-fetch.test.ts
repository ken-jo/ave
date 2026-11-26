import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { llmModelListCacheKey, type LlmModelListCache } from "../../shared/llm-model-list.js";
import { marketplaceProviderPresetSecretKey } from "../../shared/marketplace-package-assets.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { LLMProvider, LLMVendor, ProviderConfig } from "../llm/types.js";

async function loadProviderLoop(vendor: LLMVendor) {
  const createProvider = vi.fn(() => ({
    vendor,
    streamTurn: async function* () {},
  }));
  vi.doMock("../llm/provider-factory.js", () => ({
    createProvider,
    secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
  }));
  const { ConversationLoop } = await import("../conversation-loop.js");
  return { createProvider, ConversationLoop };
}

function makeLoopDeps(toolRegistry: ToolRegistry) {
  return {
    systemPromptBuilder: { build: () => "system" },
    toolRegistry,
    memoryManager: { sessions: { saveSession: () => {}, listSessions: () => [] } },
  };
}

describe("ConversationLoop LLM fetch wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock("../llm/provider-factory.js");
});

async function collectStream(iterable: AsyncIterable<unknown>,
  ): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

  it("passes the injected main-process fetch implementation to the active provider", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("azure-foundry");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "azure-foundry",
      model: "gpt-5.4-mini",
    });
    settings.vendors["azure-foundry"].baseUrl =
      "https://aif.example.openai.azure.com/openai/v1/";
    const llmFetch = vi.fn() as unknown as typeof fetch;

    await new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      ...makeLoopDeps(toolRegistry),
      llmFetch,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "azure-foundry",
        apiKey: "test-key",
        model: "gpt-5.4-mini",
        baseUrl: "https://aif.example.openai.azure.com/openai/v1/",
        fetch: llmFetch,
      }),
    );
  });

  it("does not pass the injected fetch to non-Azure providers", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    settings.vendors.openai.baseUrl = "https://proxy.example.test/v1";
    const llmFetch = vi.fn() as unknown as typeof fetch;

    await new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => "test-key",
      },
      ...makeLoopDeps(toolRegistry),
      llmFetch,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).toHaveBeenCalledWith(
      expect.not.objectContaining({
        fetch: llmFetch,
      }),
    );
    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai",
        apiKey: "test-key",
        model: "gpt-5.4-mini",
        baseUrl: "https://proxy.example.test/v1",
      }),
    );
  });

  it("creates OpenAI-compatible providers without an API key when a base URL is configured", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "Qwen3.6-35B-A3B-NVFP4",
    });
    settings.vendors["openai-compatible"].baseUrl = "http://localhost:8000/v1";

    await new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => null,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai-compatible",
        apiKey: "",
        model: "Qwen3.6-35B-A3B-NVFP4",
        baseUrl: "http://localhost:8000/v1",
      }),
    );
  });

  it("does not create an OpenAI-compatible provider when no model is configured", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "",
    });
    settings.vendors["openai-compatible"].baseUrl = "http://localhost:8000/v1";

    await new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => null,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    // Empty model IDs mean unconfigured; never fabricate an endpoint model selection.
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("keeps a stored API key for a saved OpenAI-compatible private endpoint", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "team/model",
    });
    settings.vendors["openai-compatible"].baseUrl = "http://localhost:8000/v1";

    await new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => "stored-key",
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai-compatible",
        apiKey: "stored-key",
        model: "team/model",
        baseUrl: "http://localhost:8000/v1",
        fetch: expect.any(Function),
      }),
    );
  });

  it("uses the selected marketplace provider preset key for OpenAI-compatible providers", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
      marketplaceProviderPresetId: "future-router",
    });
    settings.vendors["openai-compatible"].baseUrl = "https://stale.example/v1";

    await new ConversationLoop({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") {
            return {
              installedProviderPresets: [
                {
                  providerId: "future-router",
                  label: "Future Router",
                  baseUrl: "https://future.example/v1",
                  defaultModel: "future/free",
                  modelOptions: ["future/free"],
                  requiresApiKey: true,
                  modelDiscoveryPolicy: "models-api",
                  capabilities: { streaming: true, toolCalls: true },
                },
              ],
            };
          }
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret: (key: string) =>
          key === marketplaceProviderPresetSecretKey("future-router")
            ? "fr-secret"
            : null,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        vendor: "openai-compatible",
        apiKey: "fr-secret",
        model: "future/free",
        baseUrl: "https://future.example/v1",
        fetch: expect.any(Function),
        providerMetadata: expect.objectContaining({
          providerId: "future-router",
          baseUrl: "https://future.example/v1",
          modelDiscoveryPolicy: "models-api",
          capabilities: { streaming: true, toolCalls: true },
        }),
      }),
    );
  });

  it("guards credentialed marketplace provider runtime fetches through NetworkGuard", async () => {
    const networkGuard = await import("../../core/network-guard.js");
    const fetchPublicHttpResponse = vi
      .spyOn(networkGuard, "fetchPublicHttpResponse")
      .mockResolvedValue(new Response("ok"));
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
      marketplaceProviderPresetId: "future-router",
    });

    await new ConversationLoop({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") {
            return {
              installedProviderPresets: [
                {
                  providerId: "future-router",
                  label: "Future Router",
                  baseUrl: "https://future.example/v1",
                  defaultModel: "future/free",
                  modelOptions: ["future/free"],
                  requiresApiKey: true,
                },
              ],
            };
          }
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret: (key: string) =>
          key === marketplaceProviderPresetSecretKey("future-router")
            ? "fr-secret"
            : null,
      },
      ...makeLoopDeps(toolRegistry),
      // Supply the host transport so the guarded-fetch assertions exercise the real boundary.
      networkFetch: unusedNetworkFetch,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    const providerConfig = createProvider.mock.calls[0]?.[0];
    const guardedFetch = providerConfig?.fetch;
    expect(guardedFetch).toEqual(expect.any(Function));

    await guardedFetch?.("https://future.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    const [, init] = fetchPublicHttpResponse.mock.calls[0] as [
      string,
      RequestInit & {
        allowLoopback?: false | ((url: URL) => boolean);
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        fetchImpl?: typeof fetch;
      },
    ];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.fetchImpl).toEqual(expect.any(Function));
    expect(init.maxRedirects).toBe(0);
    expect(init.allowPrivateNetworks).toBe(false);
    expect(init.allowLoopback).toBe(false);
    await expect(
      guardedFetch?.("https://other.example/v1/chat/completions", {
        method: "POST",
        body: "{}",
      }),
    ).rejects.toThrow("configured origin");
    expect(fetchPublicHttpResponse).toHaveBeenCalledTimes(1);
  });

  it("scopes keyless marketplace loopback runtime fetches to the preset origin", async () => {
    const networkGuard = await import("../../core/network-guard.js");
    const fetchPublicHttpResponse = vi
      .spyOn(networkGuard, "fetchPublicHttpResponse")
      .mockResolvedValue(new Response("ok"));
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "local/free",
      marketplaceProviderPresetId: "local-router",
    });

    await new ConversationLoop({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") {
            return {
              installedProviderPresets: [
                {
                  providerId: "local-router",
                  label: "Local Router",
                  baseUrl: "http://localhost:8000/v1",
                  defaultModel: "local/free",
                  modelOptions: ["local/free"],
                  requiresApiKey: false,
                },
              ],
            };
          }
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret: () => null,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    const providerConfig = createProvider.mock.calls[0]?.[0];
    const guardedFetch = providerConfig?.fetch;
    expect(guardedFetch).toEqual(expect.any(Function));

    await guardedFetch?.("http://localhost:8000/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });

    const [, init] = fetchPublicHttpResponse.mock.calls[0] as [
      string,
      RequestInit & {
        allowLoopback?: false | ((url: URL) => boolean);
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        fetchImpl?: typeof fetch;
      },
    ];
    expect(init.allowPrivateNetworks).toBe(false);
    expect(init.maxRedirects).toBe(0);
    expect(init.allowLoopback).toEqual(expect.any(Function));
    const allowLoopback = init.allowLoopback as (url: URL) => boolean;
    expect(allowLoopback(new URL("http://localhost:8000/v1/models"))).toBe(
      true,
    );
    expect(allowLoopback(new URL("http://localhost:9000/v1/models"))).toBe(
      false,
    );
  });

  it("does not fall back to generic OpenAI-compatible credentials when the selected preset is uninstalled", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai-compatible");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
      marketplaceProviderPresetId: "future-router",
    });
    settings.vendors["openai-compatible"].baseUrl = "https://future.example/v1";

    await new ConversationLoop({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") return { installedProviderPresets: [] };
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret: (key: string) =>
          key === "llm.apiKey.openai-compatible" ? "generic-secret" : null,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).not.toHaveBeenCalled();
  });

  it("does not resolve generic OpenAI-compatible fallback credentials while a marketplace preset is active", async () => {
    vi.useFakeTimers();
    const primaryProvider = {
      vendor: "openai-compatible" as const,
      streamTurn: vi.fn(async function* () {
        yield {
          type: "error" as const,
          error: "503 unavailable",
          classification: "network",
        };
      }),
    };
    const createProvider = vi.fn(() => primaryProvider);
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai-compatible",
      model: "future/free",
      marketplaceProviderPresetId: "future-router",
    });
    settings.vendors["openai-compatible"].baseUrl = "https://future.example/v1";
    settings.fallbackChain = [
      { provider: "openai-compatible", model: "fallback/free" },
    ];
    const getSecret = vi.fn((key: string) =>
      key === marketplaceProviderPresetSecretKey("future-router")
        ? "fr-secret"
        : key === "llm.apiKey.openai-compatible"
          ? "generic-secret"
          : null,
    );

    const loop = new ConversationLoop({
      settingsService: {
        get: (key: string) => {
          if (key === "llm") return settings;
          if (key === "marketplace") {
            return {
              installedProviderPresets: [
                {
                  providerId: "future-router",
                  label: "Future Router",
                  baseUrl: "https://future.example/v1",
                  defaultModel: "future/free",
                  modelOptions: ["future/free"],
                  requiresApiKey: true,
                },
              ],
            };
          }
          throw new Error(`unexpected settings key: ${key}`);
        },
        getSecret,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    await loop.whenProviderReady();

    const pending = collectStream(
      loop.provider!.streamTurn({
        model: "future/free",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }),
    );
    const rejection = expect(pending).rejects.toThrow("503 unavailable");
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(
      marketplaceProviderPresetSecretKey("future-router"),
    );
    expect(getSecret).not.toHaveBeenCalledWith("llm.apiKey.openai-compatible");
  });

  it.each([
    { name: "continues to a fallback when the primary override is unlisted during its retry window", hasFallback: true, markerSet: false },
    { name: "reports retirement when the primary is unlisted and no fallback is configured", hasFallback: false, markerSet: true },
    { name: "reports retirement without fetching fallback credentials when the active route is blocked", hasFallback: true, markerSet: true },
  ])("$name", async ({ hasFallback, markerSet }) => {
    vi.useFakeTimers();
    const primaryDispatch = vi.fn();
    const createProvider = vi.fn(({ vendor }: ProviderConfig): LLMProvider => ({
      vendor,
      async *streamTurn({ model }) {
        if (vendor === "deepseek") {
          primaryDispatch();
          yield { type: "error", error: "429 rate limit", classification: "rate-limit" };
        } else {
          yield { type: "text_delta", text: model };
        }
      },
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");
    let settings = {
      ...fakeLlmSettings({ provider: "deepseek", model: markerSet ? "deepseek-v4-pro" : "deepseek-flash" }),
      modelListCache: {} as LlmModelListCache,
      fallbackChain: hasFallback ? [{ provider: "openai" as const, model: "o4-mini" }] : [],
    };
    const getSecret = vi.fn((_key: string) => "fixture-key");
    const loop = new ConversationLoop({
      settingsService: { get: () => settings, getSecret },
      ...(markerSet ? {} : { modelOverride: "deepseek-v4-pro" }),
      ...makeLoopDeps(new ToolRegistry()),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    await loop.whenProviderReady();

    const provider = loop.provider;
    assert(provider);
    const pending = collectStream(provider.streamTurn({
      model: "deepseek-v4-pro",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
    }));
    const outcome = pending.then((events) => ({ events }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(500);
    expect(primaryDispatch).toHaveBeenCalledOnce();
    expect(getSecret.mock.calls).toEqual([["llm.apiKey.deepseek"]]);
    settings = {
      ...settings,
      ...(markerSet ? { retiredProvider: { vendor: "deepseek", model: "deepseek-v4-pro", reason: "unlisted" } as const } : {}),
      modelListCache: {
        [llmModelListCacheKey("deepseek", settings.vendors.deepseek.baseUrl)]: {
          vendor: "deepseek",
          endpoint: "https://api.deepseek.com/v1/models",
          complete: true,
          models: ["deepseek-flash"],
          fetchedAt: "2026-10-13T00:00:00.000Z",
        },
      },
    };
    await vi.advanceTimersByTimeAsync(500);
    const attemptsAtRetryBoundary = primaryDispatch.mock.calls.length;
    const providersAtRetryBoundary = createProvider.mock.calls.map(([{ vendor }]) => vendor);
    await vi.advanceTimersByTimeAsync(4_000);

    const fellBack = hasFallback && !markerSet;
    if (fellBack) {
      expect(await outcome).toEqual({ events: [{ type: "text_delta", text: "o4-mini" }] });
    } else {
      expect(await outcome).toMatchObject({ error: { name: "RetiredModelError" } });
    }
    expect(attemptsAtRetryBoundary).toBe(1);
    expect(primaryDispatch).toHaveBeenCalledOnce();
    expect(providersAtRetryBoundary).toEqual(fellBack ? ["deepseek", "openai"] : ["deepseek"]);
    expect(getSecret.mock.calls).toEqual(fellBack
      ? [["llm.apiKey.deepseek"], ["llm.apiKey.openai"]]
      : [["llm.apiKey.deepseek"]]);
  });

  it.each([
    {
      name: "skips a fallback retired during primary retries and continues to a listed deprecated fallback",
      listingDelay: 1_000,
      firstFallbackAttempted: false,
    },
    {
      name: "stops retrying a fallback retired after its first failure and continues the walk",
      listingDelay: 5_000,
      firstFallbackAttempted: true,
    },
  ])("$name", async ({ listingDelay, firstFallbackAttempted }) => {
    vi.useFakeTimers();
    const firstFallbackDispatch = vi.fn();
    const createProvider = vi.fn(({ vendor }: ProviderConfig): LLMProvider => ({
      vendor,
      async *streamTurn({ model }) {
        if (vendor === "gemini") {
          yield { type: "error", error: "503 unavailable", classification: "network" };
        } else if (vendor === "deepseek") {
          firstFallbackDispatch();
          yield { type: "error", error: "502 fallback unavailable", classification: "network" };
        } else {
          yield { type: "text_delta", text: model };
        }
      },
    }));
    vi.doMock("../llm/provider-factory.js", () => ({
      createProvider,
      secretKeyFor: (vendor: string) => `llm.apiKey.${vendor}`,
    }));
    const { ConversationLoop } = await import("../conversation-loop.js");
    const { FallbackProvider } = await import("../llm/vercel/fallback-chain.js");
    const initialSettings = fakeLlmSettings({ provider: "gemini", model: "fixture-primary" });
    let settings = {
      ...initialSettings,
      modelListCache: {} as LlmModelListCache,
      fallbackChain: [
        { provider: "deepseek" as const, model: "deepseek-v4-pro" },
        { provider: "openai" as const, model: "o4-mini" },
      ],
    };
    const getSecret = vi.fn((_key: string) => "fixture-key");
    const loop = new ConversationLoop({
      settingsService: { get: () => settings, getSecret },
      ...makeLoopDeps(new ToolRegistry()),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    await loop.whenProviderReady();
    expect(loop.provider).toBeInstanceOf(FallbackProvider);

    const onFallback = vi.fn();
    const onStatus = vi.fn();
    const pending = collectStream((loop.provider as InstanceType<typeof FallbackProvider>)
      .withCallbacks({ onFallback, onStatus }).streamTurn({
        model: "fixture-primary",
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      }));
    await vi.advanceTimersByTimeAsync(listingDelay);
    const expectedFirstFallbackAttempts = firstFallbackAttempted ? 1 : 0;
    expect(firstFallbackDispatch).toHaveBeenCalledTimes(expectedFirstFallbackAttempts);
    settings = {
      ...settings,
      modelListCache: {
        [llmModelListCacheKey("deepseek", settings.vendors.deepseek.baseUrl)]: {
          vendor: "deepseek",
          endpoint: "https://api.deepseek.com/v1/models",
          complete: true,
          models: ["deepseek-flash"],
          fetchedAt: "2026-10-13T00:00:00.000Z",
        },
        [llmModelListCacheKey("openai", settings.vendors.openai.baseUrl)]: {
          vendor: "openai",
          endpoint: "https://api.openai.com/v1/models",
          complete: true,
          models: ["o4-mini"],
          fetchedAt: "2026-10-13T00:00:00.000Z",
        },
      },
    };
    await vi.advanceTimersByTimeAsync(10_000 - listingDelay);

    expect(await pending).toEqual([{ type: "text_delta", text: "o4-mini" }]);
    expect(firstFallbackDispatch).toHaveBeenCalledTimes(expectedFirstFallbackAttempts);
    const attempted = [
      { vendor: "gemini", model: "fixture-primary" },
      ...(firstFallbackAttempted ? [{ vendor: "deepseek", model: "deepseek-v4-pro" }] : []),
      { vendor: "openai", model: "o4-mini" },
    ];
    expect(getSecret.mock.calls).toEqual(attempted.map(({ vendor }) => [`llm.apiKey.${vendor}`]));
    expect(createProvider.mock.calls.map(([{ model }]) => model)).toEqual(attempted.map(({ model }) => model));
    const labels = attempted.map(({ vendor, model }) => `${vendor}/${model}`);
    expect(onFallback.mock.calls).toEqual(labels.slice(1).map((to, index) => [labels[index], to]));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({
      phase: "fallback",
      to: "openai/o4-mini",
      reason: firstFallbackAttempted ? "502 fallback unavailable" : "503 unavailable",
    }));
  });

  it("does not create ordinary keyed providers when the API key is missing", async () => {
    const { createProvider, ConversationLoop } = await loadProviderLoop("openai");

    const toolRegistry = new ToolRegistry();
    const settings = fakeLlmSettings({
      provider: "openai",
      model: "gpt-5.4-mini",
    });

    await new ConversationLoop({
      settingsService: {
        get: () => settings,
        getSecret: () => null,
      },
      ...makeLoopDeps(toolRegistry),
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]).whenProviderReady();

    expect(createProvider).not.toHaveBeenCalled();
  });
});
