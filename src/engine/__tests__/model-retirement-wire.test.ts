import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sseResponse } from "../../__tests__/support/sse-response.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";
import { collectAsyncIterable as collect } from "../../__tests__/test-helpers.js";
import { LlmReviewerProviderAdapter } from "../../boot/steps/reviewer-wiring.js";
import { DEFAULT_SETTINGS } from "../../data/settings-defaults.js";
import type { LLMSettings } from "../../data/settings-store.js";
import { llmModelListCacheKey } from "../../shared/llm-model-list.js";
import { getLlmVendorSettings } from "../../shared/llm-vendor-defaults.js";
import { systemSubagentRouteIdentity } from "../../shared/system-subagent-model.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import { RetiredModelError } from "../llm/retired-model-error.js";
import { FallbackProvider, type FallbackStatus } from "../llm/vercel/fallback-chain.js";
import { createSystemSubagentProviderPlan } from "../system-subagent-route.js";
import { buildProvider } from "../turn/provider.js";

/**
 * Each production wiring site, on the real SDK transport with an offline fetch: once live evidence retires the route,
 * no further request reaches the wire, whoever would have retried it.
 */

const TURN = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "hi" }] };
const FETCHED_AT = "2026-10-13T00:00:00.000Z";

/** The same turn on the Responses wire, which the OpenAI route speaks. */
function completedResponse(text: string): Response {
  return sseResponse([
    { type: "response.created", response: { id: "r1", created_at: 1, model: "o4-mini" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [] } },
    { type: "response.output_text.delta", item_id: "m1", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "r1", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]);
}

function failure(status: number): Response {
  return Response.json({ error: { message: "Request failed" } }, { status, headers: { "retry-after-ms": "0" } });
}

function requestHost(input: Parameters<typeof fetch>[0]): string {
  return new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url).host;
}

function deepseekSettings(model: string): LLMSettings {
  const llm = structuredClone(DEFAULT_SETTINGS.llm);
  llm.provider = "deepseek";
  llm.vendors.deepseek = { ...getLlmVendorSettings(llm.vendors, "deepseek"), model };
  return llm;
}

function deepseekListing(llm: LLMSettings, models: string[]): void {
  llm.modelListCache[llmModelListCacheKey("deepseek", getLlmVendorSettings(llm.vendors, "deepseek").baseUrl)] = {
    vendor: "deepseek", endpoint: "https://api.deepseek.com/v1/models", models, complete: true, fetchedAt: FETCHED_AT,
  };
}

function settingsService(llm: LLMSettings, getSecret: (key: string) => Promise<string | null> = async () => "fixture-key") {
  return {
    get: (key: string) => key === "llm" ? structuredClone(llm) : { installedProviderPresets: [] },
    getSecret,
  };
}

async function chatProvider(llm: LLMSettings, modelOverride?: string): Promise<FallbackProvider> {
  const provider = await buildProvider({
    settingsService: settingsService(llm),
    networkFetch: unusedNetworkFetch,
    ...(modelOverride ? { modelOverride } : {}),
  } as unknown as Parameters<typeof buildProvider>[0]);
  assert(provider instanceof FallbackProvider);
  return provider;
}

