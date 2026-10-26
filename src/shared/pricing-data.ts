/** Keep cost math pure and browser-safe so accounting and renderer surfaces use the same formula. */

/** The vendor list defines both picker order and accepted correction vendors; unknown vendors use openai-compatible pricing. */
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

/** A crossed prompt tier replaces rates for the whole request; omitted rates retain base values. */
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
  /** Cache-read rate in USD per million tokens; separate cache lines are additive, while included cache is split out of prompt usage. Undefined uses the input rate. */
  cacheReadPer1M?: number;
  /** Cache-write rate in USD per million tokens; explicit rates override the default short-TTL ratio. Undefined uses the input rate. */
  cacheWritePer1M?: number;
  /** Reasoning tokens are a subset of output; price that subset separately when a rate is stated. */
  reasoningPer1M?: number;
  /** A thinking-mode rate covers all output when the request reports positive reasoning tokens. */
  reasoningRateScope?: "output";
  tiers?: readonly TokenRateTier[];
}

/** Missing cache rates use 0.1 times input for reads and 1.25 times input for short-TTL writes; longer TTLs require an explicit write rate. */
function anthropicCacheRates(
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
  reasoningTokens?: number;
}

/** Normalize additive-cache usage to fresh input plus cache lines; leave included-cache usage inside prompt tokens until computeCost. */
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

/** Tier selection counts all prompt tokens, including cache; add separate cache lines back to fresh input. */
export function promptTokensForTier(usage: UsageForCost, vendor: string): number {
  const input = nonNegative(usage.inputTokens);
  if (toPricingVendor(vendor) !== "claude") return input;
  return input + nonNegative(usage.cacheReadTokens) + nonNegative(usage.cacheWriteTokens);
}

/** Use the highest strictly exceeded threshold; equality stays in the lower tier and omitted rates keep base values. */
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
  // Reject negative or non-finite usage to prevent malformed upstream data from producing negative costs.
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Price each provider request separately; a turn total is not one prompt for tier selection. */
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
  // Included cache must be split from prompt usage, never added on top; absent cache rates use the input rate.
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
