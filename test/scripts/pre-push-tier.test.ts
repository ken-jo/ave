// Exercise full-tier dispatch separately from scoped classification.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

import { AVE_APP_LOCK_SUITES, isCollectedVitestFile } from "../../scripts/hooks/pre-push-source-policy.mjs";
import {
  describeScopedTier,
  FROZEN_LOCKFILE_ARGS,
  FULL_SUITE_DEFERRED,
  GLOBAL_INPUT_TIER,
  selectNamedPathTests,
  selectScopedTier,
  selectUnattributedCatalogChecks,
  selectUntestedModuleTests,
} from "../../scripts/hooks/pre-push-tier.mjs";
import { MUST_RUN_TESTS_PATH } from "../../scripts/run-ci-suite.mjs";
import { modifiedEntry as modified } from "../../src/__tests__/support/git-diff-entry.js";

const root = resolve(".");
const hook = readFileSync(resolve(root, "scripts/hooks/run-local-checks.mjs"), "utf8");
const trackedTests = execFileSync("git", ["-C", root, "ls-files", "-z", "--", "src", "test"], { encoding: "utf8" })
  .split("\0").filter((path) => path && isCollectedVitestFile(path)).sort();
const readTracked = (path: string) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
};
const WORKFLOW_READERS = [
  "src/__tests__/packaging-discipline-source.test.ts",
  "src/permissions/__tests__/sandbox-write-policy.test.ts",
  "test/scripts/git-inventory-gates.test.ts",
  "test/scripts/pre-push-source-policy.test.ts",
  "test/scripts/run-ci-suite.test.ts",
];

// Execute the hook dispatch expression so stage and switch precedence cannot drift.
function dispatch(stage: string, env: Record<string, string>) {
  const start = hook.indexOf("let classification =") + "let classification =".length;
  const end = hook.indexOf(";\n  if (classification.fastSource)", start);
  return runInNewContext(`(${hook.slice(start, end)})`, {
    stage, process: { env }, repoRoot: "/fixture", prePushUpdates: null, remoteLocation: "/remote",
    pushCheckout: { commitByLocalSha: new Map() }, withPushedCommits: () => null,
    classifyPrePushChanges: () => ({ docsOnly: false, fastSource: true }),
  });
}

