import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cachedLiveModelIds,
  isDefaultModelListEndpoint,
  listLlmModelsFromSettings,
  modelListEndpointFromBaseUrl,
  modelListPayloadIsComplete,
  MODEL_LIST_REFRESH_TTL_MS,
  parseStandardModelListEntries,
  parseStandardModelListResponse,
  refreshRouteModelList,
  resetModelListProbeStateForTesting,
} from "../model-list.js";
import { NetworkGuardError } from "../../../core/network-guard.js";
import { llmModelListCacheKey, MAX_CACHED_LLM_MODEL_IDS, type LlmModelListCacheEntry } from "../../../shared/llm-model-list.js";
import { llmRouteCatalogAddress, resolveContextWindowForRoute } from "../../../shared/context-budget.js";
import { freshAllVendorBlocks } from "../../../shared/llm-vendor-defaults.js";
import { marketplaceProviderPresetSecretKey } from "../../../shared/marketplace-package-assets.js";
import { unusedNetworkFetch } from "../../../__tests__/support/network-fetch-stubs.js";

function makeSettingsService(overrides: {
  provider?: string;
  baseUrl?: string;
  wire?: import("../../../shared/custom-provider.js").CustomProviderWire;
  secret?: string | null;
} = {}) {
  const provider = overrides.provider ?? "openrouter";
  const baseUrl = overrides.baseUrl ?? "https://openrouter.ai/api/v1";
  const secret = overrides.secret ?? "sk-or-test";
  return {
    get: vi.fn((key: string) => {
      if (key !== "llm") throw new Error(`unexpected settings key: ${key}`);
      return {
        provider,
        vendors: {
          [provider]: {
            model: "openrouter/free",
            baseUrl,
            ...(overrides.wire ? { wire: overrides.wire } : {}),
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
          },
        },
        streamSmoothing: "none",
        fallbackChain: [],
        modelListCache: {},
      };
    }),
    getSecret: vi.fn(() => secret),
  };
}

function guardedFetchOptions(fetchImpl: typeof fetch) {
  return {
    fetchImpl,
    ensurePublicUrl: async (url: string) => new URL(url),
    fetchPublicHttpResponseImpl: async (
      url: string,
      init?: RequestInit & { fetchImpl?: typeof fetch },
    ) => (init?.fetchImpl ?? fetch)(url, init),
  };
}

