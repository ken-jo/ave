// Resolve shared pricing from caller-supplied overrides so aggregation caches use the same inputs.
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

// Share pricing logic with rendering while preserving the engine caller signature.
export function computeCost(
  usage: UsageForCost,
  pricing: TokenRates,
  vendor: LLMVendor,
): number {
  return sharedComputeCost(usage, pricing, vendor);
}
