// Select the opt-in Vitest tiers for one CI run. Unresolved inputs select every tier.
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CENSUS_TIER_TESTS } from "./lib/vitest-tiers.mjs";

// Changes to these select every tier.
export const TIER_INFRASTRUCTURE = [
  ".github/workflows/ci.yml",
  "config/vitest.analysis.config.ts",
  "package.json",
  "scripts/lib/vitest-collection.mjs",
  "scripts/lib/vitest-tiers.mjs",
  "scripts/plan-vitest-tiers.mjs",
  "vitest.config.ts",
];
export const CENSUS_TRIGGERS = [
  "src/__tests__/support/encoded-unicode-fixtures.ts",
  "src/permissions/__tests__/powershell-encoded-unicode",
  "src/permissions/rules/",
  "src/shared/shell-",
];

const startsWithAny = (path, prefixes) => prefixes.some(prefix => path === prefix || path.startsWith(prefix));

/**
 * eventName and ref are the GitHub event; plan is the written CI suite plan; changedPaths is null when the diff is unresolved.
 * Pull requests and main pushes select a tier from the diff and the plan; every other event selects all tiers.
 */
export function planVitestTiers({ eventName, ref, plan, changedPaths }) {
  const mainPush = eventName === "push" && ref === "refs/heads/main";
  if (eventName !== "pull_request" && !mainPush) return { census: true, reason: `${eventName} runs every tier` };
  if (!Array.isArray(changedPaths)) return { census: true, reason: "the diff is unresolved" };
  if ((plan?.mode !== "full" && plan?.mode !== "affected") || !Array.isArray(plan.tests)) return { census: true, reason: "the suite plan is unreadable" };
  const infrastructure = changedPaths.find(path => TIER_INFRASTRUCTURE.includes(path));
  if (infrastructure) return { census: true, reason: `${infrastructure} defines the tiers` };
  const trigger = changedPaths.find(path => startsWithAny(path, CENSUS_TRIGGERS));
  const selected = plan.mode === "affected" ? plan.tests.find(test => CENSUS_TIER_TESTS.includes(test)) : undefined;
  if (trigger) return { census: true, reason: `${trigger} changes the shell rules` };
  if (selected) return { census: true, reason: `the plan selects ${selected}` };
  return { census: false, reason: "no shell rule change" };
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
  const outputs = { census_tier: String(tiers.census) };
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`);
  console.log(`[vitest-tiers] ${lines.join(" ")}: ${tiers.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Vitest tiers\n\nCensus: ${tiers.census ? "selected" : "not selected"} (${tiers.reason}).\n`);
}
