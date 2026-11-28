import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { testOnlyFilesFromPlan } from "./lib/ci-test-only-selection.mjs";

const COVERAGE_EVENTS = Object.freeze(["schedule", "workflow_dispatch"]);

export function runsCoverage(eventName, plan) {
  const coverage = COVERAGE_EVENTS.includes(eventName);
  if (coverage && plan.mode !== "full") throw new Error(`${eventName} must plan a full run to enforce coverage`);
  return coverage;
}

export const FULL_RUN_SHARDS = 4;

export function ciShardCount(plan, coverage, nativeChecks = false) {
  if (plan.mode !== "full" || coverage) return 1;
  return nativeChecks ? 2 : FULL_RUN_SHARDS;
}

export function validateCiShardCount(plan, coverage, nativeChecks, reportedCount) {
  const expected = ciShardCount(plan, coverage, nativeChecks);
  if (reportedCount !== String(expected)) {
    throw new Error(`expected ${expected} Vitest shard(s) for the CI plan, got ${JSON.stringify(reportedCount)}`);
  }
}

// Every shard consumes the same written plan rather than recomputing selection.
export function readPlanFile(text, root) {
  const plan = JSON.parse(text);
  const valid = plan !== null && typeof plan === "object"
    && (plan.mode === "full" || plan.mode === "affected")
    && typeof plan.reason === "string"
    && Array.isArray(plan.tests) && plan.tests.every((test) => typeof test === "string");
  if (!valid) throw new Error("the CI plan file is not a { mode, reason, tests } plan");
  const testOnlyFiles = testOnlyFilesFromPlan(plan, root);
  const { mode, reason, tests, testOnlyChanges } = plan;
  if (mode === "affected" && tests.length === 0) throw new Error("affected CI selection must not be empty");
  return testOnlyFiles === null ? { mode, reason, tests } : { mode, reason, tests, testOnlyFiles, testOnlyChanges };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const planFile = process.env.AVE_CI_PLAN_FILE;
    if (!planFile) throw new Error("shard count verification requires AVE_CI_PLAN_FILE");
    const plan = readPlanFile(readFileSync(planFile, "utf8"), process.cwd());
    const coverage = runsCoverage(process.env.GITHUB_EVENT_NAME, plan);
    const platforms = process.env.PLATFORM_CHECKS;
    if (platforms !== "true" && platforms !== "false") throw new Error("native platform selection was not resolved");
    validateCiShardCount(plan, coverage, platforms === "true", process.env.VITEST_SHARD_COUNT);
  } catch (error) {
    console.error(`[ci-suite] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
