import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { collectRelatedTestFiles } from "../../scripts/hooks/pre-push-related-tests.mjs";
import { getRelatedCoverageFullReason } from "../../scripts/hooks/pre-push-source-policy.mjs";

describe("pre-push related test coverage", () => {
  it("queries each source independently so a covered module cannot mask an opaque module", async () => {
    const context = {
      config: { related: [] as string[] },
      getRelevantTestSpecifications: async () => context.config.related[0] === resolve("src/covered.ts").replaceAll("\\", "/")
        ? [{ moduleId: resolve("test/covered.test.ts") }] : [],
    };
    const coverage = await collectRelatedTestFiles(context, ["src/covered.ts", "src/opaque.ts"], resolve("."));
    expect(coverage).toEqual([
      { source: "src/covered.ts", tests: ["test/covered.test.ts"] },
      { source: "src/opaque.ts", tests: [] },
    ]);
    expect(getRelatedCoverageFullReason(["src/covered.ts", "src/opaque.ts"], coverage)).toBe("src/opaque.ts has no related test files");
  });

  it.each([undefined, [], [{ source: "src/example.ts", tests: [] }], [{ source: "src/example.ts", tests: ["../outside.test.ts"] }]])(
    "rejects missing, empty and malformed discovery reports: %j", (coverage) => {
      expect(getRelatedCoverageFullReason(["src/example.ts"], coverage)).not.toBeNull();
    },
  );

  it("accepts complete per-module discovery", () => {
    expect(getRelatedCoverageFullReason(["src/example.ts"], [{ source: "src/example.ts", tests: ["test/example.test.ts"] }])).toBeNull();
  });

  it.each([
    ["related", { tests: ["test/example.test.ts"], narrowed: [], sources: ["src/example.ts"] }, "related tests ran zero tests"],
    ["bounded", { tests: ["test/example.test.ts"], narrowed: [{ source: "src/example.ts", related: 200, direct: 1 }], sources: ["src/example.ts"] },
      "bounded related tests ran zero tests"],
  ])("fails closed when the %s run exits successfully but reports zero tests", (_label, selection, message) => {
    const source = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    const start = source.indexOf("function runVitestWithReport(");
    const end = source.indexOf("// Per-module related-test discovery", start);
    const runs: string[][] = [];
    const runFastChecks = runInNewContext(source.slice(start, end) + "; runAppFastSourceChecks", {
      commands: { bun: "bun" }, available: () => "bun", hasPackageScript: () => true, hasFile: () => true,
      join, tmpdir, mkdtempSync, rmSync,
      runAppTypecheckGate: () => {}, ensureAppTestRuntimeAbi: () => {}, ensureWindowsJobLauncher: () => {},
      resolveHostLockSettings: () => ({ directory: "/fixture-locks", timeoutMs: 1000, fastSlots: 1 }),
      withHostLock: (_options: object, callback: () => unknown) => callback(),
      run: (_command: string, args: string[]) => { runs.push(args); }, withoutGitContext: () => ({}),
      readJsonFile: () => ({ numTotalTests: 0 }),
    });
    expect(() => runFastChecks("/fixture", [], [], selection, null)).toThrow(message);
    // No lock suite was triggered and no test file changed: no unscoped Vitest run.
    expect(runs.every((args) => args.at(-1) !== "run")).toBe(true);
  });

  it("runs the message catalog checks, then Vitest related to the changed modules and the tested message consumers", () => {
    const source = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    const start = source.indexOf("function runVitestWithReport(");
    const end = source.indexOf("// Per-module related-test discovery", start);
    const calls: string[] = [];
    const lockOptions: object[] = [];
    const runFastChecks = runInNewContext(source.slice(start, end) + "; runAppFastSourceChecks", {
      commands: { bun: "bun" }, available: () => "bun", hasPackageScript: () => true, hasFile: () => true,
      join, tmpdir, mkdtempSync, rmSync,
      runAppTypecheckGate: () => { calls.push("typecheck"); }, ensureAppTestRuntimeAbi: () => {}, ensureWindowsJobLauncher: () => {},
      MESSAGE_CATALOG_CHECK_SCRIPTS: ["check:i18n-catalog", "check:i18n-barrels"],
      runPackageScripts: (_dir: string, scripts: string[]) => { calls.push(scripts.join(" ")); },
      resolveHostLockSettings: () => ({ directory: "/fixture-locks", timeoutMs: 1000, fastSlots: 3 }),
      withHostLock: (options: object, callback: () => unknown) => { lockOptions.push(options); return callback(); },
      run: (_command: string, args: string[]) => { calls.push(args.filter((arg) => !arg.startsWith("--")).join(" ")); },
      withoutGitContext: () => ({}),
      readJsonFile: () => ({ numTotalTests: 3, numPassedTests: 3 }),
    });
    runFastChecks("/fixture", [], ["src/i18n/__tests__/i18n.test.ts"], {
      tests: ["src/ui/__tests__/panel.test.tsx"], narrowed: [], sources: ["src/ui/panel.tsx"],
    }, { files: ["src/i18n/messages/generated/panel.ts"], namespaces: ["panel"], consumerModules: ["src/ui/panel.tsx"] });
    expect(calls).toEqual([
      "typecheck",
      "check:i18n-catalog check:i18n-barrels",
      "run check:test-duplicates",
      "run test:vitest run ./src/i18n/__tests__/i18n.test.ts",
      "run test:vitest related ./src/ui/panel.tsx",
    ]);
    expect(lockOptions).toEqual([{ name: "fast", label: "fast-tier", directory: "/fixture-locks", timeoutMs: 1000, slots: 3 }]);
  });

  it("leaves out a message consumer no test reaches, but never a changed module", () => {
    const source = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    const start = source.indexOf("// Per-module related-test discovery");
    const end = source.indexOf("function runAppCommentOnlyChecks", start);
    const select = (coverage: { source: string; tests: string[] }[]) => runInNewContext(source.slice(start, end) + "; getFastSourceRelatedSelection", {
      commands: { node: "node" }, join, withoutGitContext: () => ({}), readFileSync: () => "",
      spawnSync: () => ({ status: 0, stdout: JSON.stringify(coverage) }),
      getRelatedCoverageFullReason, boundRelatedTests: (records: { tests: string[] }[]) => ({
        tests: [...new Set(records.flatMap((record) => record.tests))].sort(), narrowed: [],
      }),
    });
    const changed = { source: "src/lib/changed.ts", tests: ["src/lib/__tests__/changed.test.ts"] };
    const tested = { source: "src/ui/panel.tsx", tests: ["src/ui/__tests__/panel.test.tsx"] };
    const untested = { source: "src/ui/orphan.tsx", tests: [] };
    expect(select([changed, tested, untested])("/fixture", [changed.source], [tested.source, untested.source])).toEqual({
      tests: ["src/lib/__tests__/changed.test.ts", "src/ui/__tests__/panel.test.tsx"],
      narrowed: [],
      sources: [changed.source, tested.source],
      untestedConsumers: [untested.source],
    });
    // A changed module with no related test still keeps the full checks.
    expect(select([{ source: "src/lib/changed.ts", tests: [] }, tested])("/fixture", ["src/lib/changed.ts"], [tested.source]))
      .toEqual({ reason: "src/lib/changed.ts has no related test files" });
  });
});
