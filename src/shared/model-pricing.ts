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
 *  3. `pricing-catalog` — the hand-kept `DEFAULT_PRICING` row, for a model the
 *     catalog does not price (removed with the table in slice 7).
 *  4. `unknown` — nothing priced the model. Never shown as $0.
 *
 * Absent is not free (§3.1): a catalog entry without a price is unknown at
 * that rank, and one listing input and output at zero is the source's
 * statement, which is not shown as "free" either — the next rank answers, and
 * when none does the result is `unknown` carrying the entry that listed zero,
 * so the surface can say so.
 *
 * A route the catalog cannot match by name (a self-hosted or local endpoint)
 * is not priced from the entry its user named as `catalogModel`: that names
 * the model the endpoint serves for its limits, and the public price of that
 * model is not what the user's own endpoint costs.
 */
import { lookupBillablePricingOptional, type TokenRateTier, type TokenRates } from "./pricing-data.js";
import type { PricingOverride } from "./pricing-overrides.js";
import { activeModelCatalog } from "./model-catalog/active.js";
import { resolveCatalogKey } from "./model-catalog/resolve.js";
import type { CatalogModelCost } from "./model-catalog/types.js";

export type ModelPricingSource = "user" | "model-catalog" | "pricing-catalog";

export type ResolvedModelPricing =
  | {
      readonly source: ModelPricingSource;
      readonly rates: TokenRates;
      /** `<provider>/<id>` when the catalog answered. */
      readonly catalogEntry?: string;
    }
  | {
      readonly source: "unknown";
      /** The catalog entry that lists the model at zero, when one does: listed, not free. */
      readonly catalogListsZero?: string;
    };

export type KnownModelPricing = Extract<ResolvedModelPricing, { rates: TokenRates }>;

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
  const catalogRates = hit?.model.cost ? catalogTokenRates(hit.model.cost) : undefined;
  if (catalogEntry !== undefined && catalogRates !== undefined && listsAPrice(catalogRates)) {
    return { source: "model-catalog", rates: catalogRates, catalogEntry };
  }
  const row = lookupBillablePricingOptional(vendor, model);
  if (row) {
    return {
      source: "pricing-catalog",
      rates: {
        inputPer1M: row.inputPer1M,
        outputPer1M: row.outputPer1M,
        ...(row.cacheReadPer1M !== undefined ? { cacheReadPer1M: row.cacheReadPer1M } : {}),
        ...(row.cacheWritePer1M !== undefined ? { cacheWritePer1M: row.cacheWritePer1M } : {}),
        ...(row.surchargeInputThreshold !== undefined ? { surchargeInputThreshold: row.surchargeInputThreshold } : {}),
        ...(row.surchargeInputMultiplier !== undefined ? { surchargeInputMultiplier: row.surchargeInputMultiplier } : {}),
        ...(row.surchargeOutputMultiplier !== undefined ? { surchargeOutputMultiplier: row.surchargeOutputMultiplier } : {}),
      },
    };
  }
  return catalogEntry !== undefined && catalogRates !== undefined
    ? { source: "unknown", catalogListsZero: catalogEntry }
    : { source: "unknown" };
}

/** The rates, or `undefined` when nothing priced the model. */
export function knownModelPricing(pricing: ResolvedModelPricing): KnownModelPricing | undefined {
  return pricing.source === "unknown" ? undefined : pricing;
}

/**
 * A catalog cost as token rates, or `undefined` when it does not state both
 * the input and the output price — one side alone is not a price for a
 * request, and the missing side is unknown, not zero.
 */
function catalogTokenRates(cost: CatalogModelCost): TokenRates | undefined {
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
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

/** A listed zero input and output is the source's statement, not a price Ave shows. */
function listsAPrice(rates: TokenRates): boolean {
  return rates.inputPer1M > 0 || rates.outputPer1M > 0;
}
