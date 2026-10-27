/** Integration-base CI always runs the best traced selection; other PR bases use the full suite when selection is untrusted (scripts/run-ci-suite.mjs). These cases pin the selection against
 * the real import graph of this tree: a leaf module selects its own tests, a shared module selects the tests of the modules that import it, and a global input falls back to the full suite. */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  AFFECTED_TEST_LIMIT,
  expandMustRunTests,
  loadsComputedImport,
  isCategoryMergeToMain,
  MUST_RUN_TESTS_PATH,
  namedRepositoryPaths,
  namesChangedPath,
  ciShardCount,
  ciSuiteArguments,
  FULL_RUN_SHARDS,
  parseCiShard,
  planCiSuite,
  readPlanFile,
  runsCoverage,
  runsRepoCodeOutOfProcess,
  selectCiTests,
  testRunsRepoCodeOutOfProcess,
} from "../../scripts/run-ci-suite.mjs";
import { parseGitRawDiff } from "../../scripts/hooks/pre-push-ref-updates.mjs";
import { isCollectedVitestFile } from "../../scripts/hooks/pre-push-source-policy.mjs";
import { modifiedEntry as modified } from "../../src/__tests__/support/git-diff-entry.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const root = resolve(import.meta.dirname, "../..");
const spawnSyncImplementation = vi.mocked(spawnSync).getMockImplementation()!;

function withGitOutputs(outputs: (string | { stdout: string; status: number })[], check: () => void) {
  const gitRun = vi.mocked(spawnSync);
  gitRun.mockClear();
  for (const output of outputs) {
    const { stdout, status } = typeof output === "string" ? { stdout: output, status: 0 } : output;
    gitRun.mockReturnValueOnce({ pid: 1, output: [], stdout, stderr: "", status, signal: null });
  }
  try {
    check();
    expect(gitRun).toHaveBeenCalledTimes(outputs.length);
  } finally {
    gitRun.mockReset().mockImplementation(spawnSyncImplementation);
  }
}

const trackedTests = spawnSync("git", ["ls-files", "-z", "--", "src", "test"], { cwd: root, encoding: "utf8" })
  .stdout.split("\0")
  .filter((path) => path && isCollectedVitestFile(path))
  .sort();
const mustRunDocument: unknown = JSON.parse(readFileSync(join(root, MUST_RUN_TESTS_PATH), "utf8"));
const mustRunTests = expandMustRunTests(mustRunDocument, trackedTests);

function readText(path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return null;
  }
}

/** The modules the real-graph cases change. Their `vitest related` coverage is discovered once, in one process, before the cases run: discovery
 * builds the whole suite's module graph, and on the 3-CPU CI slice one discovery per case took the file past two minutes (). The cases read the result. */
const GRAPH_SOURCES = [
  "src/core/route-engine.ts",
  "src/shared/escape-html.ts",
  "src/plugins/runtime/index.ts",
  "src/core/model-catalog/refresh.ts",
  "src/__tests__/support/git-diff-entry.ts",
];
let graphCoverage = new Map<string, string[]>();

beforeAll(async () => {
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts/hooks/pre-push-related-tests.mjs"), ...GRAPH_SOURCES], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`related-test discovery exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-2000)}`));
    });
  });
  const coverage = JSON.parse(stdout) as { source: string; tests: string[] }[];
  graphCoverage = new Map(coverage.map(({ source, tests }) => [source, tests]));
  expect([...graphCoverage.keys()].sort()).toEqual([...GRAPH_SOURCES].sort());
}, 300_000);

/** Discovery over this tree, as CI runs it, answered from the one discovery above. */
function discoverRelated(paths: string[]): { source: string; tests: string[] }[] | null {
  return paths.map((source) => {
    const tests = graphCoverage.get(source);
    if (tests === undefined) throw new Error(`${source} is not in GRAPH_SOURCES`);
    return { source, tests };
  });
}

function select(changes: ReturnType<typeof modified>[], discover = discoverRelated) {
  return selectCiTests({ changes, trackedTests, mustRunTests, readText, discoverRelated: discover });
}

