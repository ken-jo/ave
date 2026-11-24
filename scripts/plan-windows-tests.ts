import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertWindowsPlan, WINDOWS_TEST_SHARDS, type WindowsTestPlan } from "./run-windows-test-list.mjs";
import { collectedVitestFiles } from "./lib/vitest-collection.mjs";

export const WINDOWS_TEST_TIMES = "config/windows-test-times.json";
// A suite without a timing sample still costs collection and startup.
const FALLBACK_MS = 1000;

interface WindowsTestTimes {
  unit: "ms";
  /** Per-file Windows durations from a hosted run. */
  files: Record<string, number>;
  /** Mac full-run durations scaled to Windows, for suites with no Windows sample. */
  macEstimate: { scale: number; files: Record<string, number> };
}

/** Timings only weight the shards: a missing suite falls back and a stale entry is ignored. */
export function windowsTestDurations(times: WindowsTestTimes): (file: string) => number {
  if (times?.unit !== "ms" || typeof times.files !== "object" || typeof times.macEstimate?.files !== "object") {
    throw new Error(`${WINDOWS_TEST_TIMES} must hold Windows and Mac-estimated millisecond timings`);
  }
  return file => (Object.hasOwn(times.files, file) ? times.files[file]
    : Object.hasOwn(times.macEstimate.files, file) ? times.macEstimate.files[file] : undefined) ?? FALLBACK_MS;
}

/** Assign every collected suite to one fixed shard, heaviest first onto the lightest shard. */
export function planWindowsTests(collected: readonly string[], duration: (file: string) => number = () => FALLBACK_MS): WindowsTestPlan {
  // Per-file reports exclude collection and startup. Keep a per-file
  // floor so a shard cannot accumulate an unlimited number of tiny suites.
  const weight = (file: string) => FALLBACK_MS + duration(file);
  const shards = WINDOWS_TEST_SHARDS.map(id => ({ id, files: [] as string[], weightMs: 0 }));
  // Ties break by path, so the same checkout and timings give the same plan.
  for (const file of [...collected].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const shard = shards.reduce((lightest, candidate) => candidate.weightMs < lightest.weightMs ? candidate : lightest);
    shard.files.push(file);
    shard.weightMs += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  const plan = { suites: collected.length, shards };
  assertWindowsPlan(plan, collected);
  return plan;
}

export function windowsPlanSummary(plan: WindowsTestPlan): string {
  return [
    "### Windows regression plan", "",
    `${plan.suites} collected suites, each in exactly one shard.`, "",
    ...plan.shards.map(({ id, files, weightMs }) => `- Shard ${id}: ${files.length} files, ${(weightMs / 1000).toFixed(1)} weighted seconds`), "",
  ].join("\n");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [output] = process.argv.slice(2);
  if (!output) throw new Error("Expected a Windows plan output file");
  const root = resolve(import.meta.dirname, "..");
  const times = JSON.parse(readFileSync(resolve(root, WINDOWS_TEST_TIMES), "utf8")) as WindowsTestTimes;
  const plan = planWindowsTests(collectedVitestFiles(root), windowsTestDurations(times));
  const summary = windowsPlanSummary(plan);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`);
}
