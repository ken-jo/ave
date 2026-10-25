#!/usr/bin/env node
// Plan test selection once; shards consume that exact file list.
// Test-only diffs stay affected-only; category merges and untrusted selections use the full suite.

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
  isTestHelperModule,
  isTestOnlyDiff,
  isTestSupportFile,
  selectFastSourceChecks,
  selectTriggeredLockSuites,
} from "./hooks/pre-push-source-policy.mjs";

export const MUST_RUN_TESTS_PATH = "config/ci-must-run-tests.json";

// Broad affected selections use the full suite on non-integration bases.
export const AFFECTED_TEST_LIMIT = 600;

// Computed imports escape the module graph and require full checks on non-integration bases.
const COMPUTED_IMPORT = /\bimport\.meta\.glob\b|\brequire\.context\b|\b(?:import|require)\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)*(?!["'\s)/]|`[^`$]*`)/u;

export function loadsComputedImport(text) {
  return COMPUTED_IMPORT.test(text);
}

const REPO_PATH_LITERAL = /["'`]((?:src|test|scripts|config|resources|docs)\/[^"'`\s$]*)["'`]/gu;
const RELATIVE_PATH_LITERAL = /["'`](\.{1,2}\/[^"'`\s$]+)["'`]/gu;
// Retain fixture-directory readers when split path joins hide the complete changed path.
const FIXTURE_DIRECTORY_LITERAL = /["'`](?:[^"'`$\r\n]*\/)?fixtures(?:\/[^"'`$\r\n]*)?["'`]/u;
// A root-level directory join names every path below that directory.
const ROOTED_DIRECTORY_LITERAL = /\b(?:resolve|join)\(\s*[\w.]*(?:root|ROOT|Root|cwd\(\)|__dirname|dirname)[^)]*?["'`](src|test|scripts|config|resources|docs)\/?["'`]/gu;
const MODULE_EXTENSION = /\.(?:tsx?|mts|cts|mjs|cjs|jsx?)$/u;

// Literal file reads and tree scans reach inputs outside the import graph.
export function namedRepositoryPaths(testPath, text) {
  const paths = new Set();
  for (const [, literal] of text.matchAll(REPO_PATH_LITERAL)) paths.add(literal);
  for (const [, directory] of text.matchAll(ROOTED_DIRECTORY_LITERAL)) paths.add(`${directory}/`);
  for (const [, literal] of text.matchAll(RELATIVE_PATH_LITERAL)) {
    paths.add(posix.normalize(posix.join(posix.dirname(testPath), literal)));
  }
  return [...paths];
}

export function namesChangedPath(named, changedPath) {
  if (named === changedPath) return true;
  if (named.replace(MODULE_EXTENSION, "") === changedPath.replace(MODULE_EXTENSION, "")) return true;
  const directory = named.endsWith("/") ? named : `${named}/`;
  return changedPath.startsWith(directory);
}

// Tests executing repository code in children or bundles belong in the must-run set.
const OUT_OF_PROCESS_CODE = /["'`]--import["'`]\s*,\s*["'`]tsx["'`]|--import[= ]tsx\b|\btsx\/(?:esm|cjs)\b|require\.resolve\(\s*["'`]tsx["'`]|\bentryPoints\s*:/u;

export function runsRepoCodeOutOfProcess(text) {
  return OUT_OF_PROCESS_CODE.test(text);
}

const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual)\s*(?:<[^>]*>)?\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
const HELPER_EXTENSIONS = ["", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"];

// Follow helper imports too: they can bundle or spawn code absent from the test body.
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

// Directory entries expand to collected tests; stale entries selecting nothing fail.
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

export const COVERAGE_EVENTS = Object.freeze(["schedule", "workflow_dispatch"]);

export function runsCoverage(eventName) {
  return COVERAGE_EVENTS.includes(eventName);
}

// Full runs without coverage may shard; affected and coverage runs stay in one job.
export const FULL_RUN_SHARDS = 4;

export function ciShardCount(plan, coverage) {
  return plan.mode === "full" && !coverage ? FULL_RUN_SHARDS : 1;
}

// Reject malformed shard values so the aggregate cannot misreport coverage.
export function parseCiShard(value) {
  if (value === undefined || value === "") return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) {
    throw new Error(`AVE_CI_SHARD must be <index>/<count> with 1 <= index <= count, got ${JSON.stringify(value)}`);
  }
  return Number(match[2]) === 1 ? null : `${match[1]}/${match[2]}`;
}

// Every shard consumes the same written plan rather than recomputing selection.
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

function traceableInputs(changes, trackedTests) {
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

// Follow helper readers and match paths before opening them to retain deleted or renamed targets.
function testNamesChangedPath(test, changedPaths, readText) {
  const fixtureChanged = changedPaths.some((path) => path.includes("/fixtures/"));
  const seen = new Set();
  const pending = [test];
  while (pending.length > 0) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readText(path);
    if (typeof text !== "string") continue;
    if (fixtureChanged && FIXTURE_DIRECTORY_LITERAL.test(text)) return true;
    const named = namedRepositoryPaths(path, text);
    if (changedPaths.some((changed) => named.some((name) => namesChangedPath(name, changed)))) return true;
    for (const name of named) {
      const base = name.replace(MODULE_EXTENSION, "");
      for (const candidate of [name, ...HELPER_EXTENSIONS.flatMap((ext) => [`${base}${ext}`, `${base}/index${ext}`])]) {
        if (isTestSupportFile(candidate) && typeof readText(candidate) === "string") {
          pending.push(candidate);
        }
      }
    }
  }
  return false;
}

// Related-test discovery returns null on failure, not an empty successful result.
// Integration bases retain the best traced selection when coverage is uncertain.
export function selectCiTests({ changes, trackedTests, mustRunTests, readText, discoverRelated, baseRef }) {
  const integrationBase = typeof baseRef === "string" && baseRef.startsWith("integration/");
  const testOnly = isTestOnlyDiff(changes);
  const scoped = integrationBase || testOnly;
  const fullReasons = [];
  let fast = selectFastSourceChecks(changes);
  if (!fast.eligible) {
    if (!scoped) return full(fast.reason);
    if (!testOnly) fullReasons.push(fast.reason);
  }
  // Helpers reach tests outside import and literal-reader graphs, so their changes are not test-only.
  const helper = changes.find(({ path }) => isTestHelperModule(path));
  if (helper) {
    const reason = `${helper.path} is a test helper or setup module, which runs the full suite`;
    if (!integrationBase) return full(reason);
    fullReasons.push(`${reason} at the category merge`);
  }
  if (fast.messageCatalogEntries.length > 0) {
    const reason = `${fast.messageCatalogEntries[0].path} is message catalog data`;
    if (!integrationBase) return full(reason);
    fullReasons.push(reason);
  }
  if (scoped) fast = { ...fast, ...traceableInputs(changes, trackedTests) };
  for (const path of fast.relatedFiles) {
    const text = readText(path);
    const reason = typeof text !== "string" ? `${path} could not be read`
      : loadsComputedImport(text) ? `${path} loads code through a computed import` : null;
    if (reason) {
      if (testOnly) throw new Error(`test-only selection cannot trace ${path}: ${reason}`);
      if (!scoped) return full(reason);
      fullReasons.push(reason);
    }
  }

  let related = [];
  if (fast.relatedFiles.length > 0) {
    const coverage = discoverRelated(fast.relatedFiles);
    const reason = coverage === null ? "related test discovery failed"
      // Unused helpers may have no importers; report records and returned paths must still validate.
      : getRelatedCoverageFullReason(testOnly ? [] : fast.relatedFiles, coverage, testOnly ? fast.relatedFiles : []);
    if (reason) {
      if (testOnly) throw new Error(`test-only selection cannot resolve importers: ${reason}`);
      if (!scoped) return full(reason);
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
      if (testOnly) throw new Error(`test-only selection cannot trace readers: ${reason}`);
      if (!scoped) return full(reason);
      fullReasons.push(reason);
      continue;
    }
    const namesChange = testOnly || helper
      ? testNamesChangedPath(test, changedPaths, readText)
      : changedPaths.some((changed) => namedRepositoryPaths(test, text).some((path) => namesChangedPath(path, changed)));
    if (namesChange) textReaders.push(test);
  }

  const traced = new Set([...fast.testFiles, ...related, ...textReaders]);
  if (traced.size > AFFECTED_TEST_LIMIT) {
    const reason = `${traced.size} changed and related test files exceed ${AFFECTED_TEST_LIMIT}`;
    if (!scoped) return full(reason);
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
    if (testOnly) throw new Error(`test-only selection names an uncollected test: ${missing[0]}`);
    if (!scoped) return full(`${missing[0]} is not a collected test file of this tree`);
    fullReasons.push(...missing.map((test) => `${test} dropped: not a collected test file of this tree`));
    tests = tests.filter((test) => trackedTests.includes(test));
  }
  if (scoped && (mustRunTests.length === 0 || mustRunTests.some((test) => !tests.includes(test)))) {
    throw new Error(`${testOnly ? "test-only diff" : "integration base"} requires a nonempty collected must-run set`);
  }
  const warnings = [...new Set(fullReasons)].map((reason) => `${reason}; `).join("");
  const selectionRule = testOnly ? "test-only diff: affected tests on every base; " : integrationBase
    ? "integration base: traced selection, whole suite at the category merge; " : "";
  return {
    mode: "affected",
    reason:
      warnings + selectionRule +
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

function rawDiff(base, what) {
  const entries = parseGitRawDiff(git(["diff", "--no-renames", "--raw", "-z", base, "HEAD", "--"]));
  return entries === null ? { reason: `${what} could not be parsed` } : { entries };
}

function pullRequestChanges() {
  const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").slice(1);
  if (parents.length !== 2) return { reason: `HEAD has ${parents.length} parent(s), not a pull request merge commit` };
  return rawDiff(parents[0], "the merge commit's diff");
}

const FULL_SHA = /^[0-9a-f]{40}$/u;

// Compare every delivered commit, not just the final parent, so earlier production changes cannot hide.
// Missing or non-ancestral before commits provide no trusted base.
function pushChanges(before) {
  if (typeof before !== "string" || !FULL_SHA.test(before)) return { reason: "the push has no before commit to diff against" };
  if (/^0+$/u.test(before)) return { reason: "the push created the branch (zero before commit)" };
  const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", before, "HEAD"], { encoding: "utf8" });
  if (ancestry.error || ancestry.status !== 0) {
    return { reason: `the push's before commit ${before} is not an ancestor of HEAD` };
  }
  return rawDiff(before, "the push's before..HEAD diff");
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

// Non-test-only category merges run the full suite after scoped sub-branch checks.
export function isCategoryMergeToMain(headRef, baseRef) {
  return baseRef === "main" && typeof headRef === "string" && headRef.startsWith("integration/");
}

export function planCiSuite(eventName, { headRef, baseRef, ref, before } = {}) {
  if (typeof eventName !== "string" || eventName.length === 0) {
    throw new Error("GITHUB_EVENT_NAME is unset: the CI suite needs the triggering event");
  }
  const mainPush = eventName === "push" && ref === "refs/heads/main";
  if (eventName !== "pull_request" && !mainPush) return full(`${eventName} runs the full suite`);
  if (!mainPush && (typeof headRef !== "string" || headRef.length === 0 || typeof baseRef !== "string" || baseRef.length === 0)) {
    throw new Error("GITHUB_HEAD_REF and GITHUB_BASE_REF must be set for a pull_request run");
  }
  let changes;
  try {
    changes = mainPush ? pushChanges(before) : pullRequestChanges();
  } catch (error) {
    changes = { reason: error instanceof Error ? error.message : String(error) };
  }
  if (changes.reason) {
    if (!mainPush && baseRef.startsWith("integration/")) {
      throw new Error(`integration base requires a resolved pull request diff: ${changes.reason}`);
    }
    return full(changes.reason);
  }
  if (!mainPush && isCategoryMergeToMain(headRef, baseRef) && !isTestOnlyDiff(changes.entries)) {
    return full(`${headRef} -> ${baseRef} is a non-test-only category merge to main, which runs the full suite`);
  }
  const trackedTests = trackedVitestFiles();
  const mustRunTests = expandMustRunTests(JSON.parse(readFileSync(MUST_RUN_TESTS_PATH, "utf8")), trackedTests);
  const textCache = new Map();
  const plan = selectCiTests({
    changes: changes.entries,
    baseRef: mainPush ? "main" : baseRef,
    trackedTests,
    mustRunTests,
    readText: (path) => {
      if (textCache.has(path)) return textCache.get(path);
      let text = null;
      try {
        text = readFileSync(path, "utf8");
      } catch { /* Deleted helpers have no current source to read. */ }
      textCache.set(path, text);
      return text;
    },
    discoverRelated: discoverRelatedTests,
  });
  const rule = mainPush ? "main push: trusted selection over before..HEAD" : isCategoryMergeToMain(headRef, baseRef)
    ? "test-only category merge" : `pull request into ${baseRef}`;
  return { ...plan, reason: `${rule}; ${plan.reason}` };
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
    // Write the plan once; shards read it without replanning.
    const writePlanAt = process.argv[2] === "--write-plan" ? process.argv[3] : undefined;
    if (process.argv[2] === "--write-plan" && !writePlanAt) throw new Error("--write-plan needs a file path");
    const planFile = process.env.AVE_CI_PLAN_FILE;
    const plan = planFile && !writePlanAt
      ? readPlanFile(readFileSync(planFile, "utf8"))
      : planCiSuite(process.env.GITHUB_EVENT_NAME, {
        headRef: process.env.GITHUB_HEAD_REF,
        baseRef: process.env.GITHUB_BASE_REF,
        ref: process.env.GITHUB_REF,
        before: process.env.AVE_CI_DIFF_BASE,
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
