/** Test fixture: a readable managed policy with the given overrides on top of "no restrictions". */
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad } from "../../sources/policy.js";

/** Where the fixture policy says it was read from; policy messages name it. */
export const FIXTURE_POLICY_PATH = "/fixture/ave-policy.json";

export function policyLoad(overrides: Partial<MarketplacePolicy> = {}): PolicyLoad {
  return { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, ...overrides }, path: FIXTURE_POLICY_PATH };
}
