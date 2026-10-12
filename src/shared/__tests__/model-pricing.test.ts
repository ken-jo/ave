/**
 * Pricing through the model catalog (issue #2501, slice 5): the order of the
 * price sources, what each records, prompt-size tiers at their boundaries,
 * cache and reasoning rates, and the paths where no price is known.
 *
 * Runs against the bundled snapshot the test setup installs, so the figures
 * below are the snapshot of 2026-10-12's.
 */
import { describe, expect, it } from "vitest";
import { knownModelPricing, parseResolvedModelPricing, resolveModelPricing } from "../model-pricing.js";
import { computeCost, promptTokensForTier, ratesForPrompt, type TokenRates } from "../pricing-data.js";
import { activeModelCatalog } from "../model-catalog/active.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "../model-catalog/provider-map.js";

function rates(vendor: string, model: string): TokenRates {
  const pricing = knownModelPricing(resolveModelPricing(vendor, model));
  if (!pricing) throw new Error(`${vendor}/${model} is not priced`);
  return pricing.rates;
}

const MILLION = 1_000_000;

describe("parseResolvedModelPricing", () => {
  it("round-trips complete request prices and copies only pricing fields", () => {
    const pricing = resolveModelPricing("gemini", "gemini-2.5-pro");
    expect(parseResolvedModelPricing({ ...pricing, unrelated: "discard" })).toEqual(pricing);
    expect(parseResolvedModelPricing(resolveModelPricing("qwen", "qwen-plus")))
      .toEqual(resolveModelPricing("qwen", "qwen-plus"));
    expect(parseResolvedModelPricing({ source: "unknown", unrelated: "discard" })).toEqual({ source: "unknown" });
  });

  it("retains explicit free request prices", () => {
    const pricing = { source: "user", rates: { inputPer1M: 0, outputPer1M: 0 } };
    expect(parseResolvedModelPricing(pricing)).toEqual(pricing);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, "2"])("rejects a malformed rate %s", (invalid) => {
    expect(parseResolvedModelPricing({ source: "user", rates: { inputPer1M: invalid, outputPer1M: 1 } })).toBeUndefined();
    expect(parseResolvedModelPricing({ source: "model-catalog", rates: { inputPer1M: 1, outputPer1M: 2, tiers: [{ afterInputTokens: 10, cacheReadPer1M: invalid }] } })).toBeUndefined();
  });
});

