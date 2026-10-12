/**
 * LLM pricing — the engine's door to the shared price resolution.
 *
 * The rates come from `shared/model-pricing.ts` (user correction, then the
 * model catalog, then the hand-kept table, else unknown), browser-safe so the
 * renderer prices with the same function. The corrections come from Settings
 * (`llm.pricingOverrides`) or, for a deployment that already sets it,
 * `AVE_PRICING_OVERRIDE` — both resolved and merged by
 * `shared/pricing-overrides.ts`. Callers pass the resolved list in; this
 * module does not reach for a settings service, because the usage aggregation
 * that calls it has to cache against that same list.
 */
import type { LLMVendor } from "./types.js";
import {
  computeCost as sharedComputeCost,
  normalizeAiSdkUsageForCost,
  type TokenRates,
  type UsageForCost,
} from "../../shared/pricing-data.js";

export type { TokenRates, UsageForCost };
export { normalizeAiSdkUsageForCost };
export { resolveModelPricing, knownModelPricing } from "../../shared/model-pricing.js";

/**
 * Compute cost (USD) for one request — thin re-export over `shared/pricing-data.ts`.
 *
 * The formula + vendor-asymmetry logic lives in the shared module so the
 * renderer billing badge (`TokenCostBadge`) consumes the same source of
 * truth without pulling Node-only imports. Engine callers keep using this
 * signature for back-compat.
 */
export function computeCost(
  usage: UsageForCost,
  pricing: TokenRates,
  vendor: LLMVendor,
): number {
  return sharedComputeCost(usage, pricing, vendor);
}
