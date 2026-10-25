#!/usr/bin/env node
// The Vitest stage of CI (planned in ci.yml's build job, run by its vitest
// shards, reported by build-and-test): integration/*-base pull
// requests always run the best traced selection, never a whole-suite fallback.
// Other pull requests run affected tests only when selection is trusted.
//
// Coverage is periodic (owner 2026-10-24): instrumentation and the global
// thresholds (`bun run check:test-coverage`) run only on the nightly schedule
// and a manual dispatch, which are always full runs. Every other run executes
// without instrumentation, so a merge or push gate does not pay for it.
//
// Full:
//   - every event other than pull_request: a push to main, a release tag, the
//     nightly schedule and a manual dispatch;
//   - a category merge, a pull request from integration/* into main: the
//     multi-stage flow makes that merge the full-suite gate;
//   - a pull request to a non-integration base whose selection is not trusted.
//     The rule is the pre-push tier's, "uncertain -> full", and reuses its source policy
//     (scripts/hooks/pre-push-source-policy.mjs): a global test or build input
//     (package.json, bun.lock, tsconfig, the Vitest config and setup files,
//     config/, scripts/, .github/), a declaration or entry-point file, a
//     deleted or renamed module, a mode change, a message catalog change, a
//     changed module that loads code through a computed import, a changed
//     module no test reaches, a failed import-graph discovery, or a selection
//     larger than AFFECTED_TEST_LIMIT files.
//
// Affected (no coverage instrumentation, no coverage gate): always for an
// integration/* base, including global inputs, failed discovery and selections
// above the limit. Uncertainty is recorded in the reason; whole-suite checking
// waits for the category merge. Failed discovery keeps every other selection
// source, including the nonempty must-run set. Local pre-push is unchanged.
// An integration-base PR needs a resolved merge-commit diff: a missing merge
// commit or an unparseable diff fails CI before any selection can omit triggers.
// The selection is the changed test files, the tests `vitest related` reaches
// from each changed module (every
// transitive importer, not the pre-push tier's narrowed set), the tests that
// name a changed path in a string literal (they read it as text, which the
// import graph cannot see: module-size-boundaries.test.ts failed on such a
// change), the lock suites whose trigger paths changed, and the must-run set in
// config/ci-must-run-tests.json. Global coverage thresholds describe the
// whole suite; a change that lowers coverage turns the next nightly run on
// main red.
//
// The diff is the pull request's merge commit against its first parent, the
// base it was merged onto: exactly what the PR adds to its target.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseGitRawDiff } from "./hooks/pre-push-ref-updates.mjs";
import { isCanonicalGitPath } from "./hooks/pre-push-markdown-policy.mjs";
import {
  getRelatedCoverageFullReason,
  isCollectedVitestFile,
  selectFastSourceChecks,
  selectTriggeredLockSuites,
} from "./hooks/pre-push-source-policy.mjs";

export const MUST_RUN_TESTS_PATH = "config/ci-must-run-tests.json";

/**
 * Above this many changed and related test files the selection is most of the
 * suite, and a full run is worth its extra minutes on a non-integration base.
 */
export const AFFECTED_TEST_LIMIT = 600;

/**
 * A module that computes what it imports: `import(expression)`,
 * `require(expression)`, `import.meta.glob` or `require.context`. The import
 * graph cannot see what such a module loads, so a change to it keeps the full
 * suite on a non-integration base. A literal specifier, with or without a
 * bundler comment before it, is traced.
 */
