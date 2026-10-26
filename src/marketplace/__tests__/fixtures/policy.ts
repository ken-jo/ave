import { EMPTY_MARKETPLACE_POLICY, type MarketplacePolicy, type PolicyLoad, type PolicySource, type PolicyUpdate } from "../../sources/policy.js";

export const FIXTURE_POLICY_PATH = "/fixture/ave-policy.json";

export function policyLoad(overrides: Partial<MarketplacePolicy> = {}): PolicyLoad {
  return { ok: true, policy: { ...EMPTY_MARKETPLACE_POLICY, ...overrides }, path: FIXTURE_POLICY_PATH };
}

/** Changes are reported by the next policy check. */
export class TestPolicySource implements PolicySource {
  private current: PolicyUpdate;
  private pending: PolicyLoad | null = null;
  private generation = 0;

  constructor(load: PolicyLoad = policyLoad()) {
    this.current = { load, digest: "fixture-0" };
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
    return { load: this.pending, digest: `fixture-${this.generation}` };
  }

  apply(update: PolicyUpdate): void {
    this.current = update;
    this.pending = null;
  }
}

export function policySource(load: PolicyLoad | Partial<MarketplacePolicy> = {}): TestPolicySource {
  return new TestPolicySource("ok" in load ? (load as PolicyLoad) : policyLoad(load as Partial<MarketplacePolicy>));
}
