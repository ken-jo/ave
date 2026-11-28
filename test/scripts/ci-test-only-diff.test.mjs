import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import * as ci from "../../scripts/run-ci-suite.mjs";

const planner = fileURLToPath(new URL("../../scripts/run-ci-suite.mjs", import.meta.url));
const suite = "src/core/__tests__/route.test.ts";
const scriptSuite = "test/scripts/route.test.mjs";
const mustRun = "src/core/__tests__/contract.test.ts";
const modified = path => ({ path, status: "M", oldMode: "100644", newMode: "100644" });
const deleted = path => ({ ...modified(path), status: "D", newMode: "000000" });
const testOnlyReason = "test-only diff: changed test files";
const selector = fileURLToPath(new URL("../../scripts/lib/ci-test-only-selection.mjs", import.meta.url));

function testOnlyPlan(files, tests) {
  return { mode: "affected", reason: testOnlyReason, tests, testOnlyFiles: files, testOnlyChanges: files.map(modified) };
}

it("selects only changed collected suites and Node script tests", () => {
  assert.deepEqual(ci.testOnlyFilesForDiff([modified(suite), modified(scriptSuite)]), [suite, scriptSuite]);
});

it("keeps mixed source, configuration and workflow diffs on the existing path", () => {
  for (const path of ["src/core/route.ts", "package.json", "bun.lock", ".github/workflows/ci.yml", "config/example.test.ts"]) {
    assert.equal(ci.testOnlyFilesForDiff([modified(suite), modified(path)]), null, path);
  }
});

it("keeps helpers, setup and fixtures on the existing path even if their names look like tests", () => {
  for (const path of [
    "src/core/__tests__/support/example.test.ts",
    "src/core/__tests__/helpers/example.ts",
    "src/core/__tests__/helpers/example.test.ts",
    "src/core/__tests__/fixtures/example.json",
    "src/permissions/__tests__/__fixtures__/example.test.ts",
    "test/renderer/fixtures/example.test.ts",
    "test/scripts/helpers/seed.test.mjs",
    "test/script-fixture/entry.test.mjs",
    "test/e2e/ui/approval-dialog.spec.ts",
    "src/core/renamed.test.ts",
    "test/setup.ts",
  ]) {
    assert.equal(ci.testOnlyFilesForDiff([modified(suite), modified(path)]), null, path);
  }
});

it("classifies deleted suites without scheduling them", () => {
  assert.deepEqual(ci.testOnlyFilesForDiff([deleted(suite), modified(scriptSuite)]), [scriptSuite]);
  assert.deepEqual(ci.testOnlyFilesForDiff([deleted(suite)]), []);
});

it("keeps unknown, empty and non-regular diffs on the existing path", () => {
  for (const diff of [undefined, null, [], [{ ...modified(suite), newMode: "120000" }]]) {
    assert.equal(ci.testOnlyFilesForDiff(diff), null);
  }
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ave-ci-diff-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const git = (...args) => execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  const file = (path, content) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "CI Test");
  git("config", "user.email", "ci@example.test");
  file(suite, "// original\n");
  file(mustRun, "// contract suite\n");
  file("package.json", "{}\n");
  file("config/ci-must-run-tests.json", JSON.stringify({ groups: { contract: [mustRun] } }));
  git("add", ".");
  git("commit", "-qm", "Base");
  const base = git("rev-parse", "HEAD");
  return { root, git, file, base };
}

