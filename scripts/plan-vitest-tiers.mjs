// Select the opt-in Vitest tiers for one CI run. Unresolved inputs select every tier.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CENSUS_TIER_TESTS, NATIVE_TIER_TESTS } from "./lib/vitest-tiers.mjs";
import { readPlanFile } from "./run-ci-suite.mjs";

// Changes to these select every tier.
export const TIER_INFRASTRUCTURE = [
  ".github/scripts/check-windows-workflow.mjs",
  ".github/workflows/ci.yml",
  "config/vitest.analysis.config.ts",
  "package.json",
  "scripts/lib/vitest-collection.mjs",
  "scripts/lib/vitest-tiers.mjs",
  "scripts/plan-vitest-tiers.mjs",
  "scripts/plan-windows-tests.ts",
  "scripts/run-ci-suite.mjs",
  "scripts/run-windows-test-list.mjs",
  "vitest.config.ts",
];
export const CENSUS_TRIGGERS = [
  "src/__tests__/support/encoded-unicode-fixtures.ts",
  "src/permissions/__tests__/powershell-encoded-unicode",
  "src/permissions/rules/",
  "src/shared/shell-",
];
export const NATIVE_TRIGGERS = [
  "bun.lock",
  "native/",
  "patches/",
  "src/permissions/",
  "src/plugins/isolation/",
  "src/sandbox/",
  "tools/mxc-probes/",
];
// The rules planCiSuite prefixes to an affected plan's reason, per event; the pull request rule ends with the base ref.
export const SUITE_PLAN_RULES = Object.freeze({
  push: ["main push: trusted selection over before..HEAD"],
  pull_request: ["test-only category merge", "category merge: affected checks", "pull request into "],
});
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const SUITE_PLAN_RULE = Object.fromEntries(Object.entries(SUITE_PLAN_RULES).map(([event, rules]) => [event,
  new RegExp(`^(?:${rules.map(rule => rule.endsWith(" ") ? `${escapeRegExp(rule)}\\S+` : escapeRegExp(rule)).join("|")}); `, "u")]));
// The whole remainder must be the selectCiTests summary; any warning text before it is best-effort.
export const TRACED_AFFECTED_REASON = /^(?:test-only diff: affected tests on every base; |integration base: traced selection, strict fallback at the main boundary; )?\d+ changed module\(s\) reach \d+ test file\(s\); \d+ changed test file\(s\); \d+ test file\(s\) name a changed path; \d+ lock suite file\(s\); \d+ must-run file\(s\)$/u;

/** True only for a reason of the form "<known rule for the event>; <traced summary>". */
function tracedPlanReason(eventName, reason) {
  const rule = SUITE_PLAN_RULE[eventName]?.exec(reason);
  return rule !== null && rule !== undefined && TRACED_AFFECTED_REASON.test(reason.slice(rule[0].length));
}

// Paths naming the MXC, srt-win, sandbox or Windows native helper runtimes anywhere in the tree.
const NATIVE_TRIGGER_NAME = /mxc|srt-win|asrt|sandbox|windows-job|path-kind/iu;

const startsWithAny = (path, prefixes) => prefixes.some(prefix => path === prefix || path.startsWith(prefix));

/** The plan through the suite's own decoder, or null when it is not a plan. */
function decodePlan(plan) {
  try {
    return readPlanFile(JSON.stringify(plan));
  } catch {
    return null;
  }
}

/**
 * eventName and ref are the GitHub event; plan is the written CI suite plan; changedPaths is null when the diff is unresolved.
 * Pull requests select a tier from the diff and a fully traced affected plan. Main pushes always select the native tier and
 * select the census like a pull request. A full, empty or best-effort plan and every other event select all tiers.
 */