const COMPUTED_IMPORT = /\bimport\.meta\.glob\b|\brequire\.context\b|\b(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(?!["'\s)/]|`[^`$]*`)/u;

export function loadsComputedImport(text) {
  return COMPUTED_IMPORT.test(text);
}

const REPO_PATH_LITERAL = /["'`]((?:src|test|scripts|config|resources|docs)\/[^"'`\s$]*)["'`]/gu;
const RELATIVE_PATH_LITERAL = /["'`](\.{1,2}\/[^"'`\s$]+)["'`]/gu;
// A top-level directory joined onto the repository root (`join(root, "src")`),
// the start of a tree scan: it names every path below it.
const ROOTED_DIRECTORY_LITERAL = /\b(?:resolve|join)\(\s*[\w.]*(?:root|ROOT|Root|cwd\(\)|__dirname|dirname)[^)]*?["'`](src|test|scripts|config|resources|docs)\/?["'`]/gu;
const MODULE_EXTENSION = /\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/u;

/**
 * The repository paths a test names in string literals: repository-rooted
 * ("src/plugins/runtime/index.ts", "src/ui/renderer/"), a top-level directory
 * joined onto the root (`join(root, "src")` names "src/"), and relative to the
 * test ("../fixtures/x.json"). A test that names a path reads it, scans it or
 * pins it; `vitest related` sees none of that unless the test also imports
 * it.
 */
export function namedRepositoryPaths(testPath, text) {
  const paths = new Set();
  for (const [, literal] of text.matchAll(REPO_PATH_LITERAL)) paths.add(literal);
  for (const [, directory] of text.matchAll(ROOTED_DIRECTORY_LITERAL)) paths.add(`${directory}/`);
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
 * A test that runs repository code outside the Vitest module graph: a child
 * process loaded through tsx (`--import tsx`, `tsx/esm`) or an esbuild bundle
 * (`entryPoints:`). Whatever that child or bundle imports is invisible to
 * `vitest related`, so every such test belongs to the must-run set
 * (test/scripts/run-ci-suite.test.ts holds the set to this, through
 * testRunsRepoCodeOutOfProcess).
 */
const OUT_OF_PROCESS_CODE = /["'`]--import["'`]\s*,\s*["'`]tsx["'`]|--import[= ]tsx\b|\btsx\/(?:esm|cjs)\b|require\.resolve\(\s*["'`]tsx["'`]|\bentryPoints\s*:/u;

export function runsRepoCodeOutOfProcess(text) {
  return OUT_OF_PROCESS_CODE.test(text);
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
const HELPER_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".mjs", ".js"];

/**
 * Whether a test runs repository code out of process itself or through a
 * test helper it imports: a non-test module under a `__tests__/` directory
 * (support code, fixtures), followed through the helpers it imports in turn.
 * src/__tests__/support/image-preparation-runtime.ts bundles a child with
 * esbuild for the tests that import it, which a scan of the test body alone
 * misses. Production modules are not followed: the import graph sees them.
 */
export function testRunsRepoCodeOutOfProcess(testPath, readText) {
  const seen = new Set();
  const pending = [testPath];
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readText(path);
    if (typeof text !== "string") continue;
    if (runsRepoCodeOutOfProcess(text)) return true;
    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (!target.includes("/__tests__/") || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(target)) continue;
      const base = target.replace(/\.[cm]?js$/u, "");
      for (const extension of HELPER_EXTENSIONS) {
        const candidate = `${extension === "" ? target : base}${extension}`;
        if (typeof readText(candidate) === "string") {
          pending.push(candidate);
          break;
        }
      }
    }
  }
  return false;
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
  if (selected.size === 0) throw new Error(`${MUST_RUN_TESTS_PATH} must select at least one collected test file`);
  return [...selected].sort();
}

/** The events whose run instruments coverage and enforces its thresholds. */
export const COVERAGE_EVENTS = Object.freeze(["schedule", "workflow_dispatch"]);

export function runsCoverage(eventName) {
  return COVERAGE_EVENTS.includes(eventName);
}

/** Parallel Vitest shards for a full run without coverage. ci.yml plans once,
 *  then runs one job per shard (`vitest --shard=<index>/<count>`); the shards
 *  together run exactly the planned files. An affected selection and a
 *  coverage run stay one job: coverage thresholds describe the whole suite,
 *  and a few affected files gain nothing from a second runner's setup. */
export const FULL_RUN_SHARDS = 4;

export function ciShardCount(plan, coverage) {
  return plan.mode === "full" && !coverage ? FULL_RUN_SHARDS : 1;
}

/** `<index>/<count>` from AVE_CI_SHARD, or null when the job runs the whole
 *  plan. Malformed values fail: a shard that silently ran everything, or
 *  nothing, would misreport what the aggregate check covered. */
export function parseCiShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`AVE_CI_SHARD must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(value)}`);
  }
  return Number(match[2]) === 1 ? null : `${match[1]}/${match[2]}`;
}

/** A plan written by `--write-plan`, read back by each shard so every shard
 *  splits the same file list. */
export function readPlanFile(text) {
  const plan = JSON.parse(text);
  const valid = plan !== null && typeof plan === "object"
    && (plan.mode === "full" || plan.mode === "affected")
    && typeof plan.reason === "string"
    && Array.isArray(plan.tests) && plan.tests.every((test) => typeof test === "string");
  if (!valid) throw new Error("the CI plan file is not a { mode, reason, tests } plan");
  return { mode: plan.mode, reason: plan.reason, tests: plan.tests };
}

function full(reason) {
  return { mode: "full", reason, tests: [] };
}

/** Keep traceable inputs even when the shared local policy refuses the change set. */
function integrationTraceInputs(changes, trackedTests) {
  const testFiles = new Set();
  const relatedFiles = new Set();
  for (const change of changes) {
    const single = selectFastSourceChecks([change]);
    for (const test of single.testFiles) testFiles.add(test);
    for (const source of single.relatedFiles) relatedFiles.add(source);
    const { path, status } = change;
    if (status === "D" || !isCanonicalGitPath(path)) continue;
    if (trackedTests.includes(path)) testFiles.add(path);
    else if (MODULE_EXTENSION.test(path)) relatedFiles.add(path);
  }
  return { testFiles: [...testFiles].sort(), relatedFiles: [...relatedFiles].sort() };
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
 * - baseRef: an integration/* base keeps the best traced selection on uncertainty
 */
export function selectCiTests({ changes, trackedTests, mustRunTests, readText, discoverRelated, baseRef }) {
  const integrationBase = typeof baseRef === "string" && baseRef.startsWith("integration/");
  const fullReasons = [];
  let fast = selectFastSourceChecks(changes);
  if (!fast.eligible) {
    if (!integrationBase) return full(fast.reason);
    fullReasons.push(fast.reason);
  }
  if (fast.messageCatalogEntries.length > 0) {
    const reason = `${fast.messageCatalogEntries[0].path} is message catalog data`;
    if (!integrationBase) return full(reason);
    fullReasons.push(reason);
  }
  if (integrationBase) fast = { ...fast, ...integrationTraceInputs(changes, trackedTests) };
  for (const path of fast.relatedFiles) {
    const text = readText(path);
    const reason = typeof text !== "string" ? `${path} could not be read`
      : loadsComputedImport(text) ? `${path} loads code through a computed import` : null;
    if (reason) {
      if (!integrationBase) return full(reason);
      fullReasons.push(reason);
    }
  }

  let related = [];
  if (fast.relatedFiles.length > 0) {
    const coverage = discoverRelated(fast.relatedFiles);
    const reason = coverage === null ? "related test discovery failed"
      : getRelatedCoverageFullReason(fast.relatedFiles, coverage);
    if (reason) {
      if (!integrationBase) return full(reason);
      fullReasons.push(reason);
    }
    related = Array.isArray(coverage) ? coverage.flatMap((record) => Array.isArray(record?.tests) ? record.tests : []) : [];
  }

  const changedPaths = changes.map(({ path }) => path);
  const textReaders = [];
  for (const test of trackedTests) {
    const text = readText(test);
    if (typeof text !== "string") {
      const reason = `${test} could not be read`;
      if (!integrationBase) return full(reason);
      fullReasons.push(reason);
      continue;
    }
    const named = namedRepositoryPaths(test, text);
    if (changedPaths.some((changed) => named.some((path) => namesChangedPath(path, changed)))) textReaders.push(test);
  }

  const traced = new Set([...fast.testFiles, ...related, ...textReaders]);
  if (traced.size > AFFECTED_TEST_LIMIT) {
    const reason = `${traced.size} changed and related test files exceed ${AFFECTED_TEST_LIMIT}`;
    if (!integrationBase) return full(reason);
    fullReasons.push(reason);
  }

  const lockSuites = selectTriggeredLockSuites(changes.map(({ path }) => path)).flatMap(({ suite }) => {
    const matches = trackedTests.filter((test) => test === suite || test.startsWith(`${suite}/`));
    if (matches.length === 0) throw new Error(`lock suite ${suite} selects no collected test file`);
    return matches;
  });

  let tests = [...new Set([...traced, ...lockSuites, ...mustRunTests])].sort();
  const missing = tests.filter((test) => !trackedTests.includes(test));
  if (missing.length > 0) {
    if (!integrationBase) return full(`${missing[0]} is not a collected test file of this tree`);
    fullReasons.push(...missing.map((test) => `${test} dropped: not a collected test file of this tree`));
    tests = tests.filter((test) => trackedTests.includes(test));
  }
  if (integrationBase && (mustRunTests.length === 0 || mustRunTests.some((test) => !tests.includes(test)))) {
    throw new Error("integration base requires a nonempty collected must-run set");
  }
  return {
    mode: "affected",
    reason:
      (integrationBase ? `${[...new Set(fullReasons)].join("; ")}${fullReasons.length ? "; " : ""}` +
        "integration base: traced selection, whole suite at the category merge; " : "") +
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

/**
 * A category branch (`integration/<category>`) reaches main through one pull
 * request, and the multi-stage flow makes that merge the full-suite gate (the
 * pre-push tier and the sub-branch PRs into the category ran scoped checks).
 */
export function isCategoryMergeToMain(headRef, baseRef) {
  return baseRef === "main" && typeof headRef === "string" && headRef.startsWith("integration/");
}

export function planCiSuite(eventName, { headRef, baseRef } = {}) {
  if (typeof eventName !== "string" || eventName.length === 0) {
    throw new Error("GITHUB_EVENT_NAME is unset: the CI suite needs the triggering event");
  }
  if (eventName !== "pull_request") return full(`${eventName} runs the full suite`);
  if (typeof headRef !== "string" || headRef.length === 0 || typeof baseRef !== "string" || baseRef.length === 0) {
    throw new Error("GITHUB_HEAD_REF and GITHUB_BASE_REF must be set for a pull_request run");
  }
  if (isCategoryMergeToMain(headRef, baseRef)) {
    return full(`${headRef} -> ${baseRef} is a category merge to main, which runs the full suite`);
  }
  const changes = pullRequestChanges();
  if (changes.reason) {
    if (baseRef.startsWith("integration/")) {
      throw new Error(`integration base requires a resolved pull request diff: ${changes.reason}`);
    }
    return full(changes.reason);
  }
  const trackedTests = trackedVitestFiles();
  const mustRunTests = expandMustRunTests(JSON.parse(readFileSync(MUST_RUN_TESTS_PATH, "utf8")), trackedTests);
  return selectCiTests({
    changes: changes.entries,
    baseRef,
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

function describeRun(plan, coverage) {
  if (plan.mode === "affected") return `${plan.tests.length} affected test files`;
  return coverage ? "full suite with coverage gate" : "full suite";
}

function writeSummary(plan, coverage) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [`### Vitest: ${describeRun(plan, coverage)}`, "", plan.reason];
  if (!coverage) lines.push("", "Coverage thresholds are enforced on the nightly and manually dispatched runs.");
  appendFileSync(summaryPath, `${lines.join("\n")}\n`);
}

/** The node arguments of the Vitest stage: the coverage gate, or a plain run of the plan's files (none: all). */
export function ciSuiteArguments(plan, coverage, shard = null) {
  if (coverage && shard !== null) throw new Error("a coverage run cannot be sharded: its thresholds describe the whole suite");
  if (coverage) return [join("scripts", "run-test-coverage-gate.mjs")];
  if (plan.mode === "affected" && plan.tests.length === 0) throw new Error("affected CI selection must not be empty");
  const tests = plan.mode === "full" ? [] : plan.tests.map((test) => `./${test}`);
  const split = shard === null ? [] : [`--shard=${shard}`];
  return [join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true", ...split, ...tests];
}

function runPlan(plan, coverage, shard) {
  return spawnSync(process.execPath, ciSuiteArguments(plan, coverage, shard), { stdio: "inherit" });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    // `--write-plan <file>` plans and stops: ci.yml's build job writes the
    // plan once and sizes the shard matrix from it. AVE_CI_PLAN_FILE runs a
    // written plan, so the shards never plan again.
    const writePlanAt = process.argv[2] === "--write-plan" ? process.argv[3] : undefined;
    if (process.argv[2] === "--write-plan" && !writePlanAt) throw new Error("--write-plan needs a file path");
    const planFile = process.env.AVE_CI_PLAN_FILE;
    const plan = planFile && !writePlanAt
      ? readPlanFile(readFileSync(planFile, "utf8"))
      : planCiSuite(process.env.GITHUB_EVENT_NAME, {
        headRef: process.env.GITHUB_HEAD_REF,
        baseRef: process.env.GITHUB_BASE_REF,
      });
    const eventName = process.env.GITHUB_EVENT_NAME;
    const coverage = runsCoverage(eventName);
    if (coverage && plan.mode !== "full") throw new Error(`${eventName} must plan a full run to enforce coverage`);
    if (writePlanAt) {
      writeFileSync(writePlanAt, `${JSON.stringify(plan)}\n`, "utf8");
      const shards = Array.from({ length: ciShardCount(plan, coverage) }, (_, index) => index + 1);
      console.log(`[ci-suite] planned ${describeRun(plan, coverage)} in ${shards.length} shard(s): ${plan.reason}`);
      writeSummary(plan, coverage);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `shards=${JSON.stringify(shards)}\n`);
      process.exit(0);
    }
    const shard = parseCiShard(process.env.AVE_CI_SHARD);
    console.log(`[ci-suite] ${describeRun(plan, coverage)}${shard ? `, shard ${shard}` : ""}: ${plan.reason}`);
    if (!planFile) writeSummary(plan, coverage);
    const result = runPlan(plan, coverage, shard);
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(`[ci-suite] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
