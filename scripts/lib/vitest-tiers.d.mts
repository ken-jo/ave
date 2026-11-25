export type VitestTier = "default" | "native" | "census";
export const NATIVE_TIER_TESTS: readonly string[];
export const CENSUS_TIER_TESTS: readonly string[];
export function selectedVitestTiers(value?: string): Set<VitestTier>;
export function vitestTierEnabled(tier: VitestTier, value?: string): boolean;
