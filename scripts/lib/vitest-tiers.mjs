// The census partitions stay in the default project; their complete four-layer cases run only with the census tier.
export const CENSUS_TIER_TESTS = ["bash", "powershell"].flatMap(dialect => ["head", "middle", "tail"].flatMap(position =>
  ["first", "second"].map(half => `src/permissions/__tests__/powershell-encoded-unicode/${dialect}-${position}-${half}.test.ts`)));

export const VITEST_TIERS = ["default", "census"];
const UNSET_TIERS = ["default"];

/** AVE_VITEST_TIERS as a set; unset selects the default projects without the census. */
export function selectedVitestTiers(value = process.env.AVE_VITEST_TIERS) {
  if (value === undefined) return new Set(UNSET_TIERS);
  const tiers = value.split(",").map(tier => tier.trim()).filter(Boolean);
  if (tiers.length === 0) throw new Error("AVE_VITEST_TIERS must name at least one tier");
  for (const tier of tiers) {
    if (!VITEST_TIERS.includes(tier)) throw new Error(`AVE_VITEST_TIERS names an unknown tier: ${JSON.stringify(tier)}`);
  }
  return new Set(tiers);
}

export function vitestTierEnabled(tier, value) {
  return selectedVitestTiers(value).has(tier);
}
