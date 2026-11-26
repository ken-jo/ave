import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWindowsPlan, defaultWindowsSuites, tierWindowsSuites, WINDOWS_TEST_SHARDS, WINDOWS_TIER_TEST_SHARDS, type WindowsPlanTier, type WindowsTestPlan } from "./run-windows-test-list.mjs";
import { collectedVitestFiles } from "./lib/vitest-collection.mjs";

export const WINDOWS_TEST_TIMES = "config/windows-test-times.json";
// A suite without a timing sample still costs collection and startup.
const FALLBACK_MS = 1000;

interface WindowsTestTimes {
  unit: "ms";
  /** Per-file Windows durations with the default or native workload. */
  files: Record<string, number>;
  /** Windows durations for the same census files with their full workload. */
  census?: Record<string, number>;
  /** Mac full-run durations scaled to Windows, for suites with no Windows sample. */
  macEstimate: { scale: number; files: Record<string, number> };
}

type WindowsTestDuration = (file: string, fullCensus?: boolean) => number;

/** Timings only weight the shards: a missing suite falls back and a stale entry is ignored. */
export function windowsTestDurations(times: WindowsTestTimes): WindowsTestDuration {
  if (times?.unit !== "ms" || typeof times.files !== "object" || typeof times.macEstimate?.files !== "object") {
    throw new Error(`${WINDOWS_TEST_TIMES} must hold Windows and Mac-estimated millisecond timings`);
  }
  const census = times.census;
  return (file, fullCensus) => (fullCensus && census && Object.hasOwn(census, file) ? census[file]
    : Object.hasOwn(times.files, file) ? times.files[file]
    : Object.hasOwn(times.macEstimate.files, file) ? times.macEstimate.files[file] : undefined) ?? FALLBACK_MS;
}

function assignShards(ids: readonly number[], files: readonly string[], weight: (file: string) => number) {
  const shards = ids.map(id => ({ id, files: [] as string[], weightMs: 0 }));
  // Ties break by path, so the same checkout and timings give the same plan.
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const shard = shards.reduce((lightest, candidate) => candidate.weightMs < lightest.weightMs ? candidate : lightest);
    shard.files.push(file);
    shard.weightMs += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** Assign every default suite to one fixed shard and every selected tier suite to one tier shard, heaviest first onto the lightest. */
export function planWindowsTests(collected: readonly string[], duration: WindowsTestDuration = () => FALLBACK_MS, tiers: readonly WindowsPlanTier[] = []): WindowsTestPlan {
  // Per-file reports exclude collection and startup. Keep a per-file
  // floor so a shard cannot accumulate an unlimited number of tiny suites.
  const weight = (file: string, fullCensus?: boolean) => FALLBACK_MS + duration(file, fullCensus);
  const suites = defaultWindowsSuites(collected);
  const fullCensus = tiers.includes("census");
  const plan = {
    suites: suites.length,
    shards: assignShards(WINDOWS_TEST_SHARDS, suites, weight),
    tiers: [...tiers],
    tierShards: tiers.length === 0 ? [] : assignShards(WINDOWS_TIER_TEST_SHARDS, tierWindowsSuites(collected, tiers), file => weight(file, fullCensus)),
  };
  assertWindowsPlan(plan, collected);
  return plan;
}

/** AVE_WINDOWS_TEST_TIERS names the tiers the build job selected, comma-separated. */
export function windowsPlanTiers(value: string | undefined): WindowsPlanTier[] {
  if (value === undefined) throw new Error("AVE_WINDOWS_TEST_TIERS must name the selected tiers, or be empty");
  const tiers = value.split(",").map(tier => tier.trim()).filter(Boolean);
  for (const tier of tiers) if (tier !== "native" && tier !== "census") throw new Error(`Unknown Windows test tier: ${tier}`);
  return tiers as WindowsPlanTier[];
}

export function windowsPlanSummary(plan: WindowsTestPlan): string {
  return [
    "### Windows regression plan", "",
    `${plan.suites} default suites, each in exactly one shard.`, "",
    ...plan.shards.map(({ id, files, weightMs }) => `- Shard ${id}: ${files.length} files, ${(weightMs / 1000).toFixed(1)} weighted seconds`), "",
    `Tiers: ${plan.tiers.length === 0 ? "none selected" : plan.tiers.join(", ")}.`, "",
    ...plan.tierShards.map(({ id, files, weightMs }) => `- Tier shard ${id}: ${files.length} files, ${(weightMs / 1000).toFixed(1)} weighted seconds`), "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error("Expected a Windows plan output file");
  const root = resolve(import.meta.dirname, "..");
  const times = JSON.parse(readFileSync(resolve(root, WINDOWS_TEST_TIMES), "utf8")) as WindowsTestTimes;
  const plan = planWindowsTests(collectedVitestFiles(root), windowsTestDurations(times), windowsPlanTiers(process.env.AVE_WINDOWS_TEST_TIERS));
  const summary = windowsPlanSummary(plan);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
}