describe("resolveModelPricing — source order and provenance", () => {
  it("prices a model the catalog knows from its entry, and names the entry", () => {
    expect(resolveModelPricing("gemini", "gemini-2.5-pro")).toEqual({
      source: "model-catalog",
      catalogEntry: "google/gemini-2.5-pro",
      rates: {
        inputPer1M: 1.25,
        outputPer1M: 10,
        cacheReadPer1M: 0.125,
        tiers: [{ afterInputTokens: 200_000, inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25 }],
      },
    });
  });

  it("lets a user correction outrank the catalog, taken whole", () => {
    const pricing = resolveModelPricing("openai", "gpt-5.4", [
      { vendor: "openai", model: "gpt-5.4", inputPer1M: 1, outputPer1M: 6 },
    ]);
    // No catalog tier and no catalog cache rate is mixed into the user's rates.
    expect(pricing).toEqual({ source: "user", rates: { inputPer1M: 1, outputPer1M: 6 } });
  });

  it("matches a correction by the exact vendor and model, not a prefix", () => {
    const overrides = [{ vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 }];
    expect(resolveModelPricing("claude", "claude-sonnet-4-6-20260214", overrides).source).not.toBe("user");
    expect(resolveModelPricing("openai", "claude-sonnet-4-6", overrides).source).not.toBe("user");
  });

  it("reads a user's zero as a known $0 — a free internal endpoint is a statement", () => {
    const pricing = knownModelPricing(resolveModelPricing("openai-compatible", "local-model", [
      { vendor: "openai-compatible", model: "local-model", inputPer1M: 0, outputPer1M: 0 },
    ]));
    expect(pricing?.source).toBe("user");
    expect(computeCost({ inputTokens: 10_000, outputTokens: 1_000 }, pricing!.rates, "openai-compatible")).toBe(0);
  });

  it("falls to the hand-kept table for a model the catalog does not price", () => {
    expect(resolveModelPricing("claude", "claude-3-5-haiku-20241022")).toEqual({
      source: "pricing-catalog",
      rates: { inputPer1M: 1, outputPer1M: 5 },
    });
  });

  it("answers unknown when nothing prices the model", () => {
    expect(resolveModelPricing("openai-compatible", "Qwen3.6-35B-A3B-NVFP4")).toEqual({ source: "unknown" });
    expect(resolveModelPricing("openai", "no-such-model-xyz")).toEqual({ source: "unknown" });
  });

  it("treats a catalog entry with no price as unknown, not free", () => {
    // `gpt-image-1` is listed with no cost at all.
    expect(activeModelCatalog().providers.openai?.models["gpt-image-1"]?.cost).toBeUndefined();
    expect(resolveModelPricing("openai", "gpt-image-1")).toEqual({ source: "unknown" });
  });

  it("does not show a catalog's listed zero as free, and says the catalog listed it", () => {
    expect(activeModelCatalog().providers.zai?.models["glm-4.7-flash"]?.cost).toMatchObject({ input: 0, output: 0 });
    expect(resolveModelPricing("zai", "glm-4.7-flash")).toEqual({ source: "unknown", catalogListsZero: "zai/glm-4.7-flash" });
  });

  it("does not price a self-hosted route from a public entry, even a named one", () => {
    // `catalogModel` names an endpoint's model for its limits; the public
    // price is not what the user's own endpoint costs.
    expect(CATALOG_PROVIDERS_BY_VENDOR["openai-compatible"]).toEqual([]);
    expect(resolveModelPricing("openai-compatible", "gpt-5.4").source).toBe("unknown");
  });

  it("finds every mapped provider's prices stated in pairs: input and output together or not at all", () => {
    const catalog = activeModelCatalog();
    const providers = new Set(Object.values(CATALOG_PROVIDERS_BY_VENDOR).flat());
    for (const provider of providers) {
      for (const [id, model] of Object.entries(catalog.providers[provider]?.models ?? {})) {
        const cost = model.cost;
        if (!cost) continue;
        expect([cost.input === undefined, cost.output === undefined], `${provider}/${id}`).toEqual([false, false]);
      }
    }
  });
});

describe("computeCost — prompt-size tiers", () => {
  it("uses base rates through 100,000 prompt tokens and the tier above", () => {
    const haiku = rates("claude", "claude-haiku-5-5");
    // Cache-additive usage counts fresh input apart from the cache; the tier reads the whole prompt.
    const at = { inputTokens: 60_000, cacheReadTokens: 40_000, outputTokens: MILLION };
    const over = { ...at, inputTokens: 60_001 };
    expect(promptTokensForTier(at, "claude")).toBe(100_000);
    expect(computeCost(at, haiku, "claude")).toBeCloseTo(0.06 * 0.1 + 0.04 * 0.01 + 0.5, 9);
    expect(computeCost(over, haiku, "claude")).toBeCloseTo((60_001 / MILLION) * 0.5 + 0.04 * 0.05 + 2.5, 9);
  });

  it("applies 2× input and 1.5× output above 272,000 prompt tokens", () => {
    const gpt = rates("openai", "gpt-5.4");
    expect(computeCost({ inputTokens: 272_000, outputTokens: MILLION }, gpt, "openai")).toBeCloseTo(0.272 * 2.5 + 15, 9);
    expect(computeCost({ inputTokens: 272_001, outputTokens: MILLION }, gpt, "openai")).toBeCloseTo((272_001 / MILLION) * 5 + 22.5, 9);
  });

  it("chooses a cache-included route's tier by the whole prompt", () => {
    const pro = rates("gemini", "gemini-2.5-pro");
    // 150K fresh + 60K cached = 210K prompt: over 200K, so the tier's rates.
    const usage = { inputTokens: 210_000, cacheReadTokens: 60_000, outputTokens: 0 };
    expect(computeCost(usage, pro, "gemini")).toBeCloseTo(0.15 * 2.5 + 0.06 * 0.25, 9);
  });

  it("picks the highest tier a prompt exceeds when there are several", () => {
    const tiered: TokenRates = {
      inputPer1M: 1,
      outputPer1M: 2,
      tiers: [
        { afterInputTokens: 128_000, inputPer1M: 3, outputPer1M: 6 },
        { afterInputTokens: 32_000, inputPer1M: 2, outputPer1M: 4 },
      ],
    };
    expect(ratesForPrompt(tiered, 32_000).inputPer1M).toBe(1);
    expect(ratesForPrompt(tiered, 32_001).inputPer1M).toBe(2);
    expect(ratesForPrompt(tiered, 128_000).inputPer1M).toBe(2);
    expect(ratesForPrompt(tiered, 128_001).inputPer1M).toBe(3);
  });

  it("keeps a base rate the tier does not state", () => {
    const base: TokenRates = {
      inputPer1M: 1,
      outputPer1M: 2,
      cacheReadPer1M: 0.1,
      reasoningPer1M: 5,
      tiers: [{ afterInputTokens: 10, inputPer1M: 3, outputPer1M: 6 }],
    };
    expect(ratesForPrompt(base, 11)).toMatchObject({ inputPer1M: 3, outputPer1M: 6, cacheReadPer1M: 0.1, reasoningPer1M: 5 });
  });
});

