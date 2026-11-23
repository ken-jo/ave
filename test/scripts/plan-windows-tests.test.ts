import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertWindowsCoverage, planWindowsTests, pullRequestWindowsChanges, WINDOWS_TEST_LISTS } from "../../scripts/plan-windows-tests.js";
import { plannedWindowsFiles, windowsTestFiles } from "../../scripts/run-windows-test-list.mjs";

const [permission, native, application] = WINDOWS_TEST_LISTS;
const inventories = {
  [permission]: windowsTestFiles(readFileSync(permission, "utf8")),
  [native]: windowsTestFiles(readFileSync(native, "utf8")),
  [application]: windowsTestFiles(readFileSync(application, "utf8")),
};
const permissionSuite = "src/shared/__tests__/tool-result-trim.test.ts";
const changed = "src/shared/test-change.ts";
const dependency = "src/shared/test-dependency.ts";
const readSources = () => new Map([
  [permissionSuite, 'import "../test-dependency.js";'],
  [dependency, 'export { value } from "./test-change.js";'],
  [changed, "export const value = 1;"],
]);

function plan(changes?: { status: string; file: string }[], event = "pull_request") {
  return planWindowsTests({ event, changes, inventories, readSources });
}

describe("Windows regression planning", () => {
  it.each(["push", "schedule", "workflow_dispatch"])("runs both complete inventories for %s", event => {
    expect(plan([], event)).toMatchObject({ mode: "full", lists: inventories });
  });

  it.each([".github/workflows/ci.yml", "config/test.ts", "scripts/tool.ts", "test/scripts/ci.test.ts", "package.json", "bun.lock", "patches/dep.patch"])(
    "runs both complete inventories when %s changes",
    file => expect(plan([{ status: "M", file }])).toMatchObject({ mode: "full", lists: inventories }),
  );

  it("keeps the explicit core when the diff is empty", () => {
    const result = plan([]);
    expect(result.mode).toBe("affected");
    expect([...new Set(Object.values(result.lists).flat())].sort()).toEqual([
      "src/main/__tests__/windows-acl-host.test.ts",
      "src/main/__tests__/windows-job-launcher.test.ts",
      "src/main/__tests__/windows-path-kind-launcher.test.ts",
      "src/permissions/__tests__/sandbox-control-writes-mxc.integration.test.ts",
      "src/sandbox/__tests__/runtime-grant-native.test.ts",
      "src/tools/__tests__/xlsx-edit-sandbox.integration.test.ts",
    ]);
  });

  it("tracks the changed file through transitive imports and keeps the core", () => {
    const result = plan([{ status: "M", file: changed }]);
    expect(result.mode).toBe("affected");
    expect(result.lists[permission]).toContain(permissionSuite);
    expect(result.lists[native]).toEqual(plan([]).lists[native]);
  });

  it("fails closed for missing history, absent source and deleted paths", () => {
    expect(pullRequestWindowsChanges(process.cwd(), "not-a-ref", "HEAD")).toBeUndefined();
    expect(plan()).toMatchObject({ mode: "full", lists: inventories });
    expect(plan([{ status: "M", file: "src/missing.ts" }]).mode).toBe("full");
    expect(plan([{ status: "D", file: changed }]).mode).toBe("full");
  });

  it("rejects an omitted affected test and an incomplete or out-of-inventory full plan", () => {
    expect(() => assertWindowsCoverage([permissionSuite], [])).toThrow(permissionSuite);
    expect(() => plannedWindowsFiles(permission, inventories[permission].join("\n"), {
      mode: "full", lists: { [permission]: [] },
    })).toThrow("Invalid Windows plan");
    expect(() => plannedWindowsFiles(permission, inventories[permission].join("\n"), {
      mode: "affected", lists: { [permission]: ["src/unknown.test.ts"] },
    })).toThrow("Invalid Windows plan");
  });
});
