/**
 * The request fields the model catalog decides, read off the bytes the
 * adapter hands to `fetch` (issue #2501 slice 3): the output limit after the
 * model's ceiling, and the reasoning level after the model's accepted levels.
 * Each case names what the request carried before the catalog decided it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forbidAmbientFetch } from "../../../../__tests__/support/network-fetch-stubs.js";
import { activeModelCatalog, installModelCatalog } from "../../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../../shared/model-catalog/types.js";
import type { LLMVendor } from "../../../../shared/llm-vendor-defaults.js";
import { VercelUnifiedProvider } from "../adapter.js";
import { planReasoning } from "../../reasoning-plan.js";
import { FallbackProvider } from "../fallback-chain.js";
import type { LLMProvider, StreamEvent } from "../../types.js";
import { freshAllVendorBlocks, getLlmVendorSettings, requestedLlmOutputTokenLimit } from "../../../../shared/llm-vendor-defaults.js";
import { resolveContextWindowForRoute, resolveOutputTokenLimit } from "../../../../shared/context-budget.js";
import { llmModelListCacheKey } from "../../../../shared/llm-model-list.js";
import { collectRoundStream } from "../../../turn/stream-collector.js";
import { apiRoundLlmSettings } from "../../../turn/round-llm-settings.js";

/** The first request body the provider sent; the response is refused, which ends the turn after the request left. */
async function sentBody(
  vendor: LLMVendor,
  model: string,
  params: { outputTokenLimit?: number; thinkingBudgetTokens?: number; enableThinking?: boolean; tools?: boolean },
): Promise<Record<string, unknown>> {
  const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
  const provider = new VercelUnifiedProvider(vendor, "fixture-key", undefined, fetchResponse);
  for await (const _event of provider.streamTurn({
    model,
    systemPrompt: "Return the result.",
    messages: [{ role: "user", content: "Report the value." }],
    enableThinking: params.enableThinking ?? true,
    ...(params.thinkingBudgetTokens === undefined ? {} : { thinkingBudgetTokens: params.thinkingBudgetTokens }),
    ...(params.outputTokenLimit === undefined ? {} : { outputTokenLimit: params.outputTokenLimit }),
    ...(params.tools ? { tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: {} } }] } : {}),
  })) {
    // Drain: the stream ends with the refusal.
  }
  expect(fetchResponse).toHaveBeenCalled();
  return JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
}