function resolveScoped(classification: Record<string, unknown>, related: Record<string, unknown>) {
  const start = hook.indexOf("function getScopedExtraTests(");
  const end = hook.indexOf("// The retired-name gate", start);
  return runInNewContext(`${hook.slice(start, end)}; resolveScopedTier`, {
    commands: { git: "git" }, spawnSync, readFileSync, join, isCollectedVitestFile, selectNamedPathTests,
    selectUntestedModuleTests, MUST_RUN_TESTS_PATH, GLOBAL_INPUT_TIER, AVE_APP_LOCK_SUITES, Error,
    decodeUtf8Strict: (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    readJsonFile: (path: string) => JSON.parse(readFileSync(path, "utf8")),
    getFastSourceRelatedSelection: () => related,
  })(root, {
    tier: "fast", tierReasons: [], reason: "fixture", lockSuites: [], testFiles: [], relatedFiles: [], namedPaths: [],
    messageCatalog: null, ...classification,
  });
}
const noRelated = { tests: [], narrowed: [], sources: [], untestedConsumers: [], untestedModules: [] };

describe("pre-push full tier on request only", () => {
  it.each([
    ["manual", {}, "manual stage runs the full checks"],
    ["pre-push", { AVE_PREPUSH_FULL: "1" }, "AVE_PREPUSH_FULL=1 requested the full checks"],
  ])("keeps the full checks for stage %s with %j", (stage, env, reason) => {
    expect(dispatch(stage, env)).toEqual({ docsOnly: false, reason });
  });

  it("classifies every other pre-push", () => {
    expect(dispatch("pre-push", {})).toEqual({ docsOnly: false, fastSource: true });
    expect(dispatch("pre-push", { AVE_PREPUSH_FULL: "0" })).toEqual({ docsOnly: false, fastSource: true });
  });

  it("documents AVE_PREPUSH_FULL=1 and the request cases in the hook header", () => {
    const header = hook.slice(0, hook.indexOf("\nimport "));
    expect(header).toContain("Set AVE_PREPUSH_FULL=1 to run the full tier for any push.");
    expect(header).toContain("only on request: AVE_PREPUSH_FULL=1, the manual stage");
    expect(header).toContain(FULL_SUITE_DEFERRED);
  });
});

describe("pre-push scoped tier log line", () => {
  it("names the tier, the reason and the deferral to CI", () => {
    const line = describeScopedTier({ tier: GLOBAL_INPUT_TIER, runs: "every lock suite", reason: "package.json is a global test or build input" });
    expect(line).toBe(
      "[checks] tier=global-input pre-push: running every lock suite; remaining tests and build deferred to CI, " +
        "whose scope scripts/run-ci-suite.mjs picks " +
        "(package.json is a global test or build input; AVE_PREPUSH_FULL=1 runs the full checks)",
    );
  });

  it("says what is deferred to CI on every scoped tier's log line", () => {
    for (const tier of ["docs-only", "comment-only", "test-only"]) {
      const line = hook.slice(hook.indexOf(`[checks] tier=${tier} pre-push`)).split("\n").slice(0, 3).join("\n");
      expect(line).toContain("${FULL_SUITE_DEFERRED}");
    }
    expect(hook).toContain("console.log(describeScopedTier({");
  });
});

describe("pre-push scoped tier selection", () => {
  it("selects the workflow readers for a .github/workflows/ci.yml change", () => {
    const scoped = selectScopedTier([modified(".github/workflows/ci.yml")]);
    expect(scoped).toMatchObject({ tier: "fast", namedPaths: [".github/workflows/ci.yml"], relatedFiles: [], documentationEntries: [] });
    const selected = selectNamedPathTests(scoped.namedPaths, trackedTests, readTracked);
    expect(selected).toEqual(expect.arrayContaining(WORKFLOW_READERS));
    expect(selected.every((test) => test.startsWith("test/scripts/") ||
      test === "src/__tests__/packaging-discipline-source.test.ts" ||
      test === "src/permissions/__tests__/sandbox-write-policy.test.ts"))
      .toBe(true);
  });

  it("sends Markdown under .github/ through the documentation checks and its own readers only", () => {
    const scoped = selectScopedTier([modified(".github/CONTRIBUTING.md")]);
    expect(scoped.tier).toBe("fast");
    expect(scoped.documentationEntries.map(({ path }) => path)).toEqual([".github/CONTRIBUTING.md"]);
    const selected = selectNamedPathTests(scoped.namedPaths, trackedTests, readTracked);
    expect(selected).not.toContain("test/scripts/git-inventory-gates.test.ts");
    expect(selected).not.toContain("test/scripts/run-ci-suite.test.ts");
  });

  it("runs vitest related on a changed script and the tests that name it", () => {
    const scoped = selectScopedTier([modified("scripts/run-ci-suite.mjs")]);
    expect(scoped).toMatchObject({
      tier: "fast", relatedFiles: ["scripts/run-ci-suite.mjs"], namedPaths: ["scripts/run-ci-suite.mjs"],
    });
    expect(scoped.reason).toContain("1 scripts/ path(s)");
    expect(selectNamedPathTests(scoped.namedPaths, trackedTests, readTracked)).toContain("test/scripts/run-ci-suite.test.ts");
  });

  it.each(["scripts", ".github"].flatMap((directory) => [
    { ...modified(`${directory}/lib/tls-bypass-patterns.mjs`), status: "D", newMode: "000000" },
    { ...modified(`${directory}/hooks/pre-push`), oldMode: "100755" },
    { ...modified(`${directory}/lib/evil.mjs`), status: "A", oldMode: "000000", newMode: "120000" },
    { ...modified(`${directory}/lib/submodule`), status: "A", oldMode: "000000", newMode: "160000" },
  ]))("keeps untraceable $path ($newMode) on the global-input tier", (entry) => {
    const scoped = selectScopedTier([entry]);
    expect(scoped.tier, entry.path).toBe(GLOBAL_INPUT_TIER);
    expect(scoped.reason).toContain(entry.path);
    expect(scoped.namedPaths).toEqual([entry.path]);
    expect(scoped.relatedFiles).toEqual([]);
  });

  it("returns the related modules dropped at the command limit and keeps their named paths", () => {
    const paths = Array.from({ length: 100 }, (_, index) => `scripts/lib/${index}-${"a".repeat(180)}.mjs`).sort();
    const scoped = selectScopedTier(paths.map(modified));
    expect(scoped).toMatchObject({
      tier: GLOBAL_INPUT_TIER,
      relatedFiles: [],
      droppedRelatedFiles: paths,
      namedPaths: paths,
    });
    expect(scoped.reason).toContain("changed file arguments exceed the safe command limit");
  });

  it("logs dropped related modules while still running the tests that name them", () => {
    const droppedRelatedFiles = ["scripts/run-ci-suite.mjs"];
    const result = resolveScoped({ droppedRelatedFiles, namedPaths: droppedRelatedFiles }, noRelated);
    expect(result.namedTests).toContain("test/scripts/run-ci-suite.test.ts");
    expect(result.testFiles).toEqual(expect.arrayContaining(result.namedTests));
    const lines: string[] = [];
    const start = hook.indexOf("const { tier, lockSuites, relatedSelection, messageCatalog, untestedModules }");
    const end = hook.indexOf("if (classification.documentationEntries.length > 0)", start);
    runInNewContext(hook.slice(start, end), {
      classification: result, GLOBAL_INPUT_TIER, describeScopedTier,
      console: { log: (line: string) => lines.push(line) },
    });
    expect(lines.filter((line) => line.includes("dropped"))).toEqual([
      "[checks] dropped 1 related module(s) from local discovery because changed file arguments exceed the safe command limit; CI covers them; path-naming tests still run",
    ]);
  });

  it.each(["package.json", "bun.lock", "bunfig.toml", "tsconfig.tests.json", "config/knip.jsonc", "src/__tests__/vitest-ave-home.ts"])(
    "takes the global-input tier for %s", (path) => {
      expect(selectScopedTier([modified(path)])).toMatchObject({
        tier: GLOBAL_INPUT_TIER, reason: `${path} is a global test or build input`, namedPaths: [path],
      });
    },
  );

  it("never hands an unsafe path to a command line and keeps the global-input tier", () => {
    const scoped = selectScopedTier([modified("src/lib/a b.ts")]);
    expect(scoped).toMatchObject({ tier: GLOBAL_INPUT_TIER, relatedFiles: [], namedPaths: [] });
    expect(scoped.reason).toContain("is not a safe command-line path");
  });
});

describe("pre-push untested modules", () => {
  const mustRun = {
    groups: {
      "out-of-process": ["test/child-process.test.ts"],
      permissions: ["src/permissions/__tests__/"],
    },
  };
  const tests = ["src/permissions/__tests__/rules.test.ts", "src/ui/__tests__/panel.test.tsx", "test/child-process.test.ts"];

  it("runs the must-run tests that cover a module no test imports", () => {
    expect(selectUntestedModuleTests("src/permissions/rules/new-rule.ts", [], mustRun, tests)).toEqual({
      module: "src/permissions/rules/new-rule.ts",
      namedTests: [],
      mustRunTests: ["src/permissions/__tests__/rules.test.ts", "test/child-process.test.ts"],
      lockSuites: [],
      untested: false,
    });
  });

  it("reports a module as having no local test only when every source is empty", () => {
    expect(selectUntestedModuleTests("src/ui/orphan.ts", [], { groups: {} }, tests)).toMatchObject({ untested: true });
    expect(selectUntestedModuleTests("src/ui/orphan.ts", ["src/ui/__tests__/panel.test.tsx"], { groups: {} }, tests))
      .toMatchObject({ untested: false });
    expect(selectUntestedModuleTests("src/ipc/domains/example.ts", [], { groups: {} }, tests).lockSuites.length).toBeGreaterThan(0);
  });

  it("continues a push whose changed module has no related test, with its must-run tests", () => {
    const module = "src/permissions/rules/untested-fixture.ts";
    const result = resolveScoped({ relatedFiles: [module] }, { ...noRelated, untestedModules: [module] });
    expect(result.tier).toBe("fast");
    expect(result.untestedModules).toHaveLength(1);
    expect(result.untestedModules[0]).toMatchObject({ module, untested: false });
    const mustRunDocument = JSON.parse(readFileSync(resolve(root, MUST_RUN_TESTS_PATH), "utf8"));
    for (const test of mustRunDocument.groups["out-of-process"]) {
      if (trackedTests.includes(test)) expect(result.testFiles).toContain(test);
    }
  });

  it("logs a module with no test of any kind and continues", () => {
    const start = hook.indexOf("for (const { module, namedTests, mustRunTests, lockSuites: moduleLockSuites, untested } of untestedModules)");
    expect(start).toBeGreaterThan(0);
    expect(hook.slice(start, start + 400)).toContain("has no local test: no related, path-naming, must-run or lock-suite test file reaches it; continuing");
  });
});

describe("pre-push global-input tier", () => {
  it("runs every lock suite and the tests that name the changed input", () => {
    const result = resolveScoped(
      { tier: GLOBAL_INPUT_TIER, tierReasons: ["package.json is a global test or build input"], namedPaths: ["package.json"] },
      noRelated,
    );
    expect(result.lockSuites.map(({ suite }: { suite: string }) => suite)).toEqual([...AVE_APP_LOCK_SUITES]);
    expect(result.reason).toBe("package.json is a global test or build input");
    expect(result.namedTests.length).toBeGreaterThan(0);
    expect(result.testFiles).toEqual(expect.arrayContaining(result.namedTests));
  });

  it("keeps the global-input tier, not the full suite, when related-test discovery fails", () => {
    const result = resolveScoped({ relatedFiles: ["src/lib/example.ts"] }, { reason: "related test discovery failed" });
    expect(result).toMatchObject({ tier: GLOBAL_INPUT_TIER, reason: "related test discovery failed" });
    expect(result.untestedModules.map(({ module }: { module: string }) => module)).toEqual(["src/lib/example.ts"]);
  });

  it("runs the frozen-lockfile dry run first and passes it only for the global-input tier", () => {
    expect(FROZEN_LOCKFILE_ARGS).toEqual(["install", "--frozen-lockfile", "--dry-run"]);
    const start = hook.indexOf("function runAppFastSourceChecksHoldingSlot(");
    const calls: string[][] = [];
    const holdSlot = runInNewContext(`${hook.slice(start, hook.indexOf("// Per-module related-test discovery", start))}; runAppFastSourceChecksHoldingSlot`, {
      FROZEN_LOCKFILE_ARGS, MESSAGE_CATALOG_CHECK_SCRIPTS: [],
      run: (_command: string, args: string[]) => calls.push(["run", ...args]),
      runAppTypecheckGate: () => calls.push(["typecheck-gate"]),
      runPackageScripts: () => calls.push(["catalog"]),
      ensureAppTestRuntimeAbi: () => {}, ensureWindowsJobLauncher: () => {}, withoutGitContext: () => ({}),
      runVitestWithReport: () => calls.push(["related"]),
    });
    holdSlot("/fixture", "bun", [], [], noRelated, null, true);
    expect(calls.slice(0, 2)).toEqual([["run", ...FROZEN_LOCKFILE_ARGS], ["typecheck-gate"]]);
    calls.length = 0;
    holdSlot("/fixture", "bun", [], [], noRelated, null, false);
    expect(calls.some((call) => call.includes("--frozen-lockfile"))).toBe(false);
    expect(hook).toContain("const frozenLockfile = tier === GLOBAL_INPUT_TIER;");
    expect(hook).toContain("{ frozenLockfile }");
  });
});

describe("pre-push unattributed message catalog changes", () => {
  const fragment = (title: string) =>
    `export const en = {\n  "panel.title": ${JSON.stringify(title)},\n} as const;\n` +
    'export const ko: Record<keyof typeof en, string> = {\n  "panel.title": "패널",\n};\n';
  const tree = new Map([
    ["src/i18n/__tests__/i18n.test.ts", "export {};"],
    ["src/ui/panel.tsx", 'export const title = t("panel.title");'],
    ["src/ui/__tests__/panel.test.tsx", 'expect(t("panel.title")).toBe("Panel");'],
    ["src/ui/other.tsx", 'export const label = t("other.label");'],
    ["src/i18n/loader.ts", 'import { messages } from "./messages/index.js";'],
  ]);
  const select = (path: string, before: string | null, after: string | null) => selectUnattributedCatalogChecks(
    [{ ...modified(path), baseSha: "base", localSha: "local" }],
    { readBlob: (sha) => (sha === "base" ? before : after), trackedFiles: [...tree.keys()], readTrackedFile: (file) => tree.get(file) ?? null },
  );

  it("runs the i18n suites and the namespace consumers of a structural fragment edit", () => {
    expect(select("src/i18n/messages/generated/panel.ts", fragment("Panel"), `// note\n${fragment("Panel")}`)).toEqual({
      namespaces: ["panel"],
      unattributedFiles: [],
      testFiles: ["src/i18n/__tests__/i18n.test.ts", "src/ui/__tests__/panel.test.tsx"],
      consumerModules: ["src/ui/panel.tsx"],
      skippedConsumers: [],
    });
  });

  it("runs the i18n suites for a barrel it cannot attribute to a namespace", () => {
    expect(select("src/i18n/messages/generated/index.ts", 'export { en } from "./panel.js";', '// note\nexport { en } from "./panel.js";'))
      .toMatchObject({ namespaces: [], unattributedFiles: ["src/i18n/messages/generated/index.ts"], testFiles: ["src/i18n/__tests__/i18n.test.ts"] });
  });
});
