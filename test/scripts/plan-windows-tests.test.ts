import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertWindowsCoverage, planWindowsTests, pullRequestWindowsChanges } from "../../scripts/plan-windows-tests.js";
import { plannedWindowsFiles, WINDOWS_TEST_LISTS, WINDOWS_TEST_SHARDS, windowsTestFiles } from "../../scripts/run-windows-test-list.mjs";
import { windowsImportGraph, windowsRuntimeInputIndex } from "./windows-native-test-inventory.js";

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
  const modified = (file: string) => ({ file, status: "M", oldMode: "100644", newMode: "100644" });
  const removed = "src/core/__tests__/route-input.test.ts";
  const selected = (result: ReturnType<typeof planWindowsTests>) => result.shards.flatMap(shard => shard.files).sort();
  const core = () => selected(plan([]));

  it.each([permission, native])("runs the exact membership delta of %s and the core", list => {
    expect(Object.values(inventories).flat()).not.toContain(removed);
    const added = inventories[list][0] ?? "";
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(list)], inventories,
      readSources: () => { throw new Error("inventory-only changes should not scan the source graph"); },
      readVersion: (file, side) => file === list ? `${side === "before" ? removed : added}\n` : "export {};\n",
    });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...new Set([...core(), added, removed])].sort());
    const scheduled = WINDOWS_TEST_SHARDS.flatMap(shard => plannedWindowsFiles(list, inventories[list].join("\n"), result, shard));
    expect(scheduled).toContain(removed);
    expect(() => plannedWindowsFiles(list, inventories[list].join("\n"), { ...result, mode: "full" }, 1))
      .toThrow("Invalid Windows supplemental tests");
  });

  it("selects marker-only changes before a general source fallback", () => {
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(removed), modified(permissionSuite)], inventories,
      readSources: () => { throw new Error("marker-only changes should not scan the source graph"); },
      readVersion: (file, side) => (file === removed) === (side === "after") ? "// windows-permission\nexport {};\n" : "export {};\n",
    });
    expect(result.mode).toBe("affected");
    expect(selected(result)).toEqual([...new Set([...core(), removed, permissionSuite])].sort());
  });

  it("retains full selection when a CI input changes with a list", () => {
    const result = planWindowsTests({
      event: "pull_request", changes: [modified(permission), modified(".github/workflows/ci.yml")], inventories, readSources,
      readVersion: (file, side) => file === permission ? `${side === "before" ? removed : permissionSuite}\n` : null,
    });
    expect(result).toMatchObject({ mode: "full", reason: "full because .github/workflows/ci.yml affects CI globally", lists: inventories });
  });

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

  it.each([
    'import { spawn as run } from "node:child_process"; run(process.execPath, ["--import=tsx", "../test-change.ts"]);',
    'import { execFile as run } from "node:child_process"; run("node", ["--import=tsx", "../test-change.js"]);',
    'import { buildSync as bundle } from "esbuild"; bundle({ entryPoints: ["src/shared/test-change.ts"], bundle: true });',
    'import { readFileSync as read } from "node:fs"; read(new URL("../test-change.ts", import.meta.url), "utf8");',
    'import { existsSync, readFileSync, statSync } from "node:fs"; readFileSync("../test-change.ts");',
  ])("selects a suite that consumes changed code through %s", source => {
    const runtimeSources = () => new Map([[permissionSuite, source], [changed, "export const value = 1;"]]);
    const result = planWindowsTests({ event: "pull_request", changes: [{ status: "M", file: changed }], inventories, readSources: runtimeSources });
    expect(result.mode).toBe("affected");
    expect(result.lists[permission]).toContain(permissionSuite);
  });

  it.each([
    'import { spawn } from "node:child_process"; spawn("bun", [process.env.RUNTIME_SOURCE]);',
    'import { spawn } from "node:child_process"; const launch = spawn; launch("bun", [process.env.RUNTIME_SOURCE]);',
    'import { buildSync } from "esbuild"; buildSync({ entryPoints: [process.env.RUNTIME_SOURCE] });',
    'import { readFileSync } from "node:fs"; readFileSync(process.env.RUNTIME_SOURCE);',
  ])("falls back to all lists when %s could reach a changed source", source => {
    const runtimeSources = () => new Map([[permissionSuite, source], [changed, "export const value = 1;"]]);
    const result = planWindowsTests({ event: "pull_request", changes: [{ status: "M", file: changed }], inventories, readSources: runtimeSources });
    expect(result.mode).toBe("full");
    expect(result.reason).toContain("runtime source input");
  });

  const runtimeContracts = [
    ["src/plugins/__tests__/registry-atomicity.test.ts", "src/plugins/__tests__/fixtures/registry-process-child.ts"],
    ["src/permissions/__tests__/srt-win-integrity.test.ts", "src/permissions/__tests__/fixtures/srt-win-exit-order-child.ts"],
    ["src/shared/__tests__/ave-home-host-ownership.test.ts", "src/main/host-instance-lock.ts"],
  ] as const;
  it.each(runtimeContracts)("keeps %s when its real runtime input %s changes", (suite, target) => {
    // Expected paths come from the child/bundle call sites. The graph cannot choose the expected suite.
    const runtimeSources = new Map([suite, target].map(file => [file, readFileSync(file, "utf8")]));
    const module = windowsImportGraph(runtimeSources).get(suite);
    expect(module).toBeDefined();
    expect(windowsRuntimeInputIndex(runtimeSources)(module?.tokens ?? [])).toContain(target);
    expect(inventories[permission]).toContain(suite);
    const result = planWindowsTests({
      event: "pull_request", changes: [{ status: "M", file: target }], inventories, readSources: () => runtimeSources,
    });
    expect(result.lists[permission]).toContain(suite);
    expect(result.shards.flatMap(shard => shard.files)).toContain(suite);
  });

  it("uses a full plan for executable source-tree fixtures even without a discovered caller", () => {
    const file = "src/shared/__tests__/fixtures/computed.ts";
    expect(plan([{ status: "M", file }])).toMatchObject({ mode: "full", reason: expect.stringContaining("executable fixture") });
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

  it.each([{ changes: [] }, { changes: [{ status: "M", file: "package.json" }] }])("assigns each selected file to one nonempty shard (%j)", ({ changes }) => {
    const result = plan(changes);
    expect(result.shards.map(shard => shard.id)).toEqual(WINDOWS_TEST_SHARDS);
    expect(result.shards.every(shard => shard.files.length > 0)).toBe(true);
    const files = WINDOWS_TEST_SHARDS.flatMap(shard => WINDOWS_TEST_LISTS.flatMap(list =>
      plannedWindowsFiles(list, inventories[list].join("\n"), result, shard)));
    const expected = [...new Set(Object.values(result.lists).flat())].sort();
    expect(files.sort()).toEqual(expected);
    result.shards[0]?.files.pop();
    expect(() => plannedWindowsFiles(permission, inventories[permission].join("\n"), result, 1))
      .toThrow("Windows shards must cover every selected test exactly once");
  });

  it("balances by measured duration before file count", () => {
    const brief = plan([]);
    const worst = brief.shards[0]?.files[0];
    if (worst === undefined) throw new Error("No Windows tests assigned to the first shard");
    const result = planWindowsTests({ event: "pull_request", inventories, changes: [], readSources, durations: { [worst]: 100_000 } });
    expect(result.shards[0]?.files).toEqual([worst]);
    expect(result.shards[0]?.weightMs).toBe(101_000);
  });
});
