#!/usr/bin/env node
// The Vitest stage of CI's build-and-test job: the full suite with its
// coverage gate, or, for a pull request whose change can be traced, only the
// affected tests.
//
// Full (`bun run check:test-coverage`, every global coverage threshold):
//   - every event other than pull_request: a push to main, a release tag, the
//     nightly schedule and a manual dispatch;
//   - a pull request whose selection is not trusted. The rule is the pre-push
//     tier's, "uncertain -> full", and reuses its source policy
//     (scripts/hooks/pre-push-source-policy.mjs): a global test or build input
//     (package.json, bun.lock, tsconfig, the Vitest config and setup files,
//     config/, scripts/, .github/), a declaration or entry-point file, a
//     deleted or renamed module, a mode change, a message catalog change, a
//     changed module that loads code through a computed import, a changed
//     module no test reaches, a failed import-graph discovery, or a selection
//     larger than AFFECTED_TEST_LIMIT files.
//
// Affected (no coverage instrumentation, no coverage gate): the changed test
// files, the tests `vitest related` reaches from each changed module (every
// transitive importer, not the pre-push tier's narrowed set), the tests that
// name a changed path in a string literal (they read it as text, which the
// import graph cannot see: module-size-boundaries.test.ts failed on such a
// change), the lock suites whose trigger paths changed, and the must-run set in
// config/ci-must-run-tests.json. Global coverage thresholds describe the
// whole suite, so they are enforced only on full runs; a pull request that
// lowers coverage turns the next push to main red, where the run fails the
// job and the branch's check.
//
// The diff is the pull request's merge commit against its first parent, the
// base it was merged onto: exactly what the PR adds to its target.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseGitRawDiff } from "./hooks/pre-push-ref-updates.mjs";
import {
  getRelatedCoverageFullReason,
  isCollectedVitestFile,
  selectFastSourceChecks,
  selectTriggeredLockSuites,
} from "./hooks/pre-push-source-policy.mjs";

export const MUST_RUN_TESTS_PATH = "config/ci-must-run-tests.json";

/**
 * Above this many changed and related test files the selection is most of the
 * suite, and a full run (with coverage) is worth its extra minutes.
 */
export const AFFECTED_TEST_LIMIT = 600;

/**
 * A module that computes what it imports: `import(expression)`,
 * `require(expression)`, `import.meta.glob` or `require.context`. The import
 * graph cannot see what such a module loads, so a change to it keeps the full
 * suite. A literal specifier, with or without a bundler comment before it, is
 * traced.
 */
