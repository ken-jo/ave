// Suites that spawn real processes, stamp ACLs or run the real OS sandbox. The native project collects them.
export const NATIVE_TIER_TESTS = [
  "src/main/memory-map/__tests__/inference-child-native.test.ts",
  "src/permissions/__tests__/asrt-background-initialization.test.ts",
  "src/permissions/__tests__/asrt-deny-absent-native.test.ts",
  "src/permissions/__tests__/asrt-deny-absent.test.ts",
  "src/permissions/__tests__/asrt-exit-release.test.ts",
  "src/permissions/__tests__/asrt-linux-runtime-probe.test.ts",
  "src/permissions/__tests__/asrt-mxc-egress.test.ts",
  "src/permissions/__tests__/asrt-protected-write-roots.test.ts",
  "src/permissions/__tests__/asrt-sandbox-mxc-proxy.test.ts",
  "src/permissions/__tests__/asrt-sandbox.test.ts",
  "src/permissions/__tests__/asrt-stamp-targets.test.ts",
  "src/permissions/__tests__/asrt-windows-grant-paths.test.ts",
  "src/permissions/__tests__/asrt-windows-initialization.test.ts",
  "src/permissions/__tests__/mxc-runtime-root-floor.test.ts",
  "src/permissions/__tests__/mxc-runtime-root.test.ts",
  "src/permissions/__tests__/srt-win-integrity.test.ts",
  "src/plugins/isolation/__tests__/confined-plugin-child.test.ts",
  "src/sandbox/__tests__/runtime-grant-native.test.ts",
  "src/shared/__tests__/ave-home-boundaries.windows.test.ts",
  "src/shared/__tests__/ave-home-configuration-read.windows.test.ts",
];

// The census partitions stay in the default project; their complete four-layer cases run only with the census tier.
export const CENSUS_TIER_TESTS = ["bash", "powershell"].flatMap(dialect => ["head", "middle", "tail"].flatMap(position =>
  ["first", "second"].map(half => `src/permissions/__tests__/powershell-encoded-unicode/${dialect}-${position}-${half}.test.ts`)));

const VITEST_TIERS = ["default", "native", "census"];
const UNSET_TIERS = ["default", "native"];

/** AVE_VITEST_TIERS as a set; unset selects the default and native projects without the census. */
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
