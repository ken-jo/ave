import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isCanonicalGitPath } from "../hooks/pre-push-markdown-policy.mjs";
import { isFullCheckGlobalInput } from "./global-test-inputs.mjs";
import { expandMustRunTests, MUST_RUN_TESTS_PATH } from "./ci-must-run-tests.mjs";
import { isCollectedScriptTest } from "./script-test-collection.mjs";
import { collectedVitestFiles, isCollectedVitestFile } from "./vitest-collection.mjs";
import { CENSUS_TIER_TESTS, NATIVE_TIER_TESTS } from "./vitest-tiers.mjs";

export const EMPTY_TEST_ONLY_NOTICE = "::notice::test-only diff: 0 files for this job";
export const TEST_ONLY_REASON = "test-only diff: changed test files";

const REGULAR_MODES = new Set(["100644", "100755"]);
const NON_SUITE_DIRECTORIES = new Set(["support", "helpers", "fixtures", "__fixtures__"]);

function isTestFile(path) {
  return isCanonicalGitPath(path) && /^[A-Za-z0-9._+@/-]+$/u.test(path)
    && !isFullCheckGlobalInput(path) && !path.split("/").slice(0, -1).some(part => NON_SUITE_DIRECTORIES.has(part))
    && (isCollectedVitestFile(path) || isCollectedScriptTest(path));
}

/** Null retains the current run. An empty selection is a verified deletion-only diff. */
export function testOnlyFilesForDiff(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return null;
  const seen = new Set();
  const files = [];
  for (const change of changes) {
    const { path, status, oldMode, newMode } = change ?? {};
    if (!isTestFile(path) || seen.has(path)) return null;
    seen.add(path);
    if (status === "D" && REGULAR_MODES.has(oldMode) && newMode === "000000") continue;
    if (!REGULAR_MODES.has(newMode)
      || !((status === "A" && oldMode === "000000") || (status === "M" && oldMode === newMode))) return null;
    files.push(path);
  }
  return files.sort();
}

export function testOnlyLinuxTests(files, guards) {
  const changed = files.filter(path => isCollectedVitestFile(path) && !NATIVE_TIER_TESTS.includes(path));
  return [...new Set([...changed, ...guards])].sort();
}

const sameFiles = (files, expected) => files.length === expected.length && files.every((file, index) => file === expected[index]);

export function testOnlyFilesFromPlan(plan, root) {
  if (plan?.testOnlyFiles === undefined && plan?.testOnlyChanges === undefined && plan?.reason !== TEST_ONLY_REASON) return null;
  const { mode, reason, tests, testOnlyFiles, testOnlyChanges } = plan;
  const expected = testOnlyFilesForDiff(testOnlyChanges);
  if (mode !== "affected" || reason !== TEST_ONLY_REASON
    || expected === null || !Array.isArray(testOnlyFiles) || !sameFiles(testOnlyFiles, expected)
    || !Array.isArray(tests) || tests.length === 0 || !tests.every(path => typeof path === "string" && isCollectedVitestFile(path))
    || testOnlyLinuxTests(expected, []).some(file => !tests.includes(file))) {
    throw new Error("Invalid test-only CI plan");
  }
  if (root !== undefined) {
    for (const { path, status } of testOnlyChanges) {
      const entry = lstatSync(join(root, path), { throwIfNoEntry: false });
      if (status === "D" ? entry !== undefined : !entry?.isFile()) {
        throw new Error(`Invalid test-only CI plan: checkout does not match ${path}`);
      }
    }
    const inventory = collectedVitestFiles(root);
    const document = JSON.parse(readFileSync(join(root, MUST_RUN_TESTS_PATH), "utf8"));
    const guards = expandMustRunTests(document, inventory, []);
    if (!sameFiles(tests, testOnlyLinuxTests(expected, guards))) {
      throw new Error("Invalid test-only CI plan: Linux suite inventory differs");
    }
  }
  return testOnlyFiles;
}

export function readTestOnlyFiles(planPath = process.env.AVE_CI_TEST_ONLY_PLAN) {
  if (!planPath) return null;
  const files = testOnlyFilesFromPlan(JSON.parse(readFileSync(planPath, "utf8")), process.cwd());
  if (files === null) throw new Error("The test-only CI plan has no selection");
  return files;
}

export function intersectTestOnlyFiles(inventory, selection) {
  if (selection === null) return inventory;
  const files = new Set(selection);
  return inventory.filter(path => files.has(path));
}

/** The tier and platform regression steps supply either a tier or explicit files. */
export function testOnlyVitestArgs(args, selection, tiers) {
  if (selection === null) return args;
  const [verb, ...options] = args;
  if (verb !== "run") throw new Error("Test-only selection requires a Vitest run");
  const flags = options.filter(arg => arg.startsWith("-"));
  const paths = options.filter(arg => !arg.startsWith("-"));
  const inventory = tiers === "native" ? NATIVE_TIER_TESTS
    : tiers === "default,census" ? CENSUS_TIER_TESTS : paths.map(path => path.replace(/^\.\//u, ""));
  const files = intersectTestOnlyFiles(inventory, selection);
  return files.length === 0 ? null : [verb, ...flags, ...files.map(file => `./${file}`)];
}

// The boundary step needs the selected arguments before requiring its test report.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  for (const path of intersectTestOnlyFiles(process.argv.slice(2), readTestOnlyFiles())) console.log(path);
}