describe("CI test selection over the real import graph", () => {
  it("selects a leaf module's own tests, plus the must-run set", () => {
    const plan = select([modified("src/core/route-engine.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain("src/core/__tests__/route-engine.test.ts");
    expect(plan.tests).toEqual(expect.arrayContaining(mustRunTests));
    // A leaf change does not drag in the rest of the suite.
    expect(plan.tests.length).toBeLessThan(trackedTests.length / 2);
  });

  it("selects the tests of a shared module's consumers, not only its direct importers", () => {
    const consumerTest = "src/main/__tests__/link-window-service.test.ts";
    // The consumer's test reaches escape-html only through link-window-service.
    expect(readText(consumerTest)).not.toContain("escape-html");
    expect(readText("src/main/link-window-service.ts")).toContain('from "../shared/escape-html.js"');

    const plan = select([modified("src/shared/escape-html.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain("src/shared/__tests__/escape-html.test.ts");
    expect(plan.tests).toContain(consumerTest);
  });

  it("selects a test that reads a changed module as text, which the import graph does not show", () => {
    // module-size-boundaries.test.ts reads each module it bounds with fs; on 2026-08-07 a guard block pushed src/plugins/runtime/index.ts past its ceiling and only that test failed.
    const reader = "src/__tests__/module-size-boundaries.test.ts";
    expect(readText(reader)).toContain('"src/plugins/runtime/index.ts"');
    expect(graphCoverage.get("src/plugins/runtime/index.ts")).not.toContain(reader);

    const plan = select([modified("src/plugins/runtime/index.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain(reader);
  });

  it("selects a test whose spawned fixture is the only importer of a changed module", () => {
    // The independent review's repro for cache-concurrency spawns fixtures/refresh-process.ts under
    // tsx, and only that fixture imports refresh.ts, so the import graph does not reach the test.
    const spawner = "src/core/model-catalog/__tests__/cache-concurrency.test.ts";
    expect(graphCoverage.get("src/core/model-catalog/refresh.ts")).not.toContain(spawner);
    const plan = select([modified("src/core/model-catalog/refresh.ts")]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain(spawner);
  });

  it("runs the full suite for a real test helper on main, and traces its importers on an integration base", () => {
    const helper = "src/__tests__/support/git-diff-entry.ts";
    expect(select([modified(helper)])).toEqual({
      mode: "full",
      reason: `${helper} is a test helper or setup module, which runs the full suite`,
      tests: [],
    });
    const plan = selectCiTests({
      changes: [modified(helper)], trackedTests, mustRunTests, readText, discoverRelated, baseRef: "integration/ci",
    });
    expect(plan.mode).toBe("affected");
    expect(plan.reason).toContain(`${helper} is a test helper or setup module, which runs the full suite at the category merge`);
    expect(plan.reason).not.toContain("test-only diff");
    expect(plan.tests).toContain("test/scripts/pre-push-source-policy.test.ts");
    expect(plan.tests).toEqual(expect.arrayContaining(mustRunTests));
  });

  it("selects a real fixture reader that joins its directory and relative fixture path", () => {
    const plan = select([modified("test/scripts/fixtures/linux-appimage-payload.squashfs")], () => {
      throw new Error("a fixture asset has no module import discovery");
    });
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toContain("test/scripts/linux-package-arch.test.ts");
  });

  it.each([
    "vitest.config.ts",
    "config/vitest.analysis.config.ts",
    MUST_RUN_TESTS_PATH,
    "package.json",
    "bun.lock",
    "tsconfig.json",
    ".github/workflows/ci.yml",
    "scripts/run-ci-suite.mjs",
    "src/__tests__/vitest-ave-home.ts",
    "src/i18n/testing/vitest-ambient-intl.ts",
    "src/preload.ts",
  ])("falls back to the full suite when %s changes", (path) => {
    const plan = select([modified("src/core/route-engine.ts"), modified(path)], () => {
      throw new Error("a global input must be decided before any discovery");
    });
    expect(plan).toEqual({ mode: "full", reason: `${path} is a global test or build input`, tests: [] });
  });
});

describe("CI test selection fallbacks", () => {
  const noDiscovery = () => {
    throw new Error("discovery must not run for this change");
  };

  it("runs the full suite for message catalog data", () => {
    expect(select([modified("src/i18n/messages/generated/chat.ts")], noDiscovery))
      .toMatchObject({ mode: "full", reason: "src/i18n/messages/generated/chat.ts is message catalog data" });
  });

  it("runs the full suite when a changed module computes what it imports", () => {
    expect(select([modified("src/plugins/runtime/plugin-loader.ts")], noDiscovery))
      .toMatchObject({ mode: "full", reason: "src/plugins/runtime/plugin-loader.ts loads code through a computed import" });
  });

  it("runs the full suite for a deleted or renamed module", () => {
    expect(select([{ status: "D", oldMode: "100644", newMode: "000000", path: "src/core/route-engine.ts" }], noDiscovery).mode)
      .toBe("full");
  });

  it("runs the full suite when discovery fails or a module has no test", () => {
    expect(select([modified("src/core/route-engine.ts")], () => null))
      .toMatchObject({ mode: "full", reason: "related test discovery failed" });
    expect(select([modified("src/core/route-engine.ts")], (paths) => paths.map((source) => ({ source, tests: [] }))))
      .toMatchObject({ mode: "full", reason: "src/core/route-engine.ts has no related test files" });
  });

  it("runs the full suite when the selection is most of the suite", () => {
    const wide = trackedTests.slice(0, AFFECTED_TEST_LIMIT + 1);
    expect(select([modified("src/core/route-engine.ts")], (paths) => paths.map((source) => ({ source, tests: wide }))))
      .toMatchObject({ mode: "full", reason: expect.stringMatching(new RegExp(`^\\d+ changed and related test files exceed ${AFFECTED_TEST_LIMIT}$`)) });
  });

  it("runs a changed test file directly, with the lock suites its path triggers", () => {
    const plan = select([modified("src/ipc/__tests__/gated.test.ts"), modified("src/ui/renderer/types.ts")],
      (paths) => paths.map((source) => ({ source, tests: ["src/__tests__/preload.test.ts"] })));
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual(expect.arrayContaining([
      "src/ipc/__tests__/gated.test.ts",
      "src/__tests__/preload.test.ts",
      "src/__tests__/preload-shape.test.ts",
    ]));
  });

  it("runs full for tags, schedule and dispatch, and refuses a missing event", () => {
    for (const [event, ref] of [["push", "refs/tags/v1.0.0"], ["schedule", "refs/heads/main"], ["workflow_dispatch", "refs/heads/main"]]) {
      expect(planCiSuite(event, { ref })).toEqual({ mode: "full", reason: `${event} runs the full suite`, tests: [] });
    }
    expect(() => planCiSuite(undefined)).toThrow("GITHUB_EVENT_NAME is unset");
  });

  it("instruments coverage only on the nightly schedule and a manual dispatch", () => {
    expect(runsCoverage("schedule")).toBe(true);
    expect(runsCoverage("workflow_dispatch")).toBe(true);
    for (const event of ["push", "pull_request", undefined]) expect(runsCoverage(event)).toBe(false);
  });

  it("runs the coverage gate only when instrumenting, and the whole suite on a plain full run", () => {
    const fullPlan = { mode: "full" as const, reason: "push runs the full suite", tests: [] };
    const affected = { mode: "affected" as const, reason: "traced", tests: ["src/a.test.ts"] };
    expect(ciSuiteArguments(fullPlan, true)).toEqual([join("scripts", "run-test-coverage-gate.mjs")]);
    expect(ciSuiteArguments(fullPlan, false)).toEqual([join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true"]);
    expect(ciSuiteArguments(affected, false)).toEqual([join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true", "./src/a.test.ts"]);
  });

  it("shards only a full run without coverage, and passes the shard to Vitest", () => {
    const fullPlan = { mode: "full" as const, reason: "push runs the full suite", tests: [] };
    const affected = { mode: "affected" as const, reason: "traced", tests: ["src/a.test.ts"] };
    expect(FULL_RUN_SHARDS).toBeGreaterThan(1);
    expect(ciShardCount(fullPlan, false)).toBe(FULL_RUN_SHARDS);
    expect(ciShardCount(fullPlan, true)).toBe(1);
    expect(ciShardCount(affected, false)).toBe(1);
    expect(ciSuiteArguments(fullPlan, false, "2/4")).toEqual([
      join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true", "--shard=2/4",
    ]);
    expect(ciSuiteArguments(affected, false, "1/2")).toEqual([
      join("scripts", "run-vitest-under-electron.mjs"), "run", "--silent=true", "--shard=1/2", "./src/a.test.ts",
    ]);
    expect(() => ciSuiteArguments(fullPlan, true, "1/4")).toThrow("a coverage run cannot be sharded");
  });

  it("reads a shard and a written plan strictly", () => {
    expect(parseCiShard(undefined)).toBeNull();
    expect(parseCiShard("")).toBeNull();
    expect(parseCiShard("1/1")).toBeNull();
    expect(parseCiShard("3/4")).toBe("3/4");
    for (const bad of ["0/4", "5/4", "1/0", "1", "a/b", "1/4 "]) {
      expect(() => parseCiShard(bad), bad).toThrow("AVE_CI_SHARD must be <index>/<count>");
    }
    const plan = { mode: "affected", reason: "traced", tests: ["src/a.test.ts"] };
    expect(readPlanFile(JSON.stringify({ ...plan, extra: true }))).toEqual(plan);
    for (const bad of [{ ...plan, mode: "some" }, { ...plan, tests: [1] }, { mode: "full", tests: [] }, null]) {
      expect(() => readPlanFile(JSON.stringify(bad))).toThrow("the CI plan file is not a { mode, reason, tests } plan");
    }
  });

  it.each(["src/core/route-engine.ts", "src/__tests__/vitest-ave-home.ts"])("runs full for a non-test-only category merge: %s", (path) => {
    withGitOutputs(["head first second\n", `:100644 100644 aaaa bbbb M\0${path}\0`], () => {
      expect(planCiSuite("pull_request", { headRef: "integration/permissions", baseRef: "main" })).toEqual({
        mode: "full",
        reason: "integration/permissions -> main is a non-test-only category merge to main, which runs the full suite",
        tests: [],
      });
    });
  });

  it("recognizes category refs and refuses a pull request without them", () => {
    expect(isCategoryMergeToMain("integration/permissions", "main")).toBe(true);
    // A sub-branch into its category, and an ordinary branch into main, are selected.
    expect(isCategoryMergeToMain("fix/one-thing", "integration/permissions")).toBe(false);
    expect(isCategoryMergeToMain("fix/one-thing", "main")).toBe(false);
    expect(() => planCiSuite("pull_request", {})).toThrow("GITHUB_HEAD_REF and GITHUB_BASE_REF must be set");
  });
});

describe("event rules over the pull request merge and the whole push", () => {
  const changedTest = "src/core/__tests__/route-engine.test.ts";
  const before = "b".repeat(40);
  const mainPush = { ref: "refs/heads/main", before };
  const isAncestor = { stdout: "", status: 0 };

  it("selects a test-only category merge over the merge commit's first parent", () => {
    withGitOutputs(["head first second\n", `:100644 100644 aaaa bbbb M\0${changedTest}\0`, trackedTests.join("\0")], () => {
      const plan = planCiSuite("pull_request", { headRef: "integration/test-speed", baseRef: "main" });
      expect(plan.mode).toBe("affected");
      expect(plan.reason).toContain("test-only category merge");
      expect(plan.reason).toContain("test-only diff");
      expect(plan.tests).toEqual(expect.arrayContaining([changedTest, ...mustRunTests]));
      expect(vi.mocked(spawnSync).mock.calls[1][1]).toEqual(["diff", "--no-renames", "--raw", "-z", "first", "HEAD", "--"]);
    });
  });

  it("selects a test-only main push over before..HEAD", () => {
    withGitOutputs([isAncestor, `:100644 100644 aaaa bbbb M\0${changedTest}\0`, trackedTests.join("\0")], () => {
      const plan = planCiSuite("push", mainPush);
      expect(plan.mode).toBe("affected");
      expect(plan.reason).toContain("main push: trusted selection over before..HEAD");
      expect(plan.reason).toContain("test-only diff");
      expect(plan.tests).toEqual(expect.arrayContaining([changedTest, ...mustRunTests]));
      const calls = vi.mocked(spawnSync).mock.calls;
      expect(calls[0][1]).toEqual(["merge-base", "--is-ancestor", before, "HEAD"]);
      expect(calls[1][1]).toEqual(["diff", "--no-renames", "--raw", "-z", before, "HEAD", "--"]);
    });
  });

  it("classifies a multi-commit push as a whole: an earlier source commit makes a test-only tip non-test-only", () => {
    // Commit 1 changes src/tools/agent-guide.ts, commit 2 only a test. HEAD's first parent alone would read as test-only; before..HEAD carries both.
    const source = "src/tools/agent-guide.ts";
    const guideTest = "src/tools/__tests__/workflow-tools.test.ts";
    expect(trackedTests).toContain(guideTest);
    const coverage = [{ source, tests: [guideTest] }];
    const diff = `:100644 100644 aaaa bbbb M\0${source}\0:100644 100644 cccc dddd M\0${changedTest}\0`;
    withGitOutputs([isAncestor, diff, trackedTests.join("\0"), JSON.stringify(coverage)], () => {
      const plan = planCiSuite("push", mainPush);
      expect(plan.mode).toBe("affected");
      expect(plan.reason).not.toContain("test-only diff");
      expect(plan.tests).toEqual(expect.arrayContaining([guideTest, changedTest]));
    });
  });

  it("uses trusted selection for a code push to main", () => {
    const source = "src/core/route-engine.ts";
    const coverage = [{ source, tests: [changedTest] }];
    withGitOutputs([isAncestor, `:100644 100644 aaaa bbbb M\0${source}\0`, trackedTests.join("\0"), JSON.stringify(coverage)], () => {
      const plan = planCiSuite("push", mainPush);
      expect(plan.mode).toBe("affected");
      expect(plan.reason).toContain("main push: trusted selection over before..HEAD");
      expect(plan.reason).not.toContain("test-only diff");
      expect(plan.tests).toEqual(expect.arrayContaining([changedTest, ...mustRunTests]));
    });
  });

  it("falls back to full for an untrusted main push", () => {
    withGitOutputs([isAncestor, ":100644 100644 aaaa bbbb M\0vitest.config.ts\0", trackedTests.join("\0")], () => {
      expect(planCiSuite("push", mainPush)).toMatchObject({
        mode: "full", reason: expect.stringContaining("vitest.config.ts is a global test or build input"),
      });
    });
  });

  it.each([
    { name: "missing", value: undefined, reason: "no before commit" },
    { name: "malformed", value: "HEAD~1", reason: "no before commit" },
    { name: "zero", value: "0".repeat(40), reason: "zero before commit" },
  ])("runs full for a main push whose before commit is $name, without reading git", ({ value, reason }) => {
    withGitOutputs([], () => {
      expect(planCiSuite("push", { ref: "refs/heads/main", before: value })).toMatchObject({
        mode: "full", reason: expect.stringContaining(reason), tests: [],
      });
    });
  });

  it("plans over the same base ci.yml's documentation classifier diffs from", () => {
    const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
    const build = workflow.split("\n  build:\n")[1]!.split(/\n  [a-z][a-z0-9-]+:\n/)[0]!;
    const classifierBase = /BASE_SHA: (\$\{\{ [^}]+ \}\})\n/u.exec(build.slice(build.indexOf("id: docs-impact")))?.[1];
    const plan = build.slice(build.indexOf("name: Plan the suite"));
    expect(classifierBase).toBe("${{ github.event.pull_request.base.sha || github.event.before }}");
    expect(plan.split(/^      - /m)[0]).toContain(`AVE_CI_DIFF_BASE: ${classifierBase}`);
    expect(readFileSync(join(root, "scripts/run-ci-suite.mjs"), "utf8")).toContain("before: process.env.AVE_CI_DIFF_BASE");
  });

  it("runs full for a force push whose before commit is not an ancestor of HEAD", () => {
    withGitOutputs([{ stdout: "", status: 1 }], () => {
      expect(planCiSuite("push", mainPush)).toEqual({
        mode: "full", reason: `the push's before commit ${before} is not an ancestor of HEAD`, tests: [],
      });
    });
  });
});

describe("test-only support tracing", () => {
  const test = "src/a/__tests__/consumer.test.ts";
  const helper = "src/a/__tests__/support/helper.ts";
  const fixture = "test/fixtures/case/data.json";
  const mustRun = "test/must-run.test.ts";
  const files: Record<string, string> = {
    [test]: 'import "./support/helper.js";',
    [helper]: 'import "./deep.js";',
    "src/a/__tests__/support/deep.ts": `readFileSync("${fixture}");`,
    [mustRun]: "export {};",
  };
  function supportPlan(changes: ReturnType<typeof modified>[], current = files, baseRef?: string) {
    return selectCiTests({
      changes, trackedTests: [test, mustRun], mustRunTests: [mustRun],
      readText: (path) => current[path] ?? null,
      discoverRelated: (paths) => paths.map((source) => ({ source, tests: [] })),
      baseRef,
    });
  }

  it("follows fixture readers transitively through helpers even without module imports", () => {
    expect(supportPlan([modified(fixture)]).tests).toEqual([test, mustRun].sort());
  });

  it("retains transitive helper readers that join fixture directory segments", () => {
    const current = { ...files, "src/a/__tests__/support/deep.ts":
      'const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures"); readFileSync(join(root, name));' };
    expect(supportPlan([modified("src/a/__tests__/fixtures/data.json")], current).tests)
      .toEqual([test, mustRun].sort());
  });

  it.each([
    "src/a/__tests__/support/helper.ts", "src/a/__tests__/fixtures/builder.ts", "test/support/setup-helper.ts",
    "src/a/__mocks__/client.ts", "vitest.config.ts", "src/__tests__/vitest-ave-home.ts",
    "scripts/run-ci-suite.mjs", "scripts/hooks/pre-push-source-policy.mjs", "config/ci-must-run-tests.json",
  ])("never treats %s as test-only: it runs the full suite off integration bases", (path) => {
    expect(supportPlan([modified(path)]).mode).toBe("full");
    expect(supportPlan([modified(test), modified(path)]).mode).toBe("full");
  });

  it("retains importers of a renamed helper through surviving helper chains on an integration base", () => {
    const renamed = "src/a/__tests__/support/renamed.ts";
    const oldPath = "src/a/__tests__/support/deep.ts";
    const { [oldPath]: oldHelper, ...current } = files;
    const changes = [
      { ...modified(oldPath), status: "D", newMode: "000000" },
      { ...modified(renamed), status: "A", oldMode: "000000" },
    ];
    expect(supportPlan(changes, { ...current, [renamed]: oldHelper }).mode).toBe("full");
    expect(supportPlan(changes, { ...current, [renamed]: oldHelper }, "integration/ci").tests)
      .toEqual([test, mustRun].sort());
  });

  it("fails closed on test-only discovery failure instead of omitting importers or running full", () => {
    const untracked = "src/a/__tests__/untracked.test.ts";
    expect(() => selectCiTests({
      changes: [modified(untracked)], trackedTests: [test, mustRun], mustRunTests: [mustRun],
      readText: (path) => (path === untracked ? "export {};" : files[path] ?? null), discoverRelated: () => null,
    })).toThrow("test-only selection cannot resolve importers: related test discovery failed");
  });

  it("drops deleted tests while retaining the must-run set", () => {
    const plan = supportPlan([{ ...modified("test/gone.test.ts"), status: "D", newMode: "000000" }]);
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([mustRun]);
  });

  it("does not promote a wide test-only diff to full", () => {
    const wide = Array.from({ length: AFFECTED_TEST_LIMIT + 1 }, (_, index) => `test/changed-${index}.test.ts`);
    const plan = selectCiTests({
      changes: wide.map(modified), trackedTests: [...wide, mustRun], mustRunTests: [mustRun],
      readText: () => "export {};", discoverRelated: () => null,
    });
    expect(plan.mode).toBe("affected");
    expect(plan.tests).toEqual([...wide, mustRun].sort());
  });
});

describe("CI selection for integration bases", () => {
  const changed = "test/changed.test.ts";
  const reader = "test/reader.test.ts";
  const related = "test/related.test.ts";
  const mustRun = "test/must-run.test.ts";
  const scriptLock = "test/scripts/lock.test.ts";
  const preloadLocks = [
    "src/__tests__/preload.test.ts", "src/__tests__/preload-shape.test.ts",
    "src/ui/renderer/__tests__/settings-section-anchors.test.ts",
  ];
  const wide = Array.from({ length: AFFECTED_TEST_LIMIT + 1 }, (_, index) => `test/wide-${index}.test.ts`);
  const collected = [changed, reader, related, mustRun, scriptLock, ...preloadLocks, ...wide];

  function scoped(path: string, discovery: "normal" | "unreached" | "failed" | "malformed" | "uncollected" | "wide", baseRef = "integration/test-speed") {
    return selectCiTests({
      baseRef,
      changes: [modified(path), modified(changed), modified("src/ui/renderer/types.ts")],
      trackedTests: collected,
      mustRunTests: [mustRun],
      readText: (file) => file === reader ? `readFileSync("${path}")` : "export {};",
      discoverRelated: (paths) => discovery === "failed" ? null : discovery === "malformed" ? JSON.parse("{}") : paths.map((source) => ({
        source,
        tests: discovery === "unreached" && source === path ? [] : discovery === "wide" ? wide
          : discovery === "uncollected" ? [related, "test/gone.test.ts"] : [related],
      })),
    });
  }

  it.each([
    {
      name: "a global input",
      path: "scripts/foo.mjs",
      discovery: "normal" as const,
      fullReason: "scripts/foo.mjs is a global test or build input",
      relatedCount: 1,
      locks: [scriptLock, ...preloadLocks],
    },
    {
      name: "a message catalog",
      path: "src/i18n/messages/generated/chat.ts",
      discovery: "normal" as const,
      fullReason: "src/i18n/messages/generated/chat.ts is message catalog data",
      relatedCount: 1,
      locks: preloadLocks,
    },
    {
      name: "a module no test reaches",
      path: "src/isolated.ts",
      discovery: "unreached" as const,
      fullReason: "src/isolated.ts has no related test files",
      relatedCount: 1,
      locks: preloadLocks,
    },
    {
      name: "failed discovery",
      path: "src/feature.ts",
      discovery: "failed" as const,
      fullReason: "related test discovery failed",
      relatedCount: 0,
      locks: preloadLocks,
    },
    {
      name: "malformed discovery",
      path: "src/feature.ts",
      discovery: "malformed" as const,
      fullReason: "related test coverage could not be resolved",
      relatedCount: 0,
      locks: preloadLocks,
    },
    {
      name: "an uncollected related test",
      path: "src/feature.ts",
      discovery: "uncollected" as const,
      fullReason: "test/gone.test.ts dropped: not a collected test file of this tree",
      relatedCount: 2,
      locks: preloadLocks,
    },
    {
      name: "more than the limit",
      path: "src/wide.ts",
      discovery: "wide" as const,
      fullReason: `${AFFECTED_TEST_LIMIT + 3} changed and related test files exceed ${AFFECTED_TEST_LIMIT}`,
      relatedCount: wide.length,
      locks: preloadLocks,
    },
  ])("keeps the exact traced composition for $name", ({ path, discovery, fullReason, relatedCount, locks }) => {
    const relatedTests = discovery === "failed" || discovery === "malformed" ? [] : discovery === "wide" ? wide : [related];
    expect(scoped(path, discovery)).toEqual({
      mode: "affected",
      tests: [...new Set([changed, reader, ...relatedTests, ...locks, mustRun])].sort(),
      reason: `${fullReason}; integration base: traced selection, whole suite at the category merge; ` +
        `2 changed module(s) reach ${relatedCount} test file(s); 1 changed test file(s); ` +
        `1 test file(s) name a changed path; ${locks.length} lock suite file(s); 1 must-run file(s)`,
    });
  });

  it("keeps the full fallback for a non-integration PR into main", () => {
    expect(scoped("scripts/foo.mjs", "normal", "main")).toEqual({
      mode: "full", reason: "scripts/foo.mjs is a global test or build input", tests: [],
    });
  });

  it("requires a nonempty must-run set even when discovery fails", () => {
    expect(() => selectCiTests({
      baseRef: "integration/test-speed", changes: [modified("src/feature.ts")],
      trackedTests: collected, mustRunTests: [], readText: () => "", discoverRelated: () => null,
    })).toThrow("integration base requires a nonempty collected must-run set");
    expect(() => expandMustRunTests({ groups: {} }, collected)).toThrow("must select at least one collected test file");
    expect(() => ciSuiteArguments({ mode: "affected", reason: "empty", tests: [] }, false))
      .toThrow("affected CI selection must not be empty");
  });
});

describe("unresolved pull request diffs", () => {
  const cases = [
    {
      name: "a HEAD that is not a merge commit",
      outputs: ["head parent\n"],
      reason: "HEAD has 1 parent(s), not a pull request merge commit",
    },
    {
      name: "an unparseable merge diff",
      outputs: ["head parent other\n", "not a raw diff\0"],
      reason: "the merge commit's diff could not be parsed",
    },
  ];

  it.each(cases)("fails clearly for $name on an integration base before selecting tests", ({ outputs, reason }) => {
    withGitOutputs(outputs, () => {
      expect(() => planCiSuite("pull_request", { headRef: "ci/change", baseRef: "integration/test-speed" }))
        .toThrow(`integration base requires a resolved pull request diff: ${reason}`);
    });
  });

  it.each(cases)("keeps the full fallback for $name on a main base", ({ outputs, reason }) => {
    withGitOutputs(outputs, () => {
      expect(planCiSuite("pull_request", { headRef: "ci/change", baseRef: "main" }))
        .toEqual({ mode: "full", reason, tests: [] });
    });
  });
});

describe("the must-run set", () => {
  it("names security, permissions, sandbox, contract, IPC and naming tests that all exist", () => {
    expect(Object.keys((mustRunDocument as { groups: object }).groups).sort())
      .toEqual(["contract", "ipc", "naming", "out-of-process", "permissions", "sandbox", "security", "tree-invariants"]);
    expect(mustRunTests).toContain("src/permissions/__tests__/runner-decisions.test.ts");
    expect(mustRunTests).toContain("src/ipc/__tests__/channel-inventory.test.ts");
    expect(mustRunTests).toContain("src/plugins/__tests__/tool-name-policy.test.ts");
  });

  // A test that reads the repository's tracked tree through git: `ls-files` or `ls-tree` as a quoted argument, `grep` as the first argument of a git helper call (`git(["grep", ...])`,
  // `spawnSync("git", ["grep", ...])`), or a `git grep` / `git ls-files` / `git ls-tree` command string. Root-anchored readdirSync/globSync walkers need no entry: text-reader tracing selects them.
  const TREE_READER = [
    /["'`]ls-(?:files|tree)["'`]/u,
    /\bgit\w*\(\s*\[\s*["'`]grep["'`]/u,
    /["'`]git["'`]\s*,\s*\[\s*["'`]grep["'`]/u,
    /["'`]git\s+(?:grep|ls-files|ls-tree)\b/u,
  ];
  const readsTrackedTree = (text: string) => TREE_READER.some((pattern) => pattern.test(text));
  // Matches that read no tree of this repository. Each must still match, so a stale entry fails instead of hiding a real scanner later.
  const NOT_TREE_SCANNERS: Record<string, string> = {
    "src/marketplace/git/__tests__/repo.test.ts": "runs ls-tree on the temporary bare repository it creates",
    "src/permissions/__tests__/risk-classifier.test.ts": "`git grep` is a shell command it classifies, never runs",
    "src/shared/__tests__/shell-recursive-traversal.test.ts": "`git grep` is an argv it classifies as walking, never runs",
  };

  it.each([
    ['spawnSync("git", ["ls-files", "-z"])', true],
    ['hostGit(["ls-tree", "-r", "--name-only", "HEAD"])', true],
    ['git(["grep", "-l", "pattern"])', true],
    ['spawnSync("git", ["grep", "-n", "x"])', true],
    ['execSync("git grep -l needle")', true],
    ['execSync(`git ls-tree -r HEAD`)', true],
    ['expect(argv).toEqual(["grep", "a b c", "file"])', false],
    ['tokenizeShell("ls | grep foo")', false],
    ['expect(text).toContain("start with `grep` before editing")', false],
  ])("detects a tracked-tree reader: %s -> %s", (text, expected) => {
    expect(readsTrackedTree(text as string)).toBe(expected);
  });

  it("holds every test that scans the tracked tree, so a test-only diff runs those invariants", () => {
    // A test-only pull request that adds a tsx-child test without listing it above breaks this file's
    // out-of-process invariant without touching this file; the must-run set is the one place that makes such suites run.
    const matches = trackedTests.filter((test) => readsTrackedTree(readText(test) ?? ""));
    for (const path of Object.keys(NOT_TREE_SCANNERS)) expect(matches, path).toContain(path);
    const treeScanners = matches.filter((test) => !(test in NOT_TREE_SCANNERS));
    expect(treeScanners).toEqual(expect.arrayContaining([
      "test/scripts/run-ci-suite.test.ts", "test/scripts/pre-push-tier.test.ts",
      "test/scripts/repository-identity.test.ts", "test/scripts/pre-push-markdown-policy.test.ts",
    ]));
    expect(mustRunTests).toEqual(expect.arrayContaining(treeScanners));
    const added = "src/core/__tests__/route-engine.test.ts";
    const plan = select([{ ...modified(added), status: "A", oldMode: "000000" }]);
    expect(plan.reason).toContain("test-only diff");
    expect(plan.tests).toEqual(expect.arrayContaining(treeScanners));
  });

  it("holds every test that runs repository code in a tsx child or an esbuild bundle", () => {
    // What such a child or bundle imports never enters the Vitest module graph: changing src/core/model-catalog/refresh.ts,
    // which only cache-concurrency's spawned fixture imports, selected 238 files without that test before this group existed.
    const outOfProcess = trackedTests.filter((test) => testRunsRepoCodeOutOfProcess(test, readText));
    expect(outOfProcess).toContain("src/core/model-catalog/__tests__/cache-concurrency.test.ts");
    expect(outOfProcess).toContain("src/tools/__tests__/archive-entry-reader-bundle.test.ts");
    // These two bundle the image-preparation child only through src/__tests__/support/image-preparation-runtime.ts.
    expect(outOfProcess).toContain("src/tools/__tests__/file-tools.test.ts");
    expect(outOfProcess).toContain("src/main/__tests__/codex-conversation-runtime.test.ts");
    expect(outOfProcess.filter((test) => !mustRunTests.includes(test))).toEqual([]);
  });

  it("follows a test's helper imports, but not its production imports", () => {
    const loader = ["t", "sx"].join("");
    const files: Record<string, string> = {
      "src/a/__tests__/uses-helper.test.ts": 'import { run } from "./support/runner.js";',
      "src/a/__tests__/support/runner.ts": 'import { spawnIt } from "../../../__tests__/support/deep.js";',
      "src/__tests__/support/deep.ts": `spawn(node, ["--import", "${loader}", child]);`,
      "src/a/__tests__/uses-module.test.ts": 'import { spawnIt } from "../spawner.js";',
      "src/a/spawner.ts": `spawn(node, ["--import", "${loader}", child]);`,
    };
    const read = (path: string) => files[path] ?? null;
    expect(testRunsRepoCodeOutOfProcess("src/a/__tests__/uses-helper.test.ts", read)).toBe(true);
    expect(testRunsRepoCodeOutOfProcess("src/a/__tests__/uses-module.test.ts", read)).toBe(false);
  });

  it("recognizes the tsx and esbuild spellings, and not a plain import", () => {
    // Assembled at run time, so this file does not itself read as one of those tests to the scan above.
    const loader = ["t", "sx"].join("");
    const entries = ["entry", "Points"].join("");
    expect(runsRepoCodeOutOfProcess(`spawn(process.execPath, ["--import", "${loader}", fixture])`)).toBe(true);
    expect(runsRepoCodeOutOfProcess(`execFileSync(node, ['--import=${loader}', script])`)).toBe(true);
    expect(runsRepoCodeOutOfProcess(`const loader = "${loader}/esm";`)).toBe(true);
    expect(runsRepoCodeOutOfProcess(`await build({ ${entries}: [file], bundle: true })`)).toBe(true);
    expect(runsRepoCodeOutOfProcess('import { refresh } from "../refresh.js";')).toBe(false);
  });

  it("refuses an entry that selects nothing", () => {
    expect(() => expandMustRunTests({ groups: { stale: ["src/gone/__tests__/gone.test.ts"] } }, trackedTests))
      .toThrow("entry src/gone/__tests__/gone.test.ts selects no collected test file");
    expect(() => expandMustRunTests({ groups: { empty: [] } }, trackedTests)).toThrow("must list at least one path");
    expect(() => expandMustRunTests({}, trackedTests)).toThrow('must hold a "groups" object');
  });
});

describe("computed-import detection", () => {
  it.each([
    ["await import(entryUrl)", true],
    ["require(modulePath)", true],
    ["import.meta.glob('./x/*.ts')", true],
    ["await import(`./locales/${lang}.js`)", true],
    ['await import("./literal.js")', false],
    ["await import('./literal.js')", false],
    ['import(/* webpackChunkName: "x" */ "./x.js")', false],
    ["await import(`./literal.js`)", false],
    ['const x = require("node:fs")', false],
    ['import { a } from "./a.js"', false],
    ["vi.importActual<typeof m>(\"./m.js\")", false],
  ])("%s -> %s", (text, expected) => {
    expect(loadsComputedImport(text)).toBe(expected);
  });
});

describe("paths a test names", () => {
  it("collects repository-rooted and test-relative literals", () => {
    const text = [
      'readFileSync("src/plugins/runtime/index.ts")',
      "scan('src/ui/renderer/')",
      'resolve(__dirname, "../fixtures/case.json")',
      "const dynamic = `src/${name}.ts`;",
      'walk(join(repoRoot, "test"))',
      'const fixtureHome = join(home, "src");',
    ].join("\n");
    expect(namedRepositoryPaths("src/a/__tests__/x.test.ts", text).sort()).toEqual([
      "src/a/fixtures/case.json",
      "src/plugins/runtime/index.ts",
      "src/ui/renderer/",
      "test/",
    ]);
  });

  it("matches the file, the same module under another extension, or a directory holding it", () => {
    expect(namesChangedPath("src/a/b.ts", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/a/b.js", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/a", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/a/", "src/a/b.ts")).toBe(true);
    expect(namesChangedPath("src/ab", "src/a/b.ts")).toBe(false);
    expect(namesChangedPath("src/a/b.ts", "src/a/bc.ts")).toBe(false);
  });
});

describe("raw diff parsing shared with the pre-push hook", () => {
  it("parses entries and refuses a truncated record", () => {
    const record = ":100644 100644 aaaa bbbb M\0src/a.ts\0:000000 100644 0000 cccc A\0src/b.ts\0";
    expect(parseGitRawDiff(record)).toEqual([
      { oldMode: "100644", newMode: "100644", status: "M", path: "src/a.ts" },
      { oldMode: "000000", newMode: "100644", status: "A", path: "src/b.ts" },
    ]);
    expect(parseGitRawDiff(":100644 100644 aaaa bbbb M\0")).toBeNull();
    expect(parseGitRawDiff("not a diff\0")).toBeNull();
  });
});
