/**
 * Token cost math — browser-safe, shared by the engine's usage accounting and
 * the renderer's cost surfaces so both price one request with one formula.
 *
 * Holds no prices. Who states a model's rates (a user correction, the model
 * catalog, or nobody) is decided in `shared/model-pricing.ts`; this module
 * turns rates and usage into USD:
 *   - prompt-size tiers replace the base rates for a whole request;
 *   - Anthropic bills prompt-cache reads and writes as additive lines
 *     (`anthropicCacheRates` derives missing cache rates at 0.1× / 1.25×
 *     input), everyone else counts the cache inside the prompt;
 *   - a reported reasoning subset of output is priced at the reasoning rate
 *     when one is stated.
 *
 * IMPORTANT: this module must stay pure — no `process.env`, no Node-only
 * imports.
 */

/**
 * The vendor classes a price correction can name and cost math distinguishes
 * (Anthropic's additive cache lines against everyone else's included cache),
 * in the order a picker should offer them. Any other vendor prices as
 * `openai-compatible`.
 *
 * One list: the type is derived from it and the membership test reads it, so a
 * vendor cannot be addable in the UI but unrecognised by `toPricingVendor`, or
 * vice versa.
 */
export const PRICING_VENDORS = [
  "claude",
  "openai",
  "gemini",
  "azure-foundry",
  "vertex-ai",
  "openai-compatible",
] as const;

export type PricingVendor = (typeof PRICING_VENDORS)[number];

const PRICING_VENDOR_SET = new Set<string>(PRICING_VENDORS);

export function toPricingVendor(vendor: string): PricingVendor {
  return PRICING_VENDOR_SET.has(vendor)
    ? vendor as PricingVendor
    : "openai-compatible";
}

/**
 * A price tier: once a request's prompt exceeds `afterInputTokens`, the rates
 * it states replace the base rates for that whole request. A rate the tier
 * does not state keeps the base rate.
 */
export interface TokenRateTier {
  afterInputTokens: number;
  inputPer1M?: number;
  outputPer1M?: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

/** What one request costs per token: $ per 1M tokens, nothing about capacity. */
export interface TokenRates {
  inputPer1M: number;
  outputPer1M: number;
  /**
   * Cache read price ($/1M tokens). Anthropic bills prompt-cache hits as a
   * separate additive line; OpenAI/Azure-compatible providers report cached
   * tokens as a subset of prompt tokens and price that subset at this rate
   * when published. Undefined → caller treats cache reads as ordinary input.
   */
  cacheReadPer1M?: number;
  /**
   * Cache write price ($/1M tokens). Anthropic only — 5m TTL ~1.25× input,
   * 1h TTL ~2× input. This single field assumes the dominant TTL.
   * Undefined → caller treats cache writes as ordinary input.
   */
  cacheWritePer1M?: number;
  /**
   * Reasoning-token price ($/1M tokens), when the model bills reasoning apart
   * from the rest of its output. The reasoning tokens a provider reports are
   * part of the output count; they are priced at this rate and the remainder
   * at `outputPer1M`. Undefined → reasoning is ordinary output.
   */
  reasoningPer1M?: number;
  /** A thinking-mode rate covers all output when the request reports positive reasoning tokens. */
  reasoningRateScope?: "output";
  /** Prompt-size tiers, ascending by `afterInputTokens` (the model catalog's `cost.tiers`). */
  tiers?: readonly TokenRateTier[];
}

/**
 * Anthropic prompt cache per-1M rates resolved against explicit rates. When
 * the rates omit `cacheReadPer1M` / `cacheWritePer1M`, the publicly-documented
 * Anthropic ratios are applied:
 *
 *   - read  = 0.1× input    (Sonnet $3 → $0.30, Opus $15 → $1.50, Haiku $1 → $0.10)
 *   - write = 1.25× input   (5m TTL — same ratio across Sonnet/Opus/Haiku)
 *
 * 1h-TTL deployments (write rate 2× input) require an explicit
 * `cacheWritePer1M` in the rates. This helper is the single place these
 * ratios are encoded; engine cost math (`engine/llm/pricing.ts:computeCost`)
 * and the renderer billing badge (`TokenCostBadge.tsx`) both consume it so the
 * published ratios stay in sync without duplication.
 */
export function anthropicCacheRates(
  pricing: Pick<TokenRates, "inputPer1M" | "cacheReadPer1M" | "cacheWritePer1M">,
): { read: number; write: number } {
  return {
    read: pricing.cacheReadPer1M ?? pricing.inputPer1M * 0.1,
    write: pricing.cacheWritePer1M ?? pricing.inputPer1M * 1.25,
  };
}

export interface UsageForCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * The part of `outputTokens` the provider reports as reasoning (AI SDK
   * `outputTokenDetails.reasoningTokens`). Priced at `reasoningPer1M` when the
   * rates state one; otherwise it is ordinary output.
   */
  reasoningTokens?: number;
}

/**
 * Normalize AI SDK v6 usage into the provider-cost contract above.
 *
 * AI SDK reports `inputTokens` as total prompt tokens and puts cache details
 * under `inputTokenDetails`. Anthropic cost math needs fresh input plus
 * additive cache lines, while OpenAI/Gemini style providers already include
 * cache inside prompt tokens. Their cached subset is split inside
 * `computeCost`, not at this normalization boundary.
 */