function writePlan(root, event, before, baseRef = "main") {
  const planPath = join(root, "ci-plan.json");
  const output = join(root, "outputs");
  writeFileSync(output, "");
  const result = spawnSync(process.execPath, [planner, "--write-plan", planPath], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_NAME: event, GITHUB_REF: "refs/heads/main",
      GITHUB_BASE_REF: baseRef, GITHUB_HEAD_REF: "topic", AVE_CI_DIFF_BASE: before,
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "",
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return [readFileSync(planPath, "utf8"), readFileSync(output, "utf8")];
}

function merge({ git }) {
  git("add", ".");
  git("commit", "-qm", "Topic");
  git("switch", "-q", "main");
  git("merge", "--no-ff", "-qm", "Merge", "topic");
}

it("pins the existing mixed PR and main push plan bytes", (t) => {
  const repo = fixture(t);
  repo.git("switch", "-qc", "topic");
  repo.file(suite, "// modified\n");
  repo.file("package.json", '{"private":true}\n');
  merge(repo);
  const outputs = "shards=[1,2]\nshard_count=2\nplatform_checks=true\n";
  assert.deepEqual(writePlan(repo.root, "pull_request", repo.base), [
    '{"mode":"full","reason":"pull request into main; package.json is a global test or build input","tests":[]}\n', outputs,
  ]);
  assert.deepEqual(writePlan(repo.root, "push", repo.base), [
    '{"mode":"full","reason":"main push: trusted selection over before..HEAD; package.json is a global test or build input","tests":[]}\n', outputs,
  ]);
});

it("runs changed Linux suites and unconditional guards from the written plan", (t) => {
  const repo = fixture(t);
  repo.git("switch", "-qc", "topic");
  repo.file(suite, "// modified\n");
  repo.file(scriptSuite, "// new script suite\n");
  merge(repo);
  const [plan] = writePlan(repo.root, "pull_request", repo.base);
  assert.deepEqual(JSON.parse(plan).testOnlyFiles, [suite, scriptSuite]);
  assert.deepEqual(JSON.parse(plan).tests, [mustRun, suite]);
  assert.deepEqual(runLinuxPlan(repo), {
    args: ["run", "--silent=true", `./${mustRun}`, `./${suite}`],
    filter: "",
  });
  const [push] = writePlan(repo.root, "push", repo.base);
  assert.equal(Object.hasOwn(JSON.parse(push), "testOnlyFiles"), false);
});

for (const base of ["main", "integration/core"]) {
  it(`keeps an unresolved PR diff into ${base} on the full run with all platforms and tiers`, (t) => {
    const repo = fixture(t);
    const [plan, outputs] = writePlan(repo.root, "pull_request", repo.base, base);
    assert.deepEqual(JSON.parse(plan), {
      mode: "full", reason: "HEAD has 0 parent(s), not a pull request merge commit", tests: [],
    });
    assert.equal(outputs, "shards=[1,2]\nshard_count=2\nplatform_checks=true\n");
    const tierPlanner = fileURLToPath(new URL("../../scripts/plan-vitest-tiers.mjs", import.meta.url));
    const tiers = spawnSync(process.execPath, [tierPlanner, "ci-plan.json"], {
      cwd: repo.root, encoding: "utf8", env: {
        ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "",
      },
    });
    assert.ifError(tiers.error);
    assert.equal(tiers.status, 0, tiers.stderr);
    assert.match(tiers.stdout, /windows_tiers=native,census/u);
  });
}

it("keeps native, census and explicit platform inventories separate", async () => {
  const { testOnlyVitestArgs } = await import("../../scripts/lib/ci-test-only-selection.mjs");
  const native = "src/permissions/__tests__/mxc-macos-boundary.native.test.ts";
  const census = "src/permissions/__tests__/powershell-encoded-unicode/bash-head-first.test.ts";
  const selected = [suite, native, census, scriptSuite];
  const command = ["run", "--silent=true", mustRun, suite];
  assert.equal(testOnlyVitestArgs(command, null), command);
  assert.deepEqual(testOnlyVitestArgs(command, selected), ["run", "--silent=true", `./${suite}`]);
  assert.deepEqual(testOnlyVitestArgs(["run"], selected, "native"), ["run", `./${native}`]);
  assert.deepEqual(testOnlyVitestArgs(["run"], selected, "default,census"), ["run", `./${census}`]);
  assert.equal(testOnlyVitestArgs(command, [scriptSuite]), null);
});

it("runs the unconditional Linux guards when the only changed suite was deleted", (t) => {
  const repo = fixture(t);
  repo.git("switch", "-qc", "topic");
  repo.git("rm", suite);
  merge(repo);
  const [plan, outputs] = writePlan(repo.root, "pull_request", repo.base);
  assert.deepEqual(JSON.parse(plan).testOnlyFiles, []);
  assert.match(outputs, /^test_only=true$/mu);
  assert.deepEqual(runLinuxPlan(repo), { args: ["run", "--silent=true", `./${mustRun}`], filter: "" });
});

function runLinuxPlan(repo) {
  repo.file("scripts/run-vitest-under-electron.mjs",
    'console.log(JSON.stringify({ args: process.argv.slice(2), filter: process.env.AVE_CI_TEST_ONLY_PLAN ?? "" }));\n');
  const path = join(repo.root, "ci-plan.json");
  const result = spawnSync(process.execPath, [planner], {
    cwd: repo.root, encoding: "utf8", env: {
      ...process.env, GITHUB_EVENT_NAME: "pull_request", AVE_CI_PLAN_FILE: path,
      AVE_CI_TEST_ONLY_PLAN: path, AVE_CI_SHARD: "1/1",
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

it("preserves the shell boundary report check whenever a selected suite runs", async (t) => {
  const { parse } = await import("yaml");
  const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const step = workflow.jobs["linux-confinement-x64"].steps.find(entry => entry.name === "Run the Linux shell container boundary suite");
  const repo = fixture(t);
  const plan = join(repo.root, "selection.json");
  const boundary = "src/permissions/__tests__/mxc-linux-boundary.native.test.ts";
  repo.file(boundary, "// boundary suite\n");
  // The full run is whatever the step lists, so a suite added to the job is covered without editing this test.
  const fullList = [...step.run.match(/suites=\(\n([\s\S]*?)\n\s*\)/u)[1].matchAll(/\S+/gu)].map(match => match[0]);
  assert.ok(fullList.includes(boundary));
  const run = `bun() { shift 7; printf 'test: %s\\n' "$@"; }\njq() { echo 'checked report'; return 42; }\n${step.run.replace("scripts/lib/ci-test-only-selection.mjs", '"$SELECTOR"')}`;
  const cases = [[null, 42], [[suite], 0], [[boundary], 42]];
  for (const [selection, status] of cases) {
    if (selection) writeFileSync(plan, JSON.stringify(testOnlyPlan(selection, selection[0] === boundary ? [mustRun] : [mustRun, suite])));
    const result = spawnSync("bash", ["-e", "-c", run], {
      cwd: repo.root, encoding: "utf8", env: {
        ...process.env, AVE_CI_TEST_ONLY_PLAN: selection ? plan : "", RUNNER_TEMP: repo.root, SELECTOR: selector,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, result.stderr);
    if (status === 0) assert.match(result.stdout, /^::notice::test-only diff: 0 files for this job\n$/u);
    else {
      const tests = selection ? [boundary] : fullList;
      assert.equal(result.stdout, [...tests.map(path => `test: ${path}`), "checked report", ""].join("\n"));
    }
  }
});

it("lets an empty Windows shard succeed only after validating the full assignment", (t) => {
  const repo = fixture(t);
  const extra = Array.from({ length: 6 }, (_, index) => `src/core/__tests__/extra-${index}.test.ts`);
  for (const path of extra) repo.file(path, "// unrelated suite\n");
  repo.git("add", ".");
  const windowsPlan = join(repo.root, "windows.json");
  const selection = join(repo.root, "selection.json");
  const runner = fileURLToPath(new URL("../../scripts/run-windows-test-list.mjs", import.meta.url));
  writeFileSync(selection, JSON.stringify(testOnlyPlan([mustRun], [mustRun])));
  const run = (files) => {
    writeFileSync(windowsPlan, JSON.stringify({
      shards: files.map((path, index) => ({ id: index + 1, files: [path] })), tiers: [], tierShards: [],
    }));
    const result = spawnSync(process.execPath, [runner], {
      cwd: repo.root, encoding: "utf8", env: {
        ...process.env, AVE_WINDOWS_TEST_PLAN: windowsPlan, AVE_WINDOWS_TEST_SHARD: "1",
        AVE_WINDOWS_TEST_TIER: "default", AVE_CI_TEST_ONLY_PLAN: selection,
      },
    });
    assert.ifError(result.error);
    return result;
  };
  const empty = run([suite, mustRun, ...extra]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "::notice::test-only diff: 0 files for this job\n");
  const invalid = run([suite, mustRun, ...extra.slice(0, -1), suite]);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Windows plan assigns a suite twice/u);
});

for (const operation of ["rename", "copy"]) {
  it(`runs the full suite when a merged PR has a ${operation} of a collected test`, (t) => {
    const repo = fixture(t);
    repo.git("switch", "-qc", "topic");
    const destination = "src/core/__tests__/relocated.test.ts";
    if (operation === "rename") repo.git("mv", suite, destination);
    else repo.file(destination, readFileSync(join(repo.root, suite), "utf8"));
    merge(repo);
    const [plan] = writePlan(repo.root, "pull_request", repo.base);
    assert.equal(JSON.parse(plan).mode, "full", operation);
    assert.equal(Object.hasOwn(JSON.parse(plan), "testOnlyFiles"), false, operation);
  });
}

const scriptRunner = fileURLToPath(new URL("../../scripts/run-script-tests.mjs", import.meta.url));
const shardVerifier = fileURLToPath(new URL("../../scripts/verify-ci-shard-count.mjs", import.meta.url));
const tiersRunner = fileURLToPath(new URL("../../scripts/plan-vitest-tiers.mjs", import.meta.url));

for (const [label, command, contents] of [
  ["script runner with an empty artifact", scriptRunner, { testOnlyFiles: [] }],
  ["script runner with a nonexistent suite", scriptRunner, {
    mode: "affected", reason: testOnlyReason, tests: [mustRun],
    testOnlyFiles: [scriptSuite], testOnlyChanges: [modified(scriptSuite)],
  }],
  ["Linux shard with missing default tests", planner, {
    mode: "affected", reason: testOnlyReason, tests: [],
    testOnlyFiles: [suite], testOnlyChanges: [modified(suite)],
  }],
  ["tier planner with a dropped native selection", tiersRunner, {
    mode: "affected", reason: testOnlyReason, tests: [mustRun], testOnlyFiles: [],
    testOnlyChanges: [modified("src/permissions/__tests__/mxc-linux-boundary.native.test.ts")],
  }],
  ["shard verifier with a dropped guard", shardVerifier, {
    mode: "affected", reason: testOnlyReason, tests: [suite],
    testOnlyFiles: [suite], testOnlyChanges: [modified(suite)],
  }],
  ["shard verifier with an empty affected plan", shardVerifier, { mode: "affected", reason: "sample", tests: [] }],
  ["tier planner with an empty affected plan", tiersRunner, { mode: "affected", reason: "sample", tests: [] }],
]) {
  it(`rejects an inconsistent CI plan in the ${label}`, (t) => {
    const repo = fixture(t);
    repo.file("ci-plan.json", JSON.stringify(contents));
    const path = join(repo.root, "ci-plan.json");
    const result = spawnSync(process.execPath, [command, ...(command === tiersRunner ? [path] : [])], {
      cwd: repo.root, encoding: "utf8", env: {
        ...process.env, AVE_CI_PLAN_FILE: path, AVE_CI_TEST_ONLY_PLAN: path, GITHUB_EVENT_NAME: "pull_request",
        GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", PLATFORM_CHECKS: "true", VITEST_SHARD_COUNT: "1",
      },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /test-only CI plan|affected CI selection must not be empty/u);
  });
}
