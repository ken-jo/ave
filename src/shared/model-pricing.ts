/**
 * What a model costs per token, and who said so (issue #2501, slice 5;
 * `docs/design/model-capability-catalog.md` §6).
 *
 * The one place the price sources are ordered. Every cost surface — the
 * pre-send estimate, the per-turn badge, the usage dashboard and the run
 * record — reads its rates here, so no two of them can price one request
 * differently.
 *
 *  1. `user` — a price correction for this exact vendor and model
 *     (`llm.pricingOverrides`, or the deployment's `AVE_PRICING_OVERRIDE`,
 *     resolved by `pricing-overrides.ts`). The correction states the rates the
 *     deployment pays, so it is taken whole: no catalog tier or reasoning rate
 *     is mixed into it, and a stated zero is a known $0.
 *  2. `model-catalog` — the catalog entry the vendor's model id resolves to
 *     (`resolveCatalogKey`), with its cache, reasoning and prompt-size tiers.
 *  3. `unknown` — nothing priced the model. Never shown as $0.
 *
 * Absent is not free (§3.1): a catalog entry without a price is unknown at
 * that rank, and one listing input and output at zero is the source's
 * statement, which is not shown as "free" either: the result is `unknown`
 * carrying the entry that listed zero, so the surface can say so.
 *
 * A route the catalog cannot match by name (a self-hosted or local endpoint)
 * is not priced from the entry its user named as `catalogModel`: that names
 * the model the endpoint serves for its limits, and the public price of that
 * model is not what the user's own endpoint costs.
 */
import type { TokenRateTier, TokenRates, UsageForCost } from "./pricing-data.js";
import { isPricingOverrideRate, type PricingOverride } from "./pricing-overrides.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { resolveCatalogKey } from "./model-catalog/resolve.js";
import type { CatalogModelCost } from "./model-catalog/types.js";

export type ModelPricingSource = "user" | "model-catalog";

/**
 * Who stated the rates a recorded price snapshot carries. Builds before issue
 * #2501's slice 7 also priced from the hand-kept table (`pricing-catalog`);
 * their persisted turns and usage rows keep that answer, which is read back
 * as it was recorded. Nothing resolves to it any more.
 */
type RecordedModelPricingSource = ModelPricingSource | "pricing-catalog";

export type ResolvedModelPricing<Source extends RecordedModelPricingSource = ModelPricingSource> =
  | {
      readonly source: Source;
      readonly rates: TokenRates;
      /** `<provider>/<id>` when the catalog answered. */
      readonly catalogEntry?: string;
    }
  | {
      readonly source: "unknown";
      /** The catalog entry that lists the model at zero, when one does: listed, not free. */
      readonly catalogListsZero?: string;
    };

/** A price snapshot read back from an IPC or persisted record. */
export type RecordedModelPricing = ResolvedModelPricing<RecordedModelPricingSource>;

export type KnownModelPricing = Extract<RecordedModelPricing, { rates: TokenRates }>;

/** Usage and the price resolved when that provider request ran. */
export interface ModelUsageSegment<Vendor extends string = string> {
  vendorProvider: Vendor;
  vendorModel: string;
  tokenUsage: UsageForCost;
  /** Absent only on records written before request prices were captured. */
  pricing?: RecordedModelPricing;
}

const OPTIONAL_TOKEN_RATE_FIELDS = ["cacheReadPer1M", "cacheWritePer1M", "reasoningPer1M"] as const;
const OPTIONAL_TIER_RATE_FIELDS = ["inputPer1M", "outputPer1M", "cacheReadPer1M", "cacheWritePer1M"] as const;

/**
 * A snapshot recorded by a build before slice 7 may state the hand-kept
 * table's long-context surcharge (GPT-5.4 and 5.4 Pro: past 272,000 prompt
 * tokens, 2× input and 1.5× output). It priced exactly as a prompt-size tier
 * at that threshold with the multiplied rates — input and both cache rates
 * (a missing cache rate being the input rate) at the input multiplier, output
 * and reasoning at the output multiplier — so it is read back as that tier.
 * Only non-Anthropic rows carried one, and only non-Anthropic cost math
 * applied it.
 */
function recordedSurchargeTier(raw: Record<string, unknown>, rates: TokenRates): TokenRateTier | undefined | null {
  const threshold = raw.surchargeInputThreshold;
  const inputMultiplier = raw.surchargeInputMultiplier ?? 1;
  const outputMultiplier = raw.surchargeOutputMultiplier ?? 1;
  // Multipliers without a threshold never applied.
  if (threshold === undefined) return undefined;
  if (!isPricingOverrideRate(threshold) || !isPricingOverrideRate(inputMultiplier) || !isPricingOverrideRate(outputMultiplier)) return null;
  if (rates.reasoningPer1M !== undefined && outputMultiplier !== 1) return null;
  return {
    afterInputTokens: threshold,
    inputPer1M: rates.inputPer1M * inputMultiplier,
    outputPer1M: rates.outputPer1M * outputMultiplier,
    cacheReadPer1M: (rates.cacheReadPer1M ?? rates.inputPer1M) * inputMultiplier,
    cacheWritePer1M: (rates.cacheWritePer1M ?? rates.inputPer1M) * inputMultiplier,
  };
}

