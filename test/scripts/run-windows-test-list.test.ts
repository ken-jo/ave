import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { planWindowsTests } from "../../scripts/plan-windows-tests.js";
import { collectedVitestFiles } from "../../scripts/lib/vitest-collection.mjs";
import { WINDOWS_TEST_SHARDS, windowsTestCommands } from "../../scripts/run-windows-test-list.mjs";
import { COMMAND_LINE_BUDGET_CHARS, commandLineLength } from "../../scripts/hooks/spawn-command.mjs";
import { githubExpression } from "../../src/__tests__/test-helpers.js";

describe("Windows test shard runner", () => {
  it("runs its shard from the plan and shard ID in the environment", () => {
    const job = parse(readFileSync(resolve(".github/workflows/ci.yml"), "utf8")).jobs["windows-permission-tests"];
    const step = job.steps.find((entry: { name?: string }) => entry.name === "Run Windows regressions");
    expect(step.run).toBe("node .github/scripts/run-in-job.mjs bun run scripts/run-windows-test-list.mjs");
    expect(job.env.AVE_WINDOWS_TEST_SHARD).toBe(githubExpression("matrix.shard"));
    expect(step.env.AVE_WINDOWS_TEST_PLAN).toBe(`${githubExpression("runner.temp")}/windows-ci/windows-plan.json`);
  });
  it("prepares once and preserves the complete shard across bounded commands", () => {
    const files = Array.from({ length: 1500 }, (_, i) => `src/permissions/__tests__/native-boundary-${i}.test.ts`);
    const commands = windowsTestCommands(files);
    expect(commands[0]).toEqual(["run", "test:prepare"]);
    expect(commands.length).toBeGreaterThan(2);
    expect(commands.slice(1).flatMap(args => args.slice(4))).toEqual(files.map(file => `./${file}`));
    expect(commands.every(args => commandLineLength("bun.exe", args) <= COMMAND_LINE_BUDGET_CHARS)).toBe(true);
  });
  it("runs a collected smoke suite like any other suite", () => {
    expect(windowsTestCommands(["test/smoke/live-model.smoke.test.ts"])).toEqual([
      ["run", "test:prepare"], ["run", "test:vitest", "--", "run", "./test/smoke/live-model.smoke.test.ts"],
    ]);
  });
  it.each([
    [[]], [["src/data/__tests__/store.test.ts", "src/data/__tests__/store.test.ts"]],
    [["test/../outside.test.ts"]], [["test/e2e/run.spec.ts"]], [["test/screenshots/capture.spec.ts"]], [["src/data/store.ts"]],
  ])("rejects an invalid shard: %j", files => {
    expect(() => windowsTestCommands(files)).toThrow();
  });
});

describe("Windows test shard runner entry point", () => {
  const root = resolve(import.meta.dirname, "../..");
  const runner = join(root, "scripts/run-windows-test-list.mjs");
  function run(env: Record<string, string>, args: string[] = []) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AVE_WINDOWS_TEST_")));
    return spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: "utf8", env: { ...base, ...env } });
  }
  function withPlan(mutate: (plan: ReturnType<typeof planWindowsTests>) => void, check: (path: string) => void) {
    const directory = mkdtempSync(join(tmpdir(), "ave-windows-plan-"));
    try {
      const plan = planWindowsTests(collectedVitestFiles(root));
      mutate(plan);
      const path = join(directory, "windows-plan.json");
      writeFileSync(path, JSON.stringify(plan));
      check(path);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  it.each([
    ["no plan or shard", {}, [], "requires AVE_WINDOWS_TEST_PLAN and AVE_WINDOWS_TEST_SHARD"],
    ["a list argument", { AVE_WINDOWS_TEST_SHARD: "1", AVE_WINDOWS_TEST_PLAN: "plan.json" }, ["config/windows-native-tests.txt"],
      "takes its plan and shard from the environment"],
    ["a non-numeric shard", { AVE_WINDOWS_TEST_SHARD: "1/5", AVE_WINDOWS_TEST_PLAN: "plan.json" }, [], "requires AVE_WINDOWS_TEST_PLAN"],
  ])("refuses %s before running any suite", (_name, env, args, message) => {
    const result = run(env, args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
  });
  it("refuses an unknown shard ID and a plan that omits a collected suite", () => {
    withPlan(() => {}, path => {
      const unknown = String(WINDOWS_TEST_SHARDS.length + 1);
      const result = run({ AVE_WINDOWS_TEST_PLAN: path, AVE_WINDOWS_TEST_SHARD: unknown });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Invalid Windows test shard: ${unknown}`);
    });
    withPlan(plan => { plan.shards[0]?.files.shift(); }, path => {
      const result = run({ AVE_WINDOWS_TEST_PLAN: path, AVE_WINDOWS_TEST_SHARD: "1" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Windows plan omits 1 collected suite(s)");
      expect(result.stdout).not.toContain("Windows shard 1:");
    });
  });
});