const COMPUTED_IMPORT = /\bimport\.meta\.glob\b|\brequire\.context\b|\b(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(?!["'\s)/]|`[^`$]*`)/u;

export function loadsComputedImport(text) {
  return COMPUTED_IMPORT.test(text);
}

const REPO_PATH_LITERAL = /["'`]((?:src|test|scripts|config|resources|docs)\/[^"'`\s$]*)["'`]/gu;
const RELATIVE_PATH_LITERAL = /["'`](\.{1,2}\/[^"'`\s$]+)["'`]/gu;
const MODULE_EXTENSION = /\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/u;

/**
 * The repository paths a test names in string literals: repository-rooted
 * ("src/plugins/runtime/index.ts", "src/ui/renderer/") and relative to the
 * test ("../fixtures/x.json"). A test that names a path reads it, scans it or
 * pins it; `vitest related` sees none of that unless the test also imports
 * it.
 */
export function namedRepositoryPaths(testPath, text) {
  const paths = new Set();
  for (const [, literal] of text.matchAll(REPO_PATH_LITERAL)) paths.add(literal);
  for (const [, literal] of text.matchAll(RELATIVE_PATH_LITERAL)) {
    paths.add(posix.normalize(posix.join(posix.dirname(testPath), literal)));
  }
  return [...paths];
}

/** Whether a named path is the changed file, the same module, or a directory holding it. */
export function namesChangedPath(named, changedPath) {
  if (named === changedPath) return true;
  if (named.replace(MODULE_EXTENSION, "") === changedPath.replace(MODULE_EXTENSION, "")) return true;
  const directory = named.endsWith("/") ? named : `${named}/`;
  return changedPath.startsWith(directory);
}

/**
 * Expand the must-run document into the tracked test files it names. An entry
 * ending in "/" selects every collected test under that prefix; any other
 * entry is one collected test. An entry that selects nothing is a stale
 * document and is refused.
 */
export function expandMustRunTests(document, trackedTests) {
  const groups = document?.groups;
  if (!groups || typeof groups !== "object" || Array.isArray(groups)) {
    throw new Error(`${MUST_RUN_TESTS_PATH} must hold a "groups" object`);
  }
  const selected = new Set();
  for (const [group, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" must list at least one path`);
    }
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" holds a non-path entry`);
      }
      const matches = entry.endsWith("/")
        ? trackedTests.filter((test) => test.startsWith(entry))
        : trackedTests.filter((test) => test === entry);
      if (matches.length === 0) {
        throw new Error(`${MUST_RUN_TESTS_PATH} group "${group}" entry ${entry} selects no collected test file`);
      }
      for (const test of matches) selected.add(test);
    }
  }
  return [...selected].sort();
}

function full(reason) {
  return { mode: "full", reason, tests: [] };
}

/**
 * Decide the run for one change set.
 *
 * - changes: `git diff --raw` entries ({ status, oldMode, newMode, path })
 * - trackedTests: every collected Vitest file in the tree
 * - mustRunTests: the expanded must-run set
 * - readText(path): a changed module's source, or null
 * - discoverRelated(paths): per-module `vitest related` coverage,
 *   [{ source, tests }], or null when discovery failed
 */
export function selectCiTests({ changes, trackedTests, mustRunTests, readText, discoverRelated }) {
  const fast = selectFastSourceChecks(changes);
  if (!fast.eligible) return full(fast.reason);
  if (fast.messageCatalogEntries.length > 0) {
    return full(`${fast.messageCatalogEntries[0].path} is message catalog data`);
  }
  for (const path of fast.relatedFiles) {
    const text = readText(path);
    if (typeof text !== "string") return full(`${path} could not be read`);
    if (loadsComputedImport(text)) return full(`${path} loads code through a computed import`);
  }

  let related = [];
  if (fast.relatedFiles.length > 0) {
    const coverage = discoverRelated(fast.relatedFiles);
    if (coverage === null) return full("related test discovery failed");
    const reason = getRelatedCoverageFullReason(fast.relatedFiles, coverage);
    if (reason) return full(reason);
    related = coverage.flatMap((record) => record.tests);
  }

  const changedPaths = changes.map(({ path }) => path);
  const textReaders = [];
  for (const test of trackedTests) {
    const text = readText(test);
    if (typeof text !== "string") return full(`${test} could not be read`);
    const named = namedRepositoryPaths(test, text);
    if (changedPaths.some((changed) => named.some((path) => namesChangedPath(path, changed)))) textReaders.push(test);
  }

  const traced = new Set([...fast.testFiles, ...related, ...textReaders]);
  if (traced.size > AFFECTED_TEST_LIMIT) {
    return full(`${traced.size} changed and related test files exceed ${AFFECTED_TEST_LIMIT}`);
  }

  const lockSuites = selectTriggeredLockSuites(changes.map(({ path }) => path)).flatMap(({ suite }) => {
    const matches = trackedTests.filter((test) => test === suite || test.startsWith(`${suite}/`));
    if (matches.length === 0) throw new Error(`lock suite ${suite} selects no collected test file`);
    return matches;
  });

  const tests = [...new Set([...traced, ...lockSuites, ...mustRunTests])].sort();
  const missing = tests.filter((test) => !trackedTests.includes(test));
  if (missing.length > 0) return full(`${missing[0]} is not a collected test file of this tree`);
  return {
    mode: "affected",
    reason:
      `${fast.relatedFiles.length} changed module(s) reach ${related.length === 0 ? 0 : new Set(related).size} test file(s); ` +
      `${fast.testFiles.length} changed test file(s); ${textReaders.length} test file(s) name a changed path; ` +
      `${lockSuites.length} lock suite file(s); ` +
      `${mustRunTests.length} must-run file(s)`,
    tests,
  };
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

function trackedVitestFiles() {
  return git(["ls-files", "-z", "--", "src", "test"]).split("\0").filter((path) => path && isCollectedVitestFile(path)).sort();
}

/** The pull request's change set, or a reason it cannot be read. */
function pullRequestChanges() {
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
  if (parents.length !== 2) return { reason: `HEAD has ${parents.length} parent(s), not a pull request merge commit` };
  const entries = parseGitRawDiff(git(["diff", "--no-renames", "--raw", "-z", parents[0], "HEAD", "--"]));
  if (entries === null) return { reason: "the merge commit's diff could not be parsed" };
  return { entries };
}

function discoverRelatedTests(paths) {
  const result = spawnSync(process.execPath, [join("scripts", "hooks", "pre-push-related-tests.mjs"), ...paths], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function planCiSuite(eventName) {
  if (typeof eventName !== "string" || eventName.length === 0) {
    throw new Error("GITHUB_EVENT_NAME is unset: the CI suite needs the triggering event");
  }
  if (eventName !== "pull_request") return full(`${eventName} runs the full suite`);
  const changes = pullRequestChanges();
  if (changes.reason) return full(changes.reason);
  const trackedTests = trackedVitestFiles();
  const mustRunTests = expandMustRunTests(JSON.parse(readFileSync(MUST_RUN_TESTS_PATH, "utf8")), trackedTests);
  return selectCiTests({
    changes: changes.entries,
    trackedTests,
    mustRunTests,
    readText: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    discoverRelated: discoverRelatedTests,
  });
}

function writeSummary(plan) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    `### Vitest: ${plan.mode === "full" ? "full suite with coverage gate" : `${plan.tests.length} affected test files`}`,
    "",
    plan.reason,
  ];
  if (plan.mode === "affected") lines.push("", "Coverage thresholds are enforced on full runs (push to main, tags, nightly).");
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

function runPlan(plan) {
  if (plan.mode === "full") {
    return spawnSync(process.execPath, [join("scripts", "run-test-coverage-gate.mjs")], { stdio: "inherit" });
  }
  return spawnSync(
    process.execPath,
    [join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true", ...plan.tests.map((test) => `./${test}`)],
    { stdio: "inherit" },
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const plan = planCiSuite(process.env.GITHUB_EVENT_NAME);
    console.log(`[ci-suite] ${plan.mode}: ${plan.reason}`);
    if (plan.mode === "affected") console.log(`[ci-suite] ${plan.tests.length} test files; coverage gate runs on full runs only`);
    writeSummary(plan);
    const result = runPlan(plan);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`[ci-suite] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
