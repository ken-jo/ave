export const TIER_INFRASTRUCTURE: readonly string[];
export const CENSUS_TRIGGERS: readonly string[];
export const NATIVE_TRIGGERS: readonly string[];
export interface VitestTierSelection {
  census: boolean;
  native: boolean;
  reason: string;
}
export interface VitestTierOutputs {
  census_tier: string;
  native_tier: string;
  default_vitest_tiers: string;
  tier_job_native: string;
  vitest_tier_job: string;
  windows_tiers: string;
}
export function planVitestTiers(input: { eventName: string; ref: string | undefined; plan: unknown; changedPaths: readonly string[] | null }): VitestTierSelection;
export function vitestTierOutputs(eventName: string, ref: string | undefined, tiers: VitestTierSelection): VitestTierOutputs;
export function changedPathsFor(eventName: string, before: string | undefined, run?: (args: string[]) => string): string[] | null;
export const SUITE_PLAN_RULES: Readonly<{ push: readonly string[]; pull_request: readonly string[] }>;
export const TRACED_AFFECTED_REASON: RegExp;
