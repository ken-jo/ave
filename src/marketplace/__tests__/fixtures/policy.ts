/** Test fixture: a readable managed policy with the given overrides on top of "no restrictions". */
import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad, type PolicySource, type PolicyUpdate } from "../../sources/policy.js";

/** Where the fixture policy says it was read from; policy messages name it. */
export const FIXTURE_POLICY_PATH = "/fixture/ave-policy.json";

export function policyLoad(overrides: Partial<MarketplacePolicy> = {}): PolicyLoad {
  return { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, ...overrides }, path: FIXTURE_POLICY_PATH };
}

/**
 * A {@link PolicySource} held in memory: `change` stands for the policy file
 * being rewritten, which the next `check` reports.
 */
export class TestPolicySource implements PolicySource {
  private current: PolicyUpdate;
  private pending: PolicyLoad | null = null;
  private generation = 0;

  constructor(load: PolicyLoad = policyLoad()) {
    this.current = { load, digest: "fixture-0", sequence: 0 };
  }

  get load(): PolicyLoad {
    return this.current.load;
  }

  get digest(): string {
    return this.current.digest;
  }

  change(load: PolicyLoad): void {
    this.pending = load;
  }

  async check(): Promise<PolicyUpdate | null> {
    if (this.pending === null) return null;
    this.generation += 1;
    return { load: this.pending, digest: `fixture-${this.generation}`, sequence: this.generation };
  }

  apply(update: PolicyUpdate): void {
    if (update.sequence < this.current.sequence) return;
    this.current = update;
    this.pending = null;
  }
}

/** A policy source under `load`, or a readable policy with these overrides. */
export function policySource(load: PolicyLoad | Partial<MarketplacePolicy> = {}): TestPolicySource {
  return new TestPolicySource("ok" in load ? (load as PolicyLoad) : policyLoad(load as Partial<MarketplacePolicy>));
}