describe("computeCost — cache and reasoning rates", () => {
  it("uses the output rate when the catalog lists reasoning at zero", () => {
    const pricing = rates("kilo", "kilo-auto/frontier");
    expect(pricing.reasoningPer1M).toBeUndefined();
    expect(computeCost({ inputTokens: 0, outputTokens: MILLION, reasoningTokens: MILLION }, pricing, "kilo"))
      .toBe(25);
  });

  it("prices cache reads at the published rate on a cache-included route", () => {
    const pro = rates("gemini", "gemini-2.5-pro");
    // 100K prompt, half of it cached: within the base tier.
    expect(computeCost({ inputTokens: 100_000, cacheReadTokens: 50_000, outputTokens: 0 }, pro, "gemini"))
      .toBeCloseTo(0.05 * 1.25 + 0.05 * 0.125, 9);
  });

  it("prices a reported cache write at the catalog's write rate on a cache-included route", () => {
    const gpt = rates("openai", "gpt-5.6");
    expect(gpt.cacheWritePer1M).toBe(5);
    // 200K prompt: 100K fresh, 50K read from cache, 50K written to it — within the base tier.
    expect(computeCost({ inputTokens: 200_000, cacheReadTokens: 50_000, cacheWriteTokens: 50_000, outputTokens: 0 }, gpt, "openai"))
      .toBeCloseTo(0.1 * 4 + 0.05 * 0.4 + 0.05 * 5, 9);
  });

  it("uses published rates on a cache-additive route", () => {
    const opus = rates("claude", "claude-opus-5-5");
    expect(computeCost({ inputTokens: 0, cacheReadTokens: MILLION, cacheWriteTokens: MILLION, outputTokens: 0 }, opus, "claude"))
      .toBeCloseTo(0.2 + 5, 9);
  });

  it("prices the entire output at a thinking-mode rate when reasoning is reported", () => {
    const qwen = rates("qwen", "qwen-plus");
    expect(qwen).toMatchObject({ outputPer1M: 0.287, reasoningPer1M: 1.147, reasoningRateScope: "output" });
    expect(computeCost({ inputTokens: 0, outputTokens: MILLION, reasoningTokens: 400_000 }, qwen, "qwen"))
      .toBeCloseTo(1.147, 9);
    // Without a reported split the whole output is ordinary output.
    expect(computeCost({ inputTokens: 0, outputTokens: MILLION }, qwen, "qwen")).toBeCloseTo(0.287, 9);
    // A reasoning count above the output is malformed and bounded by it.
    expect(computeCost({ inputTokens: 0, outputTokens: 100, reasoningTokens: 1_000 }, qwen, "qwen"))
      .toBeCloseTo((100 / MILLION) * 1.147, 12);
  });

  it("prices only the reasoning subset when the rate is token-specific", () => {
    const pricing: TokenRates = { inputPer1M: 0, outputPer1M: 8, reasoningPer1M: 3 };
    expect(computeCost({ inputTokens: 0, outputTokens: MILLION, reasoningTokens: 400_000 }, pricing, "openrouter"))
      .toBeCloseTo(0.6 * 8 + 0.4 * 3, 9);
  });

  it("prices reasoning as ordinary output where no reasoning rate is stated", () => {
    const gpt = rates("openai", "gpt-5.4");
    expect(computeCost({ inputTokens: 0, outputTokens: MILLION, reasoningTokens: 900_000 }, gpt, "openai")).toBeCloseTo(15, 9);
  });
});