describe("request fields the catalog decides", () => {
  const bundled = activeModelCatalog();
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    installModelCatalog(bundled);
    vi.unstubAllGlobals();
  });

  it("clamps a requested output above the model's ceiling to the ceiling", async () => {
    // claude-haiku-4-5: catalog output 64,000. The Anthropic SDK happens to
    // know this model's limit as well; the OpenAI case below is one it does not.
    const body = await sentBody("claude", "claude-haiku-4-5", { outputTokenLimit: 100_000, enableThinking: false });
    expect(body.max_tokens).toBe(64_000);
  });

  it("leaves a request under the ceiling, and a model the catalog does not know, unclamped", async () => {
    expect((await sentBody("claude", "claude-haiku-4-5", { outputTokenLimit: 1_024, enableThinking: false })).max_tokens).toBe(1_024);
    expect((await sentBody("claude", "claude-3-7-sonnet-latest", { outputTokenLimit: 100_000, enableThinking: false })).max_tokens).toBe(100_000);
  });

  it("clamps an OpenAI chat request to the model's ceiling", async () => {
    // gpt-4o: catalog output 16,384. Before: 32,000.
    const body = await sentBody("openai", "gpt-4o", { outputTokenLimit: 32_000, enableThinking: false });
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(16_384);
  });

  it.each(["unlisted", "without-output"])("preserves a route's resolved unknown ceiling instead of matching its name again: %s", async (entry) => {
    installModelCatalog({ ...bundled, providers: {
      ...bundled.providers,
      openai: { models: { ...bundled.providers.openai!.models,
        "declared-model": { id: "declared-model", limits: { context: 128_000 } },
      } },
    } });
    const vendors = freshAllVendorBlocks();
    vendors.openai.model = "gpt-4";
    vendors.openai.catalogModel = entry === "unlisted" ? "openai/not-listed" : "openai/declared-model";
    vendors.openai.enableThinking = false;
    const route = resolveContextWindowForRoute({ provider: "openai", vendors });
    expect(route.output).not.toHaveProperty("ceiling");
    expect(route.output.effective).toBe(32_000);
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({
      provider: new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
      model: route.model, systemPrompt: "Report the result.",
      messages: [{ role: "user", content: "Continue." }], toolSchemas: [],
      llmSettings: apiRoundLlmSettings(vendors.openai, route.output, "none", route),
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(route.output.effective);
  });

  it.each([false, true].flatMap((enableThinking) => [
    { enableThinking, reported: undefined, expected: 32_000 },
    { enableThinking, reported: 8_192, expected: 8_192 },
  ]))("preserves the resolved ceiling through native message serialization: $reported (thinking $enableThinking)", async ({ enableThinking, reported, expected }) => {
    const vendors = freshAllVendorBlocks();
    vendors.claude.model = "claude-3-haiku-20240307";
    vendors.claude.catalogModel = "anthropic/not-listed";
    vendors.claude.enableThinking = enableThinking;
    const modelListCache = reported === undefined ? undefined : {
      [llmModelListCacheKey("claude")]: {
        vendor: "claude", models: [vendors.claude.model], endpoint: "https://provider.invalid/v1/models",
        modelEntries: [{ id: vendors.claude.model, maxOutputTokens: reported }], fetchedAt: new Date(0).toISOString(),
      },
    };
    const route = resolveContextWindowForRoute({ provider: "claude", vendors, modelListCache });
    if (reported === undefined) expect(route.output).not.toHaveProperty("ceiling");
    else expect(route.output.ceilingSource).toBe("provider-reported");
    expect(route.output.effective).toBe(expected);
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({
      provider: new VercelUnifiedProvider("claude", "fixture-key", undefined, fetchResponse),
      model: route.model, systemPrompt: "Report the result.",
      messages: [{ role: "user", content: "Continue." }], toolSchemas: [],
      llmSettings: apiRoundLlmSettings(vendors.claude, route.output, "none", route),
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(expected);
    if (enableThinking) expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 8_000 });
  });

  it("sends the lowest level GPT-5 accepts for a budget that maps below it", async () => {
    // gpt-5 accepts minimal/low/medium/high. Before: the name rule clamped "none" to "low".
    const body = await sentBody("openai", "gpt-5", { thinkingBudgetTokens: 100 });
    expect(body.reasoning).toMatchObject({ effort: "minimal" });
  });

  it("sends 'none' to a model whose catalog entry accepts it", async () => {
    // gpt-5.1 accepts none. Before: the name rule held "none" to GPT-5.2+ and sent "low".
    const body = await sentBody("openai", "gpt-5.1", { thinkingBudgetTokens: 100 });
    expect(body.reasoning).toMatchObject({ effort: "none" });
  });

  it("keeps the name rule for a model the catalog does not know", async () => {
    const body = await sentBody("openai", "gpt-5.0-fixture", { thinkingBudgetTokens: 100 });
    expect(body.reasoning).toMatchObject({ effort: "low" });
  });

  it("sends no reasoning control to a model the catalog says does not reason", async () => {
    const body = await sentBody("openai", "gpt-4.1", { thinkingBudgetTokens: 16_000 });
    expect(body.reasoning).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("keeps the name rule for a reasoning model whose levels the catalog does not list", async () => {
    // Reasoning supported, no effort list: absent levels are unknown levels,
    // and reading them as "none" dropped the effort the name rule sends.
    installModelCatalog({
      ...bundled,
      providers: { ...bundled.providers, openai: { models: { "gpt-5.4-nano": { id: "gpt-5.4-nano", limits: { context: 400_000 }, reasoning: { supported: true } } } } },
    } as ModelCatalogDocument);
    const body = await sentBody("openai", "gpt-5.4-nano", { thinkingBudgetTokens: 16_000 });
    expect((body.reasoning as { effort?: unknown } | undefined)?.effort).toBe("high");
  });

  it("sends no reasoning effort to a Claude model on Copilot", async () => {
    // Copilot serves GitHub Models, which the catalog does not describe; the
    // name rule sends reasoning_effort only to OpenAI reasoning models.
    const body = await sentBody("copilot", "claude-sonnet-4.6", { thinkingBudgetTokens: 16_000 });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
  });

  it("records the reasoning a GPT-5 tool turn on Chat Completions actually sends", async () => {
    // Copilot talks Chat Completions, which answers 400 to reasoning_effort with tools on GPT-5.x.
    const request = { hasTools: true, customBaseUrl: false };
    const plan = planReasoning({ vendor: "copilot", model: "gpt-5.4", enableThinking: true, budgetTokens: 16_000, request });
    expect(plan).toMatchObject({ kind: "none", requestedEffort: "high", suppressed: "chat-completions-tool-turn" });
    const withTools = await sentBody("copilot", "gpt-5.4", { thinkingBudgetTokens: 16_000, tools: true });
    expect(withTools.reasoning_effort).toBeUndefined();
    // Without tools the same route carries the effort, and the plan says so.
    expect(planReasoning({ vendor: "copilot", model: "gpt-5.4", enableThinking: true, budgetTokens: 16_000, request: { ...request, hasTools: false } }))
      .toMatchObject({ kind: "openai-effort", effort: "high" });
    expect((await sentBody("copilot", "gpt-5.4", { thinkingBudgetTokens: 16_000 })).reasoning_effort).toBe("high");
  });

  it("lowers an adaptive Claude effort to the nearest level the model accepts", async () => {
    installModelCatalog({
      ...bundled,
      providers: {
        ...bundled.providers,
        anthropic: {
          models: {
            "claude-sonnet-4-6": {
              id: "claude-sonnet-4-6",
              limits: { context: 1_000_000, output: 128_000 },
              reasoning: { supported: true, effort: ["low", "medium"] },
            },
          },
        },
      },
    } as ModelCatalogDocument);
    // Budget 20,000 maps to "max"; the fixture accepts up to "medium".
    const body = await sentBody("claude", "claude-sonnet-4-6", { thinkingBudgetTokens: 20_000 });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toMatchObject({ effort: "medium" });
  });
});

describe("the output limit a chat round records is the one it sends", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => vi.unstubAllGlobals());

  async function roundBody(reported: number, outputTokenLimit: number) {
    const block = getLlmVendorSettings({ openai: { model: "gpt-5.4", enableThinking: false, thinkingBudgetTokens: 0, outputTokenLimit } }, "openai");
    const output = resolveOutputTokenLimit({
      vendor: "openai",
      model: "gpt-5.4",
      requested: requestedLlmOutputTokenLimit(block),
      reported,
    });
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    await collectRoundStream({
      provider: new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
      model: "gpt-5.4",
      systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }],
      toolSchemas: [],
      llmSettings: apiRoundLlmSettings(block, output, "none"),
    });
    return { output, body: JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown> };
  }

  it("sends the user's limit when the endpoint reports a ceiling above the catalog's", async () => {
    // Catalog: gpt-5.4 output 128,000. Endpoint reports 200,000; the user asks 150,000.
    // Re-clamping to the catalog in the adapter would send 128,000 while the turn recorded 150,000.
    const { output, body } = await roundBody(200_000, 150_000);
    expect(output).toMatchObject({ effective: 150_000, effectiveSource: "user", ceiling: 200_000 });
    expect(body.max_output_tokens).toBe(150_000);
  });

  it("sends the reported ceiling when it is below the request", async () => {
    const { output, body } = await roundBody(8_192, 150_000);
    expect(output).toMatchObject({ effective: 8_192, effectiveSource: "provider-reported" });
    expect(body.max_output_tokens).toBe(8_192);
  });
});