export function planVitestTiers({ eventName, ref, plan, changedPaths }) {
  const mainPush = eventName === "push" && ref === "refs/heads/main";
  const all = reason => ({ census: true, native: true, reason });
  if (eventName !== "pull_request" && !mainPush) return all(`${eventName} runs every tier`);
  if (!Array.isArray(changedPaths)) return all("the diff is unresolved");
  const decoded = decodePlan(plan);
  if (decoded === null) return all("the suite plan is unreadable");
  if (decoded.mode === "full") return all("the full plan runs every tier");
  if (decoded.tests.length === 0) return all("the affected plan selects no test");
  if (!tracedPlanReason(eventName, decoded.reason)) return all("the affected plan is best-effort");
  const infrastructure = changedPaths.find(path => TIER_INFRASTRUCTURE.includes(path));
  if (infrastructure) return all(`${infrastructure} defines the tiers`);
  const planned = tests => decoded.tests.find(test => tests.includes(test));
  const censusTrigger = changedPaths.find(path => startsWithAny(path, CENSUS_TRIGGERS));
  const censusTest = planned(CENSUS_TIER_TESTS);
  const nativeTrigger = changedPaths.find(path => startsWithAny(path, NATIVE_TRIGGERS) || NATIVE_TRIGGER_NAME.test(path) || NATIVE_TIER_TESTS.includes(path));
  const nativeTest = planned(NATIVE_TIER_TESTS);
  const census = censusTrigger ? `${censusTrigger} changes the shell rules` : censusTest ? `the plan selects ${censusTest}` : undefined;
  const native = mainPush ? "a main push runs the native tier"
    : nativeTrigger ? `${nativeTrigger} changes a native boundary` : nativeTest ? `the plan selects ${nativeTest}` : undefined;
  return {
    census: census !== undefined,
    native: native !== undefined,
    reason: `census: ${census ?? "no shell rule change"}; native: ${native ?? "no native boundary change"}`,
  };
}

/** The tiers the default Vitest shards, the tier job and the Windows tier shards run for one selection. */
export function vitestTierOutputs(eventName, ref, tiers) {
  const everyTier = eventName !== "pull_request" && !(eventName === "push" && ref === "refs/heads/main");
  // Coverage runs only on events that select every tier; the default shards keep the native tier there.
  const defaultTiers = everyTier ? "default,native" : "default";
  const tierJobNative = tiers.native && !everyTier;
  return {
    census_tier: String(tiers.census),
    native_tier: String(tiers.native),
    default_vitest_tiers: defaultTiers,
    tier_job_native: String(tierJobNative),
    vitest_tier_job: String(tiers.census || tierJobNative),
    windows_tiers: [tiers.native && "native", tiers.census && "census"].filter(Boolean).join(","),
  };
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout;
}

/** A pull request diffs its merge commit's first parent; a main push diffs its before commit. */
export function changedPathsFor(eventName, before, run = git) {
  try {
    let base;
    if (eventName === "pull_request") {
      const parents = run(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
      if (parents.length !== 2) return null;
      base = parents[0];
    } else {
      if (typeof before !== "string" || !/^[0-9a-f]{40}$/u.test(before) || /^0+$/u.test(before)) return null;
      run(["merge-base", "--is-ancestor", before, "HEAD"]);
      base = before;
    }
    return run(["diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"]).split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [planFile] = process.argv.slice(2);
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!planFile || !eventName) throw new Error("Usage: GITHUB_EVENT_NAME=<event> node scripts/plan-vitest-tiers.mjs <ci-plan.json>");
  let plan = null;
  try { plan = JSON.parse(readFileSync(planFile, "utf8")); } catch { /* An unreadable plan selects every tier. */ }
  const needsDiff = eventName === "pull_request" || (eventName === "push" && process.env.GITHUB_REF === "refs/heads/main");
  const tiers = planVitestTiers({
    eventName,
    ref: process.env.GITHUB_REF,
    plan,
    changedPaths: needsDiff ? changedPathsFor(eventName, process.env.AVE_CI_DIFF_BASE) : [],
  });
  const outputs = vitestTierOutputs(eventName, process.env.GITHUB_REF, tiers);
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  console.log(`[vitest-tiers] ${lines.join(" ")}: ${tiers.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Vitest tiers\n\n${lines.map(line => `- ${line}`).join("\n")}\n\n${tiers.reason}.\n`);
}
