/** Rates come from the bundled snapshot; review fixtures when it changes. */
import { formatCost } from "../../lib/cost-format.js";
import { describe, expect, it } from "vitest";
import { knownModelPricing, parseResolvedModelPricing, resolveModelPricing, vendorDefaultApiBase, vendorNativeBase } from "../model-pricing.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeCost, promptTokensForTier, ratesForPrompt, type TokenRates } from "../pricing-data.js";
import { OPENAI_COMPATIBLE_VENDOR_PRESETS } from "../llm-vendor-defaults.js";
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
    expect(parseResolvedModelPricing({ source: "pricing-catalog", rates: { inputPer1M: 1, outputPer1M: 2, surchargeInputThreshold: invalid, surchargeInputMultiplier: 2 } })).toBeUndefined();
  });

  it("reads back a price an older build recorded from the hand-kept table", () => {
    // Persisted turns retain their recorded table-price provenance.
    const recorded = { source: "pricing-catalog", rates: { inputPer1M: 1, outputPer1M: 5 } };
    expect(parseResolvedModelPricing(recorded)).toEqual(recorded);
  });

  it("reads an older build's long-context surcharge as the tier it priced as", () => {
    const recorded = parseResolvedModelPricing({
      source: "pricing-catalog",
      rates: { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25,
        surchargeInputThreshold: 272_000, surchargeInputMultiplier: 2, surchargeOutputMultiplier: 1.5 },
    });
    expect(recorded).toEqual({
      source: "pricing-catalog",
      rates: { inputPer1M: 2.5, outputPer1M: 15, cacheReadPer1M: 0.25,
        tiers: [{ afterInputTokens: 272_000, inputPer1M: 5, outputPer1M: 22.5, cacheReadPer1M: 0.5, cacheWritePer1M: 5 }] },
    });
    const tableRates = knownModelPricing(recorded!)!.rates;
    expect(computeCost({ inputTokens: 272_000, outputTokens: 10_000 }, tableRates, "openai")).toBeCloseTo(0.83, 5);
    expect(computeCost({ inputTokens: 300_000, outputTokens: 10_000 }, tableRates, "openai")).toBeCloseTo(1.725, 5);
    expect(computeCost({ inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 100_000, cacheWriteTokens: 50_000 }, tableRates, "openai"))
      .toBeCloseTo((150_000 * 5 + 100_000 * 0.5 + 50_000 * 5) / MILLION, 8);
  });
});

