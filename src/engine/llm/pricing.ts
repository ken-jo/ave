// Resolve shared pricing from caller-supplied overrides so aggregation caches use the same inputs.
import { createHash } from "node:crypto";
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

/**
 * Names a configured endpoint without repeating it: a base URL can carry a credential in
 * its path, and request evidence must not. Equal settings give equal ids.
 */
export function configuredEndpointId(baseUrl: string): string {
  return createHash("sha256").update(baseUrl.trim()).digest("hex");
}