beforeAll(async () => {
  // The SDK wire loads lazily; load it before the clock is faked.
  await import("../llm/vercel/adapter.js");
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("no model request leaves after the route retires", () => {
  it("chat: the transport's own retry is refused once the saved route is blocked", async () => {
    const llm = deepseekSettings("deepseek-v4-pro");
    const wireFetch = vi.fn<typeof fetch>(async () => {
      // The blocking marker lands while the SDK waits to retry this response.
      llm.retiredProvider = { vendor: "deepseek", model: "deepseek-v4-pro", reason: "unlisted" };
      return failure(429);
    });
    vi.stubGlobal("fetch", wireFetch);
    const provider = await chatProvider(llm);
    const onStatus = vi.fn<(status: FallbackStatus) => void>();

    const outcome = collect(provider.withCallbacks({ onStatus }).streamTurn({ ...TURN, model: "deepseek-v4-pro" }))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toBeInstanceOf(RetiredModelError);
    expect(await outcome).toMatchObject({ model: "deepseek-v4-pro" });
    expect(wireFetch).toHaveBeenCalledOnce();
    expect(onStatus.mock.calls.map(([status]) => status.phase)).toEqual(["attempt"]);
  });

  it("chat: a model override unlisted during the transport's backoff hands off to the fallback without another request", async () => {
    const llm = deepseekSettings("deepseek-flash");
    llm.fallbackChain = [{ provider: "openai", model: "o4-mini" }];
    const wireFetch = vi.fn<typeof fetch>(async (input) => {
      if (requestHost(input) !== "api.deepseek.com") return completedResponse("from fallback");
      deepseekListing(llm, ["deepseek-flash"]);
      return failure(429);
    });
    vi.stubGlobal("fetch", wireFetch);
    const provider = await chatProvider(llm, "deepseek-v4-pro");

    const outcome = collect(provider.streamTurn({ ...TURN, model: "deepseek-v4-pro" })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", text: "from fallback" })]));
    expect(wireFetch.mock.calls.map(([input]) => requestHost(input))).toEqual(["api.deepseek.com", "api.openai.com"]);
  });

  it("chat: a fallback retired during its own transport backoff is not requested again and the walk continues", async () => {
    const llm = structuredClone(DEFAULT_SETTINGS.llm);
    llm.provider = "gemini";
    llm.vendors.gemini = { ...getLlmVendorSettings(llm.vendors, "gemini"), model: "fixture-primary" };
    llm.fallbackChain = [{ provider: "deepseek", model: "deepseek-v4-pro" }, { provider: "openai", model: "o4-mini" }];
    const wireFetch = vi.fn<typeof fetch>(async (input) => {
      const host = requestHost(input);
      if (host === "api.openai.com") return completedResponse("from second fallback");
      if (host === "api.deepseek.com") deepseekListing(llm, ["deepseek-flash"]);
      return failure(503);
    });
    vi.stubGlobal("fetch", wireFetch);
    const provider = await chatProvider(llm);

    const outcome = collect(provider.streamTurn({ ...TURN, model: "fixture-primary" })).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await outcome).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta", text: "from second fallback" })]));
    const hosts = wireFetch.mock.calls.map(([input]) => requestHost(input));
    expect(hosts.filter((host) => host === "api.deepseek.com")).toHaveLength(1);
    expect(hosts.at(-1)).toBe("api.openai.com");
  });

  it.each([
    { boundary: "during the final credential read", fetched: 0 },
    { boundary: "during the transport's backoff", fetched: 1 },
  ])("explicit compaction: refused when its model retires $boundary", async ({ fetched }) => {
    const llm = deepseekSettings("deepseek-flash");
    const route = systemSubagentRouteIdentity(llm, "deepseek");
    assert(route);
    llm.compactionModelSelection = { vendor: "deepseek", model: "deepseek-v4-pro", route };
    const wireFetch = vi.fn<typeof fetch>(async () => {
      deepseekListing(llm, ["deepseek-flash"]);
      return failure(429);
    });
    let credentialReads = 0;
    const getSecret = vi.fn(async (key: string) => {
      if (key !== route.credentialScope) return null;
      if (++credentialReads === 3 && fetched === 0) deepseekListing(llm, ["deepseek-flash"]);
      return "fixture-key";
    });
    vi.stubGlobal("fetch", wireFetch);
    const loop = new ConversationLoop({
      systemPromptBuilder: { build: () => "system" },
      toolRegistry: new ToolRegistry(),
      memoryManager: { sessions: { saveSession: () => {}, listSessions: () => [] } },
      settingsService: settingsService(llm, getSecret),
      networkFetch: unusedNetworkFetch,
    } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
    await loop.whenProviderReady();

    const outcome = loop.generateCompactionText("Summarize history").catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await outcome).toBeInstanceOf(RetiredModelError);
    expect(await outcome).toMatchObject({ model: "deepseek-v4-pro" });
    expect(credentialReads).toBe(3);
    expect(wireFetch).toHaveBeenCalledTimes(fetched);
  });

  it("permission reviewer: neither the transport's retry nor a caller that tries again reaches the wire", async () => {
    const llm = deepseekSettings("deepseek-v4-pro");
    const wireFetch = vi.fn<typeof fetch>(async () => {
      llm.retiredProvider = { vendor: "deepseek", model: "deepseek-v4-pro", reason: "unlisted" };
      return failure(503);
    });
    vi.stubGlobal("fetch", wireFetch);
    // The route every reviewer, judge and rationale consumer is built from when it follows chat.
    const plan = createSystemSubagentProviderPlan({
      settingsService: settingsService(llm), networkFetch: unusedNetworkFetch,
    } as unknown as Parameters<typeof createSystemSubagentProviderPlan>[0], "deepseek");
    const provider = plan?.build("fixture-key");
    assert(provider);
    const reviewer = new LlmReviewerProviderAdapter(provider);
    const complete = () => {
      const pending = reviewer.complete({ model: "deepseek-v4-pro", systemPrompt: "sys", userPrompt: "review" })
        .catch((error: unknown) => error);
      return vi.advanceTimersByTimeAsync(60_000).then(() => pending);
    };

    expect(await complete()).toBeInstanceOf(RetiredModelError);
    expect(wireFetch).toHaveBeenCalledOnce();
    // The risk classifier keeps its own bounded retry: each further call is refused before the network.
    expect(await complete()).toBeInstanceOf(RetiredModelError);
    expect(await complete()).toBeInstanceOf(RetiredModelError);
    expect(wireFetch).toHaveBeenCalledOnce();
  });
});
