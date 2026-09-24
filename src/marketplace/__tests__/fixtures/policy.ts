/** Test fixture: a readable managed policy with the given overrides on top of "no restrictions". */
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad } from "../../sources/policy.js";

export function policyLoad(overrides: Partial<MarketplacePolicy> = {}): PolicyLoad {
  return { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, ...overrides } };
}