describe("LLM model list sync", () => {
  it.each(["openai-chat", "openai-responses", "anthropic-messages", "google-gemini"] as const)("rejects a remote HTTP custom %s model endpoint", async (wire) => {
    const settings = makeSettingsService({ provider: "openai-compatible", baseUrl: "http://custom.example/v1", wire });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: "fixture" }] }));
    const result = await listLlmModelsFromSettings(settings as never, { vendor: "openai-compatible" }, guardedFetchOptions(fetchImpl));
    expect(result).toMatchObject({ ok: false, error: "invalid-model-list-endpoint" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["anthropic-messages", "x-api-key", "limit", { data: [{ id: "native-model" }], has_more: false }],
    ["google-gemini", "x-goog-api-key", "pageSize", { models: [{ name: "models/native-model", supportedGenerationMethods: ["generateContent"] }] }],
  ] as const)("lists custom %s models using native authentication and response parsing", async (wire, header, pageKey, payload) => {
    const settings = makeSettingsService({ provider: "openai-compatible", baseUrl: "https://custom.example/v1", wire });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(payload));
    const result = await listLlmModelsFromSettings(settings as never, { vendor: "openai-compatible" }, guardedFetchOptions(fetchImpl));
    expect(result).toMatchObject({ ok: true, models: ["native-model"] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/v1/models");
    expect(new URL(String(url)).searchParams.has(pageKey)).toBe(true);
    expect(new Headers(init?.headers).get(header)).toBe("sk-or-test");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("normalizes baseUrl to the standard /models endpoint", () => {
    expect(modelListEndpointFromBaseUrl("https://openrouter.ai/api/v1")).toBe(
      "https://openrouter.ai/api/v1/models",
    );
    expect(modelListEndpointFromBaseUrl("http://localhost:11434/v1/")).toBe(
      "http://localhost:11434/v1/models",
    );
    expect(modelListEndpointFromBaseUrl("https://proxy.example/v1/models")).toBe(
      "https://proxy.example/v1/models",
    );
    expect(() =>
      modelListEndpointFromBaseUrl("https://user:pass@proxy.example/v1"),
    ).toThrow(/embedded credentials/);
  });

  it("parses standard model list responses and keeps free router model ids", () => {
    expect(
      parseStandardModelListResponse({
        object: "list",
        data: [
          { id: "openai/gpt-5.4" },
          { id: "google/gemini-2.5-flash:free" },
          { id: "google/gemini-2.5-flash:free" },
        ],
      }),
    ).toEqual(["openai/gpt-5.4", "google/gemini-2.5-flash:free"]);
  });

  it("reads the prompt ceiling a gateway or a self-hosted server reports", () => {
    // Endpoint limit field aliases must resolve the same compaction budget.
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [
          { id: "gateway-served", max_input_tokens: 229_376, max_output_tokens: 32_768 },
          { id: "self-hosted-served", max_model_len: 131_072 },
          { id: "nested-limits", limits: { max_input_tokens: 65_536, max_output_tokens: 8_192 } },
          { id: "says-nothing" },
        ],
      }),
    ).toEqual([
      { id: "gateway-served", contextLength: 229_376, maxOutputTokens: 32_768 },
      { id: "self-hosted-served", contextLength: 131_072 },
      { id: "nested-limits", contextLength: 65_536, maxOutputTokens: 8_192 },
      { id: "says-nothing" },
    ]);
  });

  it("prefers an explicit context_length over the gateway aliases for it", () => {
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [{ id: "both", context_length: 200_000, max_input_tokens: 128_000 }],
      }),
    ).toEqual([{ id: "both", contextLength: 200_000 }]);
  });

  it("ignores a malformed reported limit rather than budgeting against it", () => {
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [
          { id: "negative", max_input_tokens: -1 },
          { id: "not-a-number", max_model_len: "131072" },
          { id: "bad-output", max_input_tokens: 1_000, max_output_tokens: -8 },
        ],
      }),
    ).toEqual([
      { id: "negative" },
      { id: "not-a-number" },
      { id: "bad-output", contextLength: 1_000 },
    ]);
  });

  it("preserves extended model metadata from OpenRouter-compatible model lists", () => {
    expect(
      parseStandardModelListEntries({
        object: "list",
        data: [
          {
            id: "google/gemini-2.5-flash:free",
            name: "Gemini 2.5 Flash Free",
            description: "Free routed model",
            context_length: 1_048_576,
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            pricing: {
              prompt: "0",
              completion: "0",
              request: "0",
            },
            supported_parameters: ["tools", "response_format"],
            top_provider: { name: "Google" },
          },
          {
            id: "openrouter/auto",
            name: "Auto Router",
            pricing: {
              prompt: "0.000001",
              completion: "0.000002",
            },
          },
        ],
      }),
    ).toMatchObject([
      {
        id: "google/gemini-2.5-flash:free",
        name: "Gemini 2.5 Flash Free",
        description: "Free routed model",
        contextLength: 1_048_576,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        supportedParameters: ["tools", "response_format"],
        pricing: {
          prompt: "0",
          completion: "0",
          request: "0",
        },
        tags: {
          free: true,
        },
      },
      {
        id: "openrouter/auto",
        name: "Auto Router",
        pricing: {
          prompt: "0.000001",
          completion: "0.000002",
        },
        tags: {
          router: true,
        },
      },
    ]);
  });

  it("fetches models from the vendor baseUrl using the stored provider key", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "anthropic/claude-sonnet-4.6" },
            { id: "openrouter/free" },
          ],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const settingsService = makeSettingsService();

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openrouter" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: true,
      vendor: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/models",
      models: ["anthropic/claude-sonnet-4.6", "openrouter/free"],
      modelEntries: [
        { id: "anthropic/claude-sonnet-4.6" },
        { id: "openrouter/free", tags: { free: true, router: true } },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://openrouter.ai/api/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer sk-or-test",
        }),
        maxRedirects: 0,
        timeoutMs: 8000,
      }),
    );
  });

  it("marks a listing complete only when the answer is the whole list", async () => {
    // Only complete listings can prove model retirement.
    const answer = (payload: unknown) => vi.fn(async () =>
      new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    const settingsService = makeSettingsService();
    const whole = await listLlmModelsFromSettings(settingsService as never, { vendor: "openrouter" },
      guardedFetchOptions(answer({ data: [{ id: "a-model" }] })));
    expect(whole).toMatchObject({ ok: true, complete: true });
    const page = await listLlmModelsFromSettings(settingsService as never, { vendor: "openrouter" },
      guardedFetchOptions(answer({ data: [{ id: "a-model" }], has_more: true, last_id: "a-model" })));
    expect(page).toMatchObject({ ok: true });
    expect(page).not.toHaveProperty("complete");
  });

  it.each([
    [{ data: [], has_more: false }, 1, true],
    [[{ id: "bare-array" }], 1, true],
    [{ data: [], has_more: true }, 1, false],
    [{ data: [], next_page_token: "p2" }, 1, false],
    [{ models: [], nextPageToken: "p2" }, 1, false],
    [{ models: [], nextPageToken: "" }, 1, true],
    [{ data: [] }, MAX_CACHED_LLM_MODEL_IDS, false],
  ])("reads %j with %i ids as complete=%s", (payload, count, complete) => {
    expect(modelListPayloadIsComplete(payload, count)).toBe(complete);
  });

  it("refuses a retired vendor without contacting its endpoint", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await listLlmModelsFromSettings(
      makeSettingsService({ provider: "openai", baseUrl: "", secret: "token" }) as never,
      { vendor: "copilot" as never },
      guardedFetchOptions(fetchImpl),
    );
    expect(result).toMatchObject({ ok: false, error: "invalid-provider" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not fetch model lists for manual or static discovery policies", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "router/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    for (const modelDiscoveryPolicy of ["manual", "static"] as const) {
      const result = await listLlmModelsFromSettings(
        makeSettingsService() as never,
        { vendor: "openrouter", modelDiscoveryPolicy },
        guardedFetchOptions(fetchImpl),
      );

      expect(result).toMatchObject({
        ok: false,
        error: "model-list-not-supported",
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("syncs a saved credentialed private model-provider endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "Qwen3.6-35B-A3B-NVFP4" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      url: string,
      options?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
      },
    ) => {
      expect(options?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(init?.allowLoopback?.(new URL(url))).toBe(true);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "openai-compatible",
        baseUrl: "http://localhost:30000/v1",
        secret: "internal-key",
      }) as never,
      { vendor: "openai-compatible" },
      {
        fetchImpl,
        ensurePublicUrl,
        fetchPublicHttpResponseImpl,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://localhost:30000/v1/models",
      models: ["Qwen3.6-35B-A3B-NVFP4"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:30000/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer internal-key" }),
      }),
    );
  });

  it("syncs a saved self-hosted non-openai-compatible endpoint (ollama) over private HTTP", async () => {
    // Saved self-hosted routes receive only same-origin private access and credentialed HTTP.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "llama3.3" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      url: string,
      options?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
      },
    ) => {
      expect(options?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks?.(new URL(url))).toBe(true);
      expect(init?.allowLoopback?.(new URL(url))).toBe(true);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "ollama",
        baseUrl: "http://10.10.0.5:11434/v1",
        secret: "ollama-key",
      }) as never,
      { vendor: "ollama" },
      { fetchImpl, ensurePublicUrl, fetchPublicHttpResponseImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://10.10.0.5:11434/v1/models",
      models: ["llama3.3"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://10.10.0.5:11434/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer ollama-key" }),
      }),
    );
  });

  it("denies private access for a keyless openai-compatible draft endpoint with no preset", async () => {
    // Keyless unsaved draft routes without a preset receive no private or loopback access.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "draft/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      _url: string,
      options?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
      },
    ) => {
      expect(options?.allowPrivateNetworks).toBe(false);
      expect(options?.allowLoopback).toBe(false);
      return new URL(_url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks).toBe(false);
      expect(init?.allowLoopback).toBe(false);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "openai-compatible",
        baseUrl: "https://saved.example/v1",
      }) as never,
      { vendor: "openai-compatible", baseUrl: "https://draft.example/v1" },
      { fetchImpl, ensurePublicUrl, fetchPublicHttpResponseImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://draft.example/v1/models",
      models: ["draft/model"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://draft.example/v1/models",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("denies private access for a keyless openai-compatible endpoint whose active preset is not installed", async () => {
    // A missing marketplace preset cannot grant private or loopback access.
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            authMode: "manual",
            provider: "openai-compatible",
            marketplaceProviderPresetId: "ghost-router",
            vendors: {
              "openai-compatible": {
                model: "ghost/model",
                baseUrl: "https://ghost.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") return { installedProviderPresets: [] };
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => null),
    };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "ghost/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn(async (
      url: string,
      options?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
      },
    ) => {
      expect(options?.allowPrivateNetworks).toBe(false);
      expect(options?.allowLoopback).toBe(false);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: false | ((url: URL) => boolean);
        allowLoopback?: false | ((url: URL) => boolean);
        fetchImpl?: typeof fetch;
      },
    ) => {
      expect(init?.allowPrivateNetworks).toBe(false);
      expect(init?.allowLoopback).toBe(false);
      return (init?.fetchImpl ?? fetch)(url, init);
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible" },
      { fetchImpl, ensurePublicUrl, fetchPublicHttpResponseImpl },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://ghost.example/v1/models",
      models: ["ghost/model"],
    });
    expect(ensurePublicUrl).toHaveBeenCalledOnce();
  });

  it("keeps unsaved private model-list endpoints blocked", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "local/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService({ baseUrl: "https://router.example/v1" }) as never,
      { vendor: "openrouter", baseUrl: "http://10.10.2.100:30000/v1" },
      {
        fetchImpl,
        ensurePublicUrl: async (_url, options) => {
          expect(options?.allowPrivateNetworks).toBe(false);
          expect(options?.allowLoopback).toBe(false);
          throw new NetworkGuardError(
            "target resolves to non-public address(es): 10.10.2.100",
          );
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint: "http://10.10.2.100:30000/v1/models",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps saved commercial provider endpoints HTTPS-only and public-only", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const ensurePublicUrl = vi.fn();

    const result = await listLlmModelsFromSettings(
      makeSettingsService({
        provider: "openrouter",
        baseUrl: "http://10.10.2.100:30000/v1",
        secret: "commercial-key",
      }) as never,
      { vendor: "openrouter" },
      { fetchImpl, ensurePublicUrl },
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
      endpoint: "http://10.10.2.100:30000/v1/models",
    });
    expect(ensurePublicUrl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not send the stored provider key to an unsaved draft baseUrl", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "draft/model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      {
        vendor: "openrouter",
        baseUrl: "https://models.example.com/v1",
      },
      {
        ...guardedFetchOptions(fetchImpl),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://models.example.com/v1/models",
      models: ["draft/model"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://models.example.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
        maxRedirects: 0,
        timeoutMs: 8000,
      }),
    );
  });

  it("uses the selected marketplace provider preset key for saved OpenAI-compatible model sync", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": {
                model: "future/free",
                baseUrl: "https://future.example/v1",
                enableThinking: true,
                thinkingBudgetTokens: 10_000,
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn((key: string) =>
        key === marketplaceProviderPresetSecretKey("future-router")
          ? "fr-secret"
          : null
      ),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "future-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://future.example/v1/models",
      models: ["future/free"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://future.example/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fr-secret",
        }),
      }),
    );
  });

  it("allows keyless marketplace provider presets to sync loopback model lists", async () => {
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "local-router",
            vendors: {
              "openai-compatible": {
                model: "local/free",
                baseUrl: "http://localhost:8000/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "local-router",
              label: "Local Router",
              baseUrl: "http://localhost:8000/v1",
              defaultModel: "local/free",
              modelOptions: ["local/free"],
              requiresApiKey: false,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => null),
    };
    const ensurePublicUrl = vi.fn(async (url: string, options?: {
      allowPrivateNetworks?: (url: URL) => boolean;
      allowLoopback?: (url: URL) => boolean;
    }) => {
      expect(options?.allowPrivateNetworks).toBe(false);
      expect(options?.allowLoopback?.(new URL(url))).toBe(true);
      return new URL(url);
    });
    const fetchPublicHttpResponseImpl = vi.fn(async (
      url: string,
      init?: {
        allowPrivateNetworks?: (url: URL) => boolean;
        allowLoopback?: (url: URL) => boolean;
        headers?: Record<string, string>;
      },
    ) => {
      expect(init?.allowPrivateNetworks).toBe(false);
      expect(init?.allowLoopback?.(new URL(url))).toBe(true);
      expect(init?.headers?.Authorization).toBeUndefined();
      return new Response(JSON.stringify({ data: [{ id: "local/free" }] }), {
        status: 200,
      });
    }) as unknown as typeof import("../../../core/network-guard.js").fetchPublicHttpResponse;

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "local-router" },
      {
        fetchImpl: unusedNetworkFetch,
        ensurePublicUrl: ensurePublicUrl as never,
        fetchPublicHttpResponseImpl,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      endpoint: "http://localhost:8000/v1/models",
      models: ["local/free"],
    });
    expect(ensurePublicUrl).toHaveBeenCalledOnce();
    expect(fetchPublicHttpResponseImpl).toHaveBeenCalledOnce();
  });

  it("rejects a marketplace credential scope that is not the active persisted preset", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "router-b",
            vendors: {
              "openai-compatible": {
                model: "shared/free",
                baseUrl: "https://shared.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [
              {
                providerId: "router-a",
                label: "Router A",
                baseUrl: "https://shared.example/v1",
                defaultModel: "shared/free",
                modelOptions: ["shared/free"],
                requiresApiKey: true,
              },
              {
                providerId: "router-b",
                label: "Router B",
                baseUrl: "https://shared.example/v1",
                defaultModel: "shared/free",
                modelOptions: ["shared/free"],
                requiresApiKey: true,
              },
            ],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "should-not-be-used"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "router-a" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "provider-not-installed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("rejects a marketplace credential scope when the resolved endpoint does not match the preset", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "other/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": {
                model: "other/free",
                baseUrl: "https://other.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "should-not-be-used"),
    };

    // Never offer preset secrets to an explicit endpoint outside that preset.
    const result = await listLlmModelsFromSettings(
      settingsService as never,
      {
        vendor: "openai-compatible",
        credentialScope: "future-router",
        baseUrl: "https://other.example/v1",
      },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-endpoint",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("resolves a scoped request to the preset's endpoint, not the vendor block's", async () => {
    // Resolve scoped preset credentials against its registry endpoint, never another custom-provider row.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            marketplaceProviderPresetId: "future-router",
            vendors: {
              "openai-compatible": { model: "other/free", baseUrl: "https://other.example/v1" },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        if (key === "marketplace") {
          return {
            installedProviderPresets: [{
              providerId: "future-router",
              label: "Future Router",
              baseUrl: "https://future.example/v1",
              defaultModel: "future/free",
              modelOptions: ["future/free"],
              requiresApiKey: true,
            }],
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "fr-secret"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "future-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({ ok: true, endpoint: "https://future.example/v1/models" });
    expect(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .toBe("https://future.example/v1/models");
  });

  it("rejects an uninstalled marketplace provider preset scope before fetching", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "future/free" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "marketplace") return { installedProviderPresets: [] };
        if (key === "llm") {
          return {
            provider: "openai-compatible",
            vendors: {
              "openai-compatible": {
                model: "future/free",
                baseUrl: "https://future.example/v1",
              },
            },
            streamSmoothing: "none",
            fallbackChain: [],
            modelListCache: {},
          };
        }
        throw new Error(`unexpected settings key: ${key}`);
      }),
      getSecret: vi.fn(() => "should-not-be-used"),
    };

    const result = await listLlmModelsFromSettings(
      settingsService as never,
      { vendor: "openai-compatible", credentialScope: "missing-router" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "provider-not-installed",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(settingsService.getSecret).not.toHaveBeenCalled();
  });

  it("returns a structured error when the model response has no ids", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ object: "model" }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      { vendor: "openrouter" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-response",
    });
  });

  it("returns a structured error when the model response is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      { vendor: "openrouter" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "invalid-model-list-response",
    });
  });

  // Preserve network cause codes because generic fetch text cannot distinguish failures.
  it("carries the transport cause code into the diagnostic message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
      });
    }) as unknown as typeof fetch;

    const result = await listLlmModelsFromSettings(
      makeSettingsService() as never,
      { vendor: "openrouter" },
      guardedFetchOptions(fetchImpl),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "model-list-fetch-failed",
    });
    expect((result as { message: string }).message).toContain("SELF_SIGNED_CERT_IN_CHAIN");
  });

  it("uses the injected transport rather than the ambient fetch", async () => {
    const ambient = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", ambient);
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      const result = await listLlmModelsFromSettings(
        makeSettingsService() as never,
        { vendor: "openrouter" },
        guardedFetchOptions(fetchImpl),
      );
      expect(result).toMatchObject({ ok: true, models: ["m-1"] });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(ambient).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isDefaultModelListEndpoint — the endpoint a vendor's route resolves to", () => {
  it("no block: the vendor default, else the standard catalogue address, else nothing", () => {
    expect(isDefaultModelListEndpoint(undefined, "openrouter", "https://openrouter.ai/api/v1/models")).toBe(true);
    expect(isDefaultModelListEndpoint(undefined, "openrouter", "https://elsewhere.example.test/v1/models")).toBe(false);
    expect(isDefaultModelListEndpoint(undefined, "openai", "https://api.openai.com/v1/models")).toBe(true);
    expect(isDefaultModelListEndpoint(undefined, "openai-compatible", "http://10.0.0.5:8000/v1/models")).toBe(false);
  });

  it("a configured baseUrl replaces the default", () => {
    const vendors = { openrouter: { baseUrl: " https://proxy.example.test/v1/ " } };
    expect(isDefaultModelListEndpoint(vendors, "openrouter", "https://proxy.example.test/v1/models")).toBe(true);
    expect(isDefaultModelListEndpoint(vendors, "openrouter", "https://openrouter.ai/api/v1/models")).toBe(false);
  });

  it("a whitespace-only baseUrl resolves as the fetch resolves it: no endpoint unless a standard one exists", () => {
    expect(isDefaultModelListEndpoint({ openrouter: { baseUrl: "   " } }, "openrouter", "https://openrouter.ai/api/v1/models")).toBe(false);
    expect(isDefaultModelListEndpoint({ openai: { baseUrl: "   " } }, "openai", "https://api.openai.com/v1/models")).toBe(true);
  });
});

