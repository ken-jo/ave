/** Test shared cost math here; model-pricing.test.ts owns rate-source selection. */
import { describe, expect, it } from "vitest";
import { computeCost, normalizeAiSdkUsageForCost, type TokenRates } from "../pricing-data.js";
import { resolveModelPricing as engineResolveModelPricing } from "../../engine/llm/pricing.js";
import { knownModelPricing, resolveModelPricing } from "../model-pricing.js";

describe("shared pricing-data", () => {
  it("the engine prices with the shared resolver, not a copy of it", () => {
    expect(engineResolveModelPricing).toBe(resolveModelPricing);
  });

  it.each([
    // [input, output, explicit cache read, total of 1M input + output + cache read + cache write]
    [5, 25, undefined, 36.75],
    [10, 50, 0.25, 72.75],
    [4, 20, 0.2, 29.2],
    [2, 10, 0.1, 14.6],
    [2, 10, undefined, 14.7],
  ] as const)(
    "prices Anthropic cache lines additively (input %d, output %d, cache read %s)",
    (input, output, cacheRead, total) => {
      // A cache rate the rates leave out is derived: read 0.1× input, write 1.25× input.
      const rates: TokenRates = { inputPer1M: input, outputPer1M: output, ...(cacheRead !== undefined ? { cacheReadPer1M: cacheRead } : {}) };
      expect(computeCost(
        { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
        rates,
        "claude",
      )).toBeCloseTo(total, 5);
    },
  );
});

describe("engine pricing with a price correction", () => {
  // Apply the supplied correction here; pricing-overrides.test.ts owns correction precedence.
  const CORRECTION = [
    { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 99, outputPer1M: 199 },
  ];

  it("the resolver applies the correction it is given", () => {
    const p = resolveModelPricing("claude", "claude-sonnet-4-6", CORRECTION);
    expect(p).toEqual({ source: "user", rates: { inputPer1M: 99, outputPer1M: 199 } });
  });

  it("no correction means the listed price, not zero cost", () => {
    for (const pricing of [resolveModelPricing("claude", "claude-sonnet-4-6"), resolveModelPricing("claude", "claude-sonnet-4-6", [])]) {
      expect(pricing.source).toBe("model-catalog");
      expect(pricing.source !== "unknown" && pricing.rates.inputPer1M).toBe(3);
    }
  });
});

// Prompt-size tiers reprice the whole request above the threshold rather than only excess tokens.
describe("computeCost — gpt-5.4 long-context tier (issue #900)", () => {
  const gpt54 = knownModelPricing(resolveModelPricing("openai", "gpt-5.4"))!.rates;
  const gpt54mini = knownModelPricing(resolveModelPricing("openai", "gpt-5.4-mini"))!.rates;

  it("input == threshold (272_000) — base rates (> check, not >=)", () => {
    const cost = computeCost({ inputTokens: 272_000, outputTokens: 10_000 }, gpt54, "openai");
    expect(cost).toBeCloseTo(0.83, 5);
  });

  it("input == 272_001 — the whole request at input 2x + output 1.5x", () => {
    const cost = computeCost({ inputTokens: 272_001, outputTokens: 10_000 }, gpt54, "openai");
    expect(cost).toBeCloseTo(1.585005, 5);
  });

  it("input == 300_000, output 10_000 — exact USD per OpenAI flat-session model", () => {
    const cost = computeCost({ inputTokens: 300_000, outputTokens: 10_000 }, gpt54, "openai");
    expect(cost).toBeCloseTo(1.725, 5);
  });

  it("cache reads past the tier are priced at the doubled cache rate", () => {
    const cost = computeCost({ inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 100_000 }, gpt54, "openai");
    expect(cost).toBeCloseTo(1.05, 5);
  });

  it("a model without a tier (gpt-5.4-mini) — no multiplier even above 272K", () => {
    const cost = computeCost({ inputTokens: 350_000, outputTokens: 10_000 }, gpt54mini, "openai");
    expect(cost).toBeCloseTo(0.3075, 5);
  });
});

describe("normalizeAiSdkUsageForCost", () => {
  it("converts AI SDK total input to Claude fresh input before cost math", () => {
    const normalized = normalizeAiSdkUsageForCost(
      {
        inputTokens: 1_700_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 200_000,
      },
      "claude",
    );

    expect(normalized).toEqual({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 200_000,
    });
  });

  it.each(["openai", "azure-foundry", "gemini", "vertex-ai"] as const)(
    "keeps %s provider prompt tokens cache-inclusive",
    (vendor) => {
      const usage = {
        inputTokens: 1_700_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 200_000,
      };
      expect(normalizeAiSdkUsageForCost(usage, vendor)).toBe(usage);
    },
  );
});
