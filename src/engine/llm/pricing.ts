// Resolve shared pricing from caller-supplied overrides so aggregation caches use the same inputs.
import { createHmac, randomBytes } from "node:crypto";
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
 * its path, and request evidence must not. The name is an HMAC under a key that exists
 * only in this process, so a captured value cannot be tested against candidate URLs and
 * means nothing to another process. Equal settings give equal names within one identifier.
 */
export function createConfiguredEndpointIdentifier(key: Uint8Array = randomBytes(32)): (baseUrl: string) => string {
  return (baseUrl) => createHmac("sha256", key).update(baseUrl.trim()).digest("hex");
}

/** This process's identifier: its key is generated at load, held in memory, and never written or logged. */
export const configuredEndpointId = createConfiguredEndpointIdentifier();