/** Copy a price snapshot from an IPC or persisted record, validating every numeric field. */
export function parseResolvedModelPricing(value: unknown): RecordedModelPricing | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  if (obj.source === "unknown") {
    return {
      source: "unknown",
      ...(typeof obj.catalogListsZero === "string" ? { catalogListsZero: obj.catalogListsZero } : {}),
    };
  }
  if (obj.source !== "user" && obj.source !== "model-catalog" && obj.source !== "pricing-catalog") return undefined;
  if (!obj.rates || typeof obj.rates !== "object" || Array.isArray(obj.rates)) return undefined;
  const raw = obj.rates as Record<string, unknown>;
  if (!isPricingOverrideRate(raw.inputPer1M) || !isPricingOverrideRate(raw.outputPer1M)) return undefined;
  const rates: TokenRates = { inputPer1M: raw.inputPer1M, outputPer1M: raw.outputPer1M };
  for (const key of OPTIONAL_TOKEN_RATE_FIELDS) {
    if (raw[key] === undefined) continue;
    if (!isPricingOverrideRate(raw[key])) return undefined;
    rates[key] = raw[key];
  }
  if (raw.reasoningRateScope !== undefined) {
    if (raw.reasoningRateScope !== "output") return undefined;
    rates.reasoningRateScope = "output";
  }
  if (raw.tiers !== undefined) {
    if (!Array.isArray(raw.tiers)) return undefined;
    const tiers: TokenRateTier[] = [];
    for (const value of raw.tiers) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const rawTier = value as Record<string, unknown>;
      if (!isPricingOverrideRate(rawTier.afterInputTokens)) return undefined;
      const tier: TokenRateTier = { afterInputTokens: rawTier.afterInputTokens };
      for (const key of OPTIONAL_TIER_RATE_FIELDS) {
        if (rawTier[key] === undefined) continue;
        if (!isPricingOverrideRate(rawTier[key])) return undefined;
        tier[key] = rawTier[key];
      }
      tiers.push(tier);
    }
    rates.tiers = tiers;
  }
  const surchargeTier = recordedSurchargeTier(raw, rates);
  if (surchargeTier === null) return undefined;
  if (surchargeTier !== undefined) {
    // The table never stated tiers beside a surcharge.
    if (rates.tiers !== undefined) return undefined;
    rates.tiers = [surchargeTier];
  }
  return {
    source: obj.source,
    rates,
    ...(typeof obj.catalogEntry === "string" ? { catalogEntry: obj.catalogEntry } : {}),
  };
}

export function resolveModelPricing(
  vendor: string,
  model: string,
  overrides: readonly PricingOverride[] = [],
): ResolvedModelPricing {
  const override = overrides.find((entry) => entry.vendor === vendor && entry.model === model);
  if (override) {
    return {
      source: "user",
      rates: {
        inputPer1M: override.inputPer1M,
        outputPer1M: override.outputPer1M,
        ...(override.cacheReadPer1M !== undefined ? { cacheReadPer1M: override.cacheReadPer1M } : {}),
        ...(override.cacheWritePer1M !== undefined ? { cacheWritePer1M: override.cacheWritePer1M } : {}),
      },
    };
  }
  const hit = resolveCatalogKey(activeModelCatalog(), vendor, model);
  const catalogEntry = hit ? `${hit.provider}/${hit.id}` : undefined;
  const catalogRates = hit?.model.cost ? catalogTokenRates(hit.model.cost, hit.provider) : undefined;
  if (catalogEntry !== undefined && catalogRates !== undefined && listsAPrice(catalogRates)) {
    return { source: "model-catalog", rates: catalogRates, catalogEntry };
  }
  return catalogEntry !== undefined && catalogRates !== undefined
    ? { source: "unknown", catalogListsZero: catalogEntry }
    : { source: "unknown" };
}

/** The rates, or `undefined` when nothing priced the model. */
export function knownModelPricing(pricing: RecordedModelPricing): KnownModelPricing | undefined {
  return pricing.source === "unknown" ? undefined : pricing;
}

/**
 * A catalog cost as token rates, or `undefined` when it does not state both
 * the input and the output price — one side alone is not a price for a
 * request, and the missing side is unknown, not zero.
 */
function catalogTokenRates(cost: CatalogModelCost, provider: string): TokenRates | undefined {
  if (cost.input === undefined || cost.output === undefined) return undefined;
  const tiers: TokenRateTier[] = (cost.tiers ?? [])
    .map((tier) => ({
      afterInputTokens: tier.afterInputTokens,
      ...(tier.input !== undefined ? { inputPer1M: tier.input } : {}),
      ...(tier.output !== undefined ? { outputPer1M: tier.output } : {}),
      ...(tier.cacheRead !== undefined ? { cacheReadPer1M: tier.cacheRead } : {}),
      ...(tier.cacheWrite !== undefined ? { cacheWritePer1M: tier.cacheWrite } : {}),
    }))
    .sort((left, right) => left.afterInputTokens - right.afterInputTokens);
  return {
    inputPer1M: cost.input,
    outputPer1M: cost.output,
    ...(cost.cacheRead !== undefined ? { cacheReadPer1M: cost.cacheRead } : {}),
    ...(cost.cacheWrite !== undefined ? { cacheWritePer1M: cost.cacheWrite } : {}),
    // A listed zero does not establish free reasoning; use the output rate.
    ...(cost.reasoning !== undefined && cost.reasoning > 0 ? { reasoningPer1M: cost.reasoning } : {}),
    // This provider publishes a thinking-mode output rate, covering both
    // the thought and the answer rather than only the reasoning subset.
    ...(provider === "alibaba-cn" && cost.reasoning !== undefined && cost.reasoning > 0
      ? { reasoningRateScope: "output" as const }
      : {}),
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

/** A listed zero input and output is the source's statement, not a price Ave shows. */
function listsAPrice(rates: TokenRates): boolean {
  return rates.inputPer1M > 0 || rates.outputPer1M > 0;
}
