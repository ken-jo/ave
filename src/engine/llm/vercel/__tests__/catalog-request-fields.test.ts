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

/** The first request body the provider sent; the response is refused, which ends the turn after the request left. */
async function sentBody(
  vendor: LLMVendor,
  model: string,
  params: { outputTokenLimit?: number; thinkingBudgetTokens?: number; enableThinking?: boolean },
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