describe("cachedLiveModelIds — what the route's own /models answer named", () => {
  const entry = (vendor: string, endpoint: string, models: string[]): LlmModelListCacheEntry => ({
    vendor, endpoint, models, complete: true, fetchedAt: "2026-10-16T00:00:00.000Z",
  });

  it("reads only the vendor's listing for the endpoint its route reaches", () => {
    const modelListCache = {
      a: entry("openai", "https://api.openai.com/v1/models", ["ft:gpt-6-luna:acme::abc123", "gpt-6-luna"]),
      b: entry("openai", "https://proxy.example.test/v1/models", ["proxy-only"]),
      c: entry("openrouter", "https://openrouter.ai/api/v1/models", ["openrouter/free"]),
    };
    expect(cachedLiveModelIds({ modelListCache }, "openai")).toEqual(["ft:gpt-6-luna:acme::abc123", "gpt-6-luna"]);
    expect(cachedLiveModelIds({ vendors: { openai: { baseUrl: "https://proxy.example.test/v1" } }, modelListCache }, "openai"))
      .toEqual(["proxy-only"]);
    expect(cachedLiveModelIds({}, "openai")).toEqual([]);
  });
});

describe("refreshRouteModelList — the catalogue a headless run can reach", () => {
  const address = {
    vendor: "openai-compatible" as const,
    baseUrl: "https://models.invalid/v1",
  };

  function makeRefreshSettings(cache: Record<string, unknown> = {}) {
    const patch = vi.fn(async (_partial: {
      llm: { modelListCache: Record<string, { modelEntries?: Array<{ contextLength?: number }> }> };
    }) => ({}));
    const llm = {
      provider: "openai-compatible",
      vendors: {
        "openai-compatible": {
          model: "gateway-served",
          baseUrl: "https://models.invalid/v1",
          enableThinking: true,
          thinkingBudgetTokens: 10_000,
        },
      },
      streamSmoothing: "none",
      fallbackChain: [],
      modelListCache: cache,
    };
    return {
      patch,
      service: {
        // Settings snapshots become stale across awaits.
        get: vi.fn((key: string) =>
          key === "llm" ? { ...llm, modelListCache: { ...cache } } : {},
        ),
        getSecret: vi.fn(() => ""),
        patch,
      },
    };
  }

  const servedCatalogue = () =>
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "gateway-served", max_input_tokens: 229_376, max_output_tokens: 32_768 }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

  beforeEach(() => {
    resetModelListProbeStateForTesting();
  });

  it("does not probe a dormant endpoint for a location-managed SDK route", async () => {
    const vendors = freshAllVendorBlocks();
    vendors["vertex-ai"].model = "managed-unknown";
    vendors["vertex-ai"].baseUrl = "https://unused.invalid/v1";
    const llm = { provider: "vertex-ai" as const, vendors, modelListCache: {} };
    const service = {
      get: vi.fn((key: string) => key === "llm" ? llm : {}),
      getSecret: vi.fn(() => ""),
      patch: vi.fn(async () => {}),
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "managed-unknown", context_length: 64_000 }],
    })));
    const stored = await refreshRouteModelList({
      settingsService: service as never,
      fetchOptions: guardedFetchOptions(fetchImpl),
      address: llmRouteCatalogAddress(llm),
    });
    expect(stored).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(service.patch).not.toHaveBeenCalled();
  });

  it("asks the endpoint and stores the answer where the reader looks for it", async () => {
    // Background discovery must populate reported windows without a settings page open.
    const { service, patch } = makeRefreshSettings();
    const fetchImpl = servedCatalogue();

    const stored = await refreshRouteModelList({
      settingsService: service as never,
      fetchOptions: guardedFetchOptions(fetchImpl),
      address,
    });

    expect(stored).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const written = patch.mock.calls[0][0];
    const key = llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "");
    expect(written.llm.modelListCache[key]?.modelEntries?.[0]?.contextLength).toBe(229_376);
    expect(
      resolveContextWindowForRoute({
        provider: "openai-compatible",
        vendors: {
          "openai-compatible": {
            model: "gateway-served",
            baseUrl: "https://models.invalid/v1",
            enableThinking: true,
            thinkingBudgetTokens: 10_000,
          },
        },
        modelListCache: written.llm.modelListCache as never,
      }),
    ).toMatchObject({ contextWindow: 229_376, source: "provider-reported" });
  });

  it("asks once per route, however many turns evaluate the budget", async () => {
    const { service } = makeRefreshSettings();
    const fetchImpl = servedCatalogue();

    await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address });
    await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address });
    await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("leaves a catalogue answer that is still within its lifetime alone", async () => {
    const key = llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "");
    const { service, patch } = makeRefreshSettings({
      [key]: {
        vendor: "openai-compatible",
        endpoint: "https://models.invalid/v1/models",
        models: ["gateway-served"],
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const fetchImpl = servedCatalogue();

    expect(
      await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("asks again once that answer is older than its lifetime", async () => {
    const key = llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "");
    const { service } = makeRefreshSettings({
      [key]: {
        vendor: "openai-compatible",
        endpoint: "https://models.invalid/v1/models",
        models: ["gateway-served"],
        fetchedAt: new Date(Date.now() - MODEL_LIST_REFRESH_TTL_MS - 1_000).toISOString(),
      },
    });
    const fetchImpl = servedCatalogue();

    expect(
      await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not ask a preset that declares it has nothing to answer with", async () => {
    // Static or manual presets forbid model discovery, including background credentialed probes.
    const { service, patch } = makeRefreshSettings();
    const fetchImpl = servedCatalogue();

    for (const policy of ["static", "manual"] as const) {
      expect(
        await refreshRouteModelList({
          settingsService: service as never,
          fetchOptions: guardedFetchOptions(fetchImpl),
          address,
          modelDiscoveryPolicy: policy,
        }),
      ).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();

    // Refusing discovery must not consume the route probe before discovery is enabled.
    expect(
      await refreshRouteModelList({
        settingsService: service as never,
        fetchOptions: guardedFetchOptions(fetchImpl),
        address,
      }),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("merges its answer into the cache as it stands after the round trip", async () => {
    // Re-read cache before shallow patching so concurrent sync rows are not erased.
    const otherKey = llmModelListCacheKey("openai", "", "");
    const cache: Record<string, unknown> = {};
    const { service, patch } = makeRefreshSettings(cache);
    const fetchImpl = vi.fn(async () => {
      cache[otherKey] = {
        vendor: "openai",
        endpoint: "https://api.openai.com/v1/models",
        models: ["gpt-5.4-mini"],
        fetchedAt: new Date().toISOString(),
      };
      return new Response(
        JSON.stringify({ data: [{ id: "gateway-served", max_input_tokens: 229_376 }] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await refreshRouteModelList({
      settingsService: service as never,
      fetchOptions: guardedFetchOptions(fetchImpl),
      address,
    });

    const written = patch.mock.calls[0][0];
    expect(Object.keys(written.llm.modelListCache).sort()).toEqual(
      [otherKey, llmModelListCacheKey("openai-compatible", "https://models.invalid/v1", "")].sort(),
    );
  });

  it("keeps the window it has when the endpoint does not answer", async () => {
    const { service, patch } = makeRefreshSettings();
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    expect(
      await refreshRouteModelList({ settingsService: service as never, fetchOptions: guardedFetchOptions(fetchImpl), address }),
    ).toBe(false);
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("vendor /models paged listings", () => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("uses x-api-key and anthropic-version, following has_more by last_id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.searchParams.get("after_id") === "claude-sonnet-5-5"
        ? json({ data: [{ id: "claude-haiku-5-5", type: "model" }], has_more: false, first_id: "claude-haiku-5-5", last_id: "claude-haiku-5-5" })
        : json({ data: [{ id: "claude-opus-5-5", type: "model", lifecycle: "active", display_name: "Flagship", max_input_tokens: 1_000_000, max_tokens: 128_000 }, { id: "retired-model", lifecycle: "retired" }, { id: "claude-sonnet-5-5", type: "model" }], has_more: true, first_id: "claude-opus-5-5", last_id: "claude-sonnet-5-5" });
    });
    const result = await listLlmModelsFromSettings(
      makeSettingsService({ provider: "claude", baseUrl: "https://api.anthropic.com/v1", secret: "fixture-anthropic-key" }) as never,
      { vendor: "claude" },
      guardedFetchOptions(fetchImpl),
    );
    expect(result).toMatchObject({
      ok: true,
      endpoint: "https://api.anthropic.com/v1/models",
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
      complete: true,
    });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5-5",
    ]);
    expect(result.ok && result.modelEntries?.find((entry) => entry.id === "claude-opus-5-5"))
      .toMatchObject({ name: "Flagship", contextLength: 1_000_000, maxOutputTokens: 128_000 });
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers).toMatchObject({ "x-api-key": "fixture-anthropic-key", "anthropic-version": "2023-06-01" });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("uses x-goog-api-key, keeps only generateContent models, and strips models/", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.searchParams.get("pageToken") === "page-2"
        ? json({ models: [{ name: "models/gemini-3.5-flash-lite", baseModelId: "gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent", "countTokens"] }] })
        : json({
          models: [
            { name: "models/gemini-3.8-flash", baseModelId: "gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-005", supportedGenerationMethods: ["embedContent"] },
          ],
          nextPageToken: "page-2",
        });
    });
    const result = await listLlmModelsFromSettings(
      makeSettingsService({ provider: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta", secret: "fixture-gemini-key" }) as never,
      { vendor: "gemini" },
      guardedFetchOptions(fetchImpl),
    );
    expect(result).toMatchObject({ ok: true, models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"], complete: true });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2",
    ]);
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers).toMatchObject({ "x-goog-api-key": "fixture-gemini-key" });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("is not complete when the page cap stops a list that is still paging", async () => {
    let page = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      page += 1;
      return json({ data: [{ id: `claude-fixture-${page}` }], has_more: true, last_id: `claude-fixture-${page}` });
    });
    const result = await listLlmModelsFromSettings(
      makeSettingsService({ provider: "claude", baseUrl: "https://api.anthropic.com/v1", secret: "fixture-anthropic-key" }) as never,
      { vendor: "claude" },
      guardedFetchOptions(fetchImpl),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty("complete");
  });

  it("refuses a page that says has_more without saying where the next one starts", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ data: [{ id: "claude-opus-5-5" }], has_more: true }));
    const result = await listLlmModelsFromSettings(
      makeSettingsService({ provider: "claude", baseUrl: "https://api.anthropic.com/v1", secret: "fixture-anthropic-key" }) as never,
      { vendor: "claude" },
      guardedFetchOptions(fetchImpl),
    );
    expect(result).toMatchObject({ ok: false, error: "invalid-model-list-response" });
  });

  it("resolves native model-list endpoints with no address saved", () => {
    expect(isDefaultModelListEndpoint(undefined, "claude", "https://api.anthropic.com/v1/models")).toBe(true);
    expect(isDefaultModelListEndpoint(undefined, "gemini", "https://generativelanguage.googleapis.com/v1beta/models")).toBe(true);
  });
});