describe("resolveModelPricing — source order and provenance", () => {
  it("records why a name-matched proxy route without its own price is unknown", () => {
    const proxy = { baseUrl: "https://proxy.example.test/v1" };
    const expected = { source: "unknown", reason: "endpoint-price-unavailable" };
    expect(resolveModelPricing("openai", "gpt-5.4", [], proxy)).toEqual(expected);
    expect(resolveModelPricing("openai", "gpt-5.4", [], {
      ...proxy, reported: { prompt: "-1", completion: "0" },
    })).toEqual(expected);
    expect(parseResolvedModelPricing(expected)).toEqual(expected);
    expect(resolveModelPricing("openai", "gpt-5.4", [], { baseUrl: "https://api.openai.com/v1" }).source)
      .toBe("model-catalog");
    expect(resolveModelPricing("openai", "gpt-5.4", [], {
      ...proxy, reported: { prompt: "0.000003", completion: "0.000004" },
    })).toEqual({ source: "endpoint-report", rates: { inputPer1M: 3, outputPer1M: 4 } });
  });

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

  it.each([
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-3-opus-20240229",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
  ])("answers unknown for the retired id %s the catalog does not list", (model) => {
    // Undocumented aliases have unknown prices, never zero.
    expect(resolveModelPricing("claude", model)).toEqual({ source: "unknown" });
  });

  it("prices a dated id of a listed model from that model's entry", () => {
    expect(resolveModelPricing("openai", "gpt-4.1-2025-04-14")).toMatchObject({ source: "model-catalog", catalogEntry: "openai/gpt-4.1" });
    expect(resolveModelPricing("openai", "o3-2025-04-16")).toMatchObject({ source: "model-catalog", catalogEntry: "openai/o3" });
  });

  it("answers unknown when nothing prices the model", () => {
    expect(resolveModelPricing("openai-compatible", "Qwen3.6-35B-A3B-NVFP4")).toEqual({ source: "unknown" });
    expect(resolveModelPricing("openai", "no-such-model-xyz")).toEqual({ source: "unknown" });
  });

  it("treats a catalog entry with no price as unknown, not free", () => {
    expect(activeModelCatalog().providers.openai?.models["gpt-image-1"]?.cost).toBeUndefined();
    expect(resolveModelPricing("openai", "gpt-image-1")).toEqual({ source: "unknown" });
  });

  it("does not show a catalog's listed zero as free, and says the catalog listed it", () => {
    expect(activeModelCatalog().providers.zai?.models["glm-4.7-flash"]?.cost).toMatchObject({ input: 0, output: 0 });
    expect(resolveModelPricing("zai", "glm-4.7-flash")).toEqual({ source: "unknown", catalogListsZero: "zai/glm-4.7-flash" });
  });

  it("does not price a self-hosted route from a public entry, even a named one", () => {
    // A named catalog entry supplies limits, not the user endpoint’s price.
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
  it("selects each threshold of the bundled gateway catalog's multi-tier entry", () => {
    const price = rates("openrouter", "qwen/qwen3-coder-flash");
    expect(ratesForPrompt(price, 32_000)).toMatchObject({
      inputPer1M: 0.195, outputPer1M: 0.975, cacheReadPer1M: 0.039, cacheWritePer1M: 0.24375,
    });
    expect(ratesForPrompt(price, 32_001)).toMatchObject({
      inputPer1M: 0.325, outputPer1M: 1.625, cacheReadPer1M: 0.065, cacheWritePer1M: 0.40625,
    });
    expect(ratesForPrompt(price, 128_000).inputPer1M).toBe(0.325);
    expect(ratesForPrompt(price, 128_001)).toMatchObject({
      inputPer1M: 0.52, outputPer1M: 2.6, cacheReadPer1M: 0.104, cacheWritePer1M: 0.65,
    });
  });

  it("uses base rates through 100,000 prompt tokens and the tier above", () => {
    const haiku = rates("claude", "claude-haiku-5-5");
    // Tier size includes cached input even when usage reports fresh input separately.
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
    expect(computeCost({ inputTokens: 100_000, cacheReadTokens: 50_000, outputTokens: 0 }, pro, "gemini"))
      .toBeCloseTo(0.05 * 1.25 + 0.05 * 0.125, 9);
  });

  it("prices a reported cache write at the catalog's write rate on a cache-included route", () => {
    const gpt = rates("openai", "gpt-5.6");
    expect(gpt.cacheWritePer1M).toBe(5);
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

describe("resolveModelPricing — the endpoint's own price report", () => {
  const report = { prompt: "0.0000025", completion: "0.00001", inputCacheRead: "0.00000025", inputCacheWrite: "0.000003", internalReasoning: "0.0000004" };

  it("reads OpenRouter's USD-per-token strings as per-million rates", () => {
    expect(resolveModelPricing("openrouter", "lab/unlisted-reasoner", [], { reported: report })).toEqual({
      source: "endpoint-report",
      rates: { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 0.25, cacheWritePer1M: 3, reasoningPer1M: 0.4 },
    });
  });

  it("requires endpoint pricing for a deployment alias on a native resource host", () => {
    expect(resolveModelPricing("azure-foundry", "gpt-5.4-mini", [], {
      baseUrl: "https://fixture.openai.azure.com/openai/v1",
    })).toEqual({ source: "unknown", reason: "endpoint-price-unavailable" });
  });

  it("prices a route that does not establish the catalog's model from its report, not the name match", () => {
    expect(resolveModelPricing("azure-foundry", "gpt-4o", [], { reported: report })).toMatchObject({ source: "endpoint-report" });
    expect(resolveModelPricing("openai", "gpt-5.4", [], { baseUrl: "https://proxy.invalid/v1", reported: report }))
      .toMatchObject({ source: "endpoint-report" });
  });

  it("keeps the catalog where the route establishes the model and the catalog prices it", () => {
    expect(resolveModelPricing("openai", "gpt-5.4", [], { reported: report })).toMatchObject({ source: "model-catalog", catalogEntry: "openai/gpt-5.4" });
    expect(resolveModelPricing("openai", "gpt-5.4", [], { baseUrl: "https://api.openai.com/v1", reported: report }))
      .toMatchObject({ source: "model-catalog" });
  });

  it("takes the user's correction over the report", () => {
    const override = { vendor: "openrouter", model: "lab/unlisted-reasoner", inputPer1M: 1, outputPer1M: 2 };
    expect(resolveModelPricing("openrouter", "lab/unlisted-reasoner", [override], { reported: report })).toMatchObject({ source: "user" });
  });

  it.each([
    [{ prompt: "-1", completion: "-1" }],
    [{ prompt: "0", completion: "0" }],
    [{ prompt: "0.000001" }],
    [{ prompt: "free", completion: "0.000002" }],
  ])("is not a price: %j", (reported) => {
    expect(resolveModelPricing("openrouter", "lab/unlisted-reasoner", [], { reported })).toEqual({ source: "unknown" });
  });

  it("rejects non-finite endpoint rates and rates that overflow during scaling", () => {
    for (const prompt of ["1e309", "1e308", "1.8e302"]) {
      expect(resolveModelPricing("openai", "gpt-5.4", [], {
        baseUrl: "https://proxy.invalid/v1",
        reported: { prompt, completion: "0.000001" },
      })).toEqual({ source: "unknown", reason: "endpoint-price-unavailable" });
    }
  });

  it("parses a recorded unknown price with missing route provenance", () => {
    const snapshot = { source: "unknown", reason: "legacy-route-unrecorded" };
    expect(parseResolvedModelPricing(snapshot)).toEqual(snapshot);
  });

  it("formats a non-finite cost as unknown", () => {
    for (const amount of [Infinity, -Infinity, NaN]) {
      expect(formatCost(amount)).not.toContain("$");
    }
  });

  it("drops an extra price that does not parse instead of the whole report", () => {
    expect(resolveModelPricing("openrouter", "lab/unlisted-reasoner", [], { reported: { prompt: "1e-6", completion: "0.000002", inputCacheRead: "n/a" } }))
      .toEqual({ source: "endpoint-report", rates: { inputPer1M: 1, outputPer1M: 2 } });
  });

  it("reads a recorded endpoint-report snapshot back, and older records still read", () => {
    const recorded = { source: "endpoint-report", rates: { inputPer1M: 2.5, outputPer1M: 10 } };
    expect(parseResolvedModelPricing(recorded)).toEqual(recorded);
    expect(parseResolvedModelPricing({ source: "pricing-catalog", rates: { inputPer1M: 1, outputPer1M: 2 } }))
      .toEqual({ source: "pricing-catalog", rates: { inputPer1M: 1, outputPer1M: 2 } });
    expect(parseResolvedModelPricing({ source: "model-catalog", rates: { inputPer1M: 1, outputPer1M: 2 }, catalogEntry: "openai/x" }))
      .toMatchObject({ source: "model-catalog" });
  });
});

describe("vendorNativeBase — where a vendor's published price holds", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/responses", "https://api.openai.com/v1"],
    ["openai", "https://eu.api.openai.com/v1/chat/completions", "https://eu.api.openai.com/v1"],
    ["claude", "https://api.anthropic.com/v1/messages", "https://api.anthropic.com/v1"],
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent", "https://generativelanguage.googleapis.com/v1beta"],
    ["vertex-ai", "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/p/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent", "https://us-central1-aiplatform.googleapis.com/v1beta1"],
    ["vertex-ai", "https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/publishers/google/models/gemini-2.5-pro:streamGenerateContent", "https://aiplatform.googleapis.com/v1beta1"],
    ["vertex-ai", "https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/p/locations/eu/publishers/google/models/gemini-2.5-pro:streamGenerateContent", "https://aiplatform.eu.rep.googleapis.com/v1beta1"],
    ["vertex-ai", "https://aiplatform.us.rep.googleapis.com/v1beta1/projects/p/locations/us/publishers/google/models/gemini-2.5-pro:streamGenerateContent", "https://aiplatform.us.rep.googleapis.com/v1beta1"],
    ["openrouter", "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1"],
    ["zai", "https://api.z.ai/api/paas/v4/chat/completions", "https://api.z.ai/api/paas/v4"],
    ["zai-coding-plan", "https://api.z.ai/api/coding/paas/v4/chat/completions", "https://api.z.ai/api/coding/paas/v4"],
  ] as const)("%s at %s", (vendor, address, base) => {
    expect(vendorNativeBase(vendor, address)).toBe(base);
  });

  it.each([
    // Another product on the vendor's own host.
    ["openai", "https://api.openai.com/gateway/v1/chat/completions"],
    ["openai", "https://api.openai.com/v1beta/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/alpha/v1/chat/completions"],
    ["openrouter", "https://openrouter.ai/api/v1-preview/chat/completions"],
    ["zai", "https://api.z.ai/api/coding/paas/v4/chat/completions"],
    ["claude", "https://api.anthropic.com/proxy/v1/messages"],
    ["gemini", "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:streamGenerateContent"],
    ["vertex-ai", "https://aiplatform.googleapis.com/v1beta1/projects/p/locations/global/endpoints/custom:predict"],
    ["vertex-ai", "https://aiplatform.ap.rep.googleapis.com/v1beta1/projects/p/locations/ap/publishers/google/models/m:streamGenerateContent"],
    // A proxy, a plain-HTTP or ported copy of the host, a deployment alias, a custom endpoint.
    ["openai", "https://proxy.invalid/v1/responses"],
    ["openai", "http://api.openai.com/v1/responses"],
    ["openai", "https://api.openai.com:8443/v1/responses"],
    ["azure-foundry", "https://fixture.openai.azure.com/openai/v1/responses"],
    ["openai-compatible", "https://api.openai.com/v1/chat/completions"],
    ["openai", "not a url"],
  ] as const)("is not established for %s at %s", (vendor, address) => {
    expect(vendorNativeBase(vendor, address)).toBeUndefined();
  });

  it("names every preset's default address as its own base", () => {
    const vendors = Object.keys(OPENAI_COMPATIBLE_VENDOR_PRESETS) as (keyof typeof OPENAI_COMPATIBLE_VENDOR_PRESETS)[];
    expect(vendors.length).toBeGreaterThan(30);
    for (const vendor of vendors) {
      const base = OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl.replace(/\/+$/u, "");
      expect(vendorNativeBase(vendor, `${base}/chat/completions`), vendor).toBe(base);
      expect(vendorDefaultApiBase(vendor), vendor).toBe(OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl);
    }
  });
});

describe("resolveModelPricing — the route a request was served on decides its price", () => {
  const report = { prompt: "0.000003", completion: "0.000004" };
  const priced = { source: "endpoint-report", rates: { inputPer1M: 3, outputPer1M: 4 } };
  const unavailable = { source: "unknown", reason: "endpoint-price-unavailable" };
  const native = (vendor: string, address: string) => {
    const base = vendorNativeBase(vendor, address);
    return base === undefined ? ({ kind: "unknown" } as const) : ({ kind: "vendor-native", base } as const);
  };

  it("prices nothing a transport could not place, whatever the settings and the cache say", () => {
    const served = { kind: "unknown" } as const;
    expect(resolveModelPricing("openai", "gpt-5.4", [], { served })).toEqual(unavailable);
    expect(resolveModelPricing("claude", "claude-sonnet-4-6", [], { served })).toEqual(unavailable);
    expect(resolveModelPricing("openai", "gpt-5.4", [], {
      served, baseUrl: "https://api.openai.com/v1", reported: report, reportedAt: "https://api.openai.com/v1/models",
    })).toEqual(unavailable);
  });

  it("keeps every preset's catalog price for a request on its default address", () => {
    const catalog = activeModelCatalog();
    let catalogPriced = 0;
    for (const vendor of Object.keys(OPENAI_COMPATIBLE_VENDOR_PRESETS) as (keyof typeof OPENAI_COMPATIBLE_VENDOR_PRESETS)[]) {
      const model = CATALOG_PROVIDERS_BY_VENDOR[vendor]
        .flatMap((provider) => Object.entries(catalog.providers[provider]?.models ?? {}))
        .find(([id, entry]) => (entry.cost?.input ?? 0) > 0 && (entry.cost?.output ?? 0) > 0
          && resolveModelPricing(vendor, id).source === "model-catalog")?.[0];
      if (model === undefined) continue;
      const address = `${OPENAI_COMPATIBLE_VENDOR_PRESETS[vendor].baseUrl.replace(/\/+$/u, "")}/chat/completions`;
      expect(resolveModelPricing(vendor, model, [], { served: native(vendor, address) }), `${vendor} ${model}`)
        .toEqual(resolveModelPricing(vendor, model));
      catalogPriced += 1;
    }
    expect(catalogPriced).toBeGreaterThan(10);
  });

  it.each([
    ["openai", "gpt-5.4", "https://api.openai.com/v1/responses"],
    ["openai", "gpt-5.4", "https://eu.api.openai.com/v1/chat/completions"],
    ["claude", "claude-sonnet-4-6", "https://api.anthropic.com/v1/messages"],
    ["gemini", "gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent"],
    ["vertex-ai", "gemini-2.5-pro", "https://aiplatform.eu.rep.googleapis.com/v1beta1/projects/p/locations/eu/publishers/google/models/gemini-2.5-pro:streamGenerateContent"],
    ["vertex-ai", "gemini-2.5-pro", "https://aiplatform.us.rep.googleapis.com/v1beta1/projects/p/locations/us/publishers/google/models/gemini-2.5-pro:streamGenerateContent"],
  ] as const)("keeps the catalog price for %s %s answered from %s", (vendor, model, address) => {
    const projected = resolveModelPricing(vendor, model);
    expect(projected.source).toBe("model-catalog");
    expect(resolveModelPricing(vendor, model, [], { served: native(vendor, address) })).toEqual(projected);
  });

  it.each([
    ["openai", "gpt-5.4", "https://api.openai.com/gateway/v1/chat/completions"],
    ["openrouter", "qwen/qwen3-coder-flash", "https://openrouter.ai/api/alpha/v1/chat/completions"],
    ["zai", "glm-4.6", "https://api.z.ai/api/coding/paas/v4/chat/completions"],
  ] as const)("does not give %s %s its catalog price on another path of the vendor's host (%s)", (vendor, model, address) => {
    expect(resolveModelPricing(vendor, model).source).toBe("model-catalog");
    expect(resolveModelPricing(vendor, model, [], { served: native(vendor, address) })).toEqual(unavailable);
  });

  it("uses a report only for the endpoint whose model list it came from", () => {
    const base = "https://proxy.invalid/v1";
    const route = { baseUrl: base, reported: report, reportedAt: `${base}/models` };
    const served = { kind: "report-endpoint", base } as const;
    expect(resolveModelPricing("openai", "gpt-5.4", [], { ...route, served })).toEqual(priced);
    // The row is keyed to this endpoint, but its list was read from another origin.
    expect(resolveModelPricing("openai", "gpt-5.4", [], { ...route, reportedAt: "https://listing.invalid/v1/models", served }))
      .toEqual(unavailable);
    // No record of where the list was read.
    expect(resolveModelPricing("openai", "gpt-5.4", [], { baseUrl: base, reported: report, served })).toEqual(unavailable);
    // Same origin, another product path.
    expect(resolveModelPricing("zai", "glm-4.6", [], {
      reported: report, reportedAt: "https://api.z.ai/api/paas/v4/models",
      served: { kind: "report-endpoint", base: "https://api.z.ai/api/coding/paas/v4" },
    })).toEqual(unavailable);
  });

  it("keeps Foundry projects on one resource host apart, and reads a copied deployment address as its endpoint", () => {
    const projectA = "https://fixture.services.ai.azure.com/api/projects/project-a/openai/v1";
    const projectB = "https://fixture.services.ai.azure.com/api/projects/project-b/openai/v1";
    const listedByA = { reported: report, reportedAt: `${projectA}/models` };
    expect(resolveModelPricing("azure-foundry", "fixture-deployment", [], { ...listedByA, served: { kind: "report-endpoint", base: projectA } }))
      .toEqual(priced);
    expect(resolveModelPricing("azure-foundry", "fixture-deployment", [], { ...listedByA, served: { kind: "report-endpoint", base: projectB } }))
      .toEqual(unavailable);
    const copied = "https://fixture.openai.azure.com/openai/deployments/fixture/chat/completions?api-version=2024-10-21";
    expect(resolveModelPricing("azure-foundry", "gpt-5.4-mini", [], {
      reported: report,
      reportedAt: "https://fixture.openai.azure.com/openai/deployments/fixture/chat/completions/models",
      served: { kind: "report-endpoint", base: copied },
    })).toEqual(priced);
    expect(resolveModelPricing("azure-foundry", "gpt-5.4-mini", [], { served: { kind: "report-endpoint", base: copied } }))
      .toEqual(unavailable);
  });

  it("does not take the default endpoint's list as a regional host's report", () => {
    const model = "lab/unlisted-model";
    const listed = { reported: report, reportedAt: "https://api.openai.com/v1/models" };
    expect(resolveModelPricing("openai", model, [], { ...listed, served: native("openai", "https://api.openai.com/v1/responses") }))
      .toEqual(priced);
    expect(resolveModelPricing("openai", model, [], { ...listed, served: native("openai", "https://eu.api.openai.com/v1/responses") }))
      .toEqual({ source: "unknown" });
  });

  it("still applies a user correction for the vendor and model on any route", () => {
    expect(resolveModelPricing("openai", "gpt-5.4", [{ vendor: "openai", model: "gpt-5.4", inputPer1M: 1, outputPer1M: 2 }], {
      served: { kind: "unknown" },
    })).toEqual({ source: "user", rates: { inputPer1M: 1, outputPer1M: 2 } });
  });
});

describe("the bundled catalog's price shape", () => {
  it("contains no OpenRouter `overrides` field: one appearing needs a parser before it can ship", () => {
    const count = (value: unknown, field: string): number => value !== null && typeof value === "object"
      ? Object.entries(value).reduce((total, [key, child]) => total + (key === field ? 1 : 0) + count(child, field), 0)
      : 0;
    const read = (file: string): unknown => JSON.parse(readFileSync(join(process.cwd(), file), "utf8"));
    const input = read("scripts/model-catalog/models-dev-input.json");
    const snapshot = read("src/core/model-catalog/bundled-snapshot.json");
    // The counter sees these documents: the tiers this build does read are in both.
    expect(count(input, "tiers")).toBeGreaterThan(0);
    expect(count(snapshot, "tiers")).toBeGreaterThan(0);
    for (const document of [input, snapshot, read("scripts/model-catalog/models-dev-source.json")]) {
      expect(count(document, "overrides")).toBe(0);
    }
    expect(count({ cost: { overrides: [{ input: 1 }] } }, "overrides")).toBe(1);
  });
});
