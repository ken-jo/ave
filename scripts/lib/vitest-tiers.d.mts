export type VitestTier = "default" | "census";
export const CENSUS_TIER_TESTS: readonly string[];
export const VITEST_TIERS: readonly VitestTier[];
export function selectedVitestTiers(value?: string): Set<VitestTier>;
export function vitestTierEnabled(tier: VitestTier, value?: string): boolean;