describe("a fallback model's output ceiling", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([200_000, null])("uses its own ceiling after the primary resolved %s", async (outputCeiling) => {
    vi.useFakeTimers();
    // The primary route carries a reported ceiling or an explicitly unknown one.
    const primary: LLMProvider = {
      vendor: "openai",
      streamTurn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
        yield { type: "error", error: "503 fixture unavailable", classification: "network" };
      }),
    };
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response("refused", { status: 400 }));
    const wrapped = new FallbackProvider(
      primary,
      [{ provider: "openai", model: "gpt-4o" }],
      () => "fixture-key",
      () => new VercelUnifiedProvider("openai", "fixture-key", undefined, fetchResponse),
    );
    const drained = (async () => {
      for await (const _event of wrapped.streamTurn({
        model: "gpt-5.4",
        systemPrompt: "Return the result.",
        messages: [{ role: "user", content: "Report the value." }],
        enableThinking: false,
        outputTokenLimit: 150_000,
        outputCeiling,
      })) {
        // Drain: the fallback's request is refused, which ends the turn.
      }
    })().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await drained;
    expect(fetchResponse).toHaveBeenCalled();
    const body = JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    // The fallback's catalog ceiling bounds the request in both cases.
    expect(body.max_tokens ?? body.max_completion_tokens).toBe(16_384);
  });
});