export function normalizeAiSdkUsageForCost<T extends UsageForCost | undefined>(
  usage: T,
  vendor: string,
): T {
  if (!usage || toPricingVendor(vendor) !== "claude") return usage;
  const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0;
  const cacheRead = Number.isFinite(usage.cacheReadTokens) ? (usage.cacheReadTokens ?? 0) : 0;
  const cacheWrite = Number.isFinite(usage.cacheWriteTokens) ? (usage.cacheWriteTokens ?? 0) : 0;
  return {
    ...usage,
    inputTokens: Math.max(0, input - Math.max(0, cacheRead) - Math.max(0, cacheWrite)),
  };
}

/**
 * The prompt size a request's price tier is chosen by: every prompt token the
 * provider read, cached or not. Cache-additive usage (after
 * {@link normalizeAiSdkUsageForCost}) counts fresh input apart from the cache
 * lines, so they are added back; everyone else reports the cache inside the
 * prompt count already.
 */
export function promptTokensForTier(usage: UsageForCost, vendor: string): number {
  const input = nonNegative(usage.inputTokens);
  if (toPricingVendor(vendor) !== "claude") return input;
  return input + nonNegative(usage.cacheReadTokens) + nonNegative(usage.cacheWriteTokens);
}

/**
 * The rates in force for a request whose prompt is `promptTokens` long: the
 * highest tier the prompt exceeds (strictly — a prompt exactly at the boundary
 * is billed at the rates below it), with any rate the tier does not state kept
 * from the base. No tiers, or a prompt within the first, is the base.
 */
export function ratesForPrompt(rates: TokenRates, promptTokens: number): TokenRates {
  let tier: TokenRateTier | undefined;
  for (const candidate of rates.tiers ?? []) {
    if (promptTokens > candidate.afterInputTokens && (tier === undefined || candidate.afterInputTokens > tier.afterInputTokens)) {
      tier = candidate;
    }
  }
  if (tier === undefined) return rates;
  return {
    ...rates,
    inputPer1M: tier.inputPer1M ?? rates.inputPer1M,
    outputPer1M: tier.outputPer1M ?? rates.outputPer1M,
    ...(tier.cacheReadPer1M !== undefined ? { cacheReadPer1M: tier.cacheReadPer1M } : {}),
    ...(tier.cacheWritePer1M !== undefined ? { cacheWritePer1M: tier.cacheWritePer1M } : {}),
  };
}

function nonNegative(n: number | undefined): number {
  // Token usage is monotonic, so a negative or non-finite value is malformed
  // upstream data; letting it through would produce negative USD and pollute
  // the usage dashboard.
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Compute cost (USD) for one request's usage against per-1M rates.
 *
 * Vendor argument selects how `inputTokens` and the cache fields combine —
 * see {@link UsageForCost} for the semantic asymmetry between Anthropic
 * (cache-additive) and everyone else (cache-included). The price tier is
 * chosen by the request's whole prompt ({@link promptTokensForTier}), so a
 * caller must price each provider request on its own: a turn's sum of rounds
 * is not one prompt.
 *
 * Lives here (not in `engine/llm/pricing.ts`) so renderer-side billing UI
 * (`TokenCostBadge`) consumes the same formula without pulling Node-only
 * imports. The engine module re-exports for back-compat.
 */
export function computeCost(
  usage: UsageForCost,
  pricing: TokenRates,
  vendor: string,
): number {
  const input = nonNegative(usage.inputTokens);
  const output = nonNegative(usage.outputTokens);
  const cacheRead = nonNegative(usage.cacheReadTokens);
  const cacheWrite = nonNegative(usage.cacheWriteTokens);
  const reasoning = Math.min(output, nonNegative(usage.reasoningTokens));
  const rates = ratesForPrompt(pricing, promptTokensForTier(usage, vendor));
  const pricedReasoning = rates.reasoningRateScope === "output" && reasoning > 0 ? output : reasoning;

  const per1M = (tokens: number, rate: number): number =>
    (tokens / 1_000_000) * rate;
  const outputCost = (): number =>
    per1M(output - pricedReasoning, rates.outputPer1M)
    + per1M(pricedReasoning, rates.reasoningPer1M ?? rates.outputPer1M);

  if (toPricingVendor(vendor) === "claude") {
    const { read: cacheReadRate, write: cacheWriteRate } = anthropicCacheRates(rates);
    return (
      per1M(input, rates.inputPer1M) +
      per1M(cacheRead, cacheReadRate) +
      per1M(cacheWrite, cacheWriteRate) +
      outputCost()
    );
  }
  // The provider's prompt count already includes the cache, so adding the
  // cache lines on top would double-count. Split the prompt into fresh, cache
  // read and cache write instead, so a published cache rate shows in every
  // cost surface; a cache rate the rates do not state is the input rate.
  const cachedRead = Math.min(input, cacheRead);
  const cachedWrite = Math.min(input - cachedRead, cacheWrite);
  const freshInput = input - cachedRead - cachedWrite;
  return (
    per1M(freshInput, rates.inputPer1M) +
    per1M(cachedRead, rates.cacheReadPer1M ?? rates.inputPer1M) +
    per1M(cachedWrite, rates.cacheWritePer1M ?? rates.inputPer1M) +
    outputCost()
  );
}
