import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { collectRelatedTestFiles } from "../../scripts/hooks/pre-push-related-tests.mjs";
import { getRelatedCoverageFullReason, AVE_APP_LOCK_SUITES } from "../../scripts/hooks/pre-push-source-policy.mjs";

describe("pre-push related test coverage", () => {
  it("queries each source independently so a covered module cannot mask an opaque module", async () => {
    const context = {
      config: { related: [] as string[] },
      getRelevantTestSpecifications: async () => context.config.related[0] === resolve("src/covered.ts")
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

  it("fails closed when the related command exits successfully but reports zero tests", () => {
    const source = readFileSync(resolve("scripts/hooks/run-local-checks.mjs"), "utf8");
    const start = source.indexOf("function runAppFastSourceChecks(");
    const end = source.indexOf("function runAppCommentOnlyChecks(", start);
    const runFastChecks = runInNewContext(source.slice(start, end) + "; runAppFastSourceChecks", {
      commands: { bun: "bun" }, available: () => "bun", hasPackageScript: () => true, hasFile: () => true,
      join, tmpdir, mkdtempSync, rmSync, AVE_APP_LOCK_SUITES,
      runAppTypecheckGate: () => {}, ensureAppTestRuntimeAbi: () => {}, run: () => {}, withoutGitContext: () => ({}),
      readJsonFile: () => ({ numTotalTests: 0 }),
    });
    expect(() => runFastChecks("/fixture", [], ["src/example.ts"])).toThrow("related tests ran zero tests");
  });
});
