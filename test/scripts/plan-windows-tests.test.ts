import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { platformChecksRequired, type CiSuitePlan } from "../../scripts/run-ci-suite.mjs";
import { modifiedEntry } from "../../src/__tests__/support/git-diff-entry.js";
import { planWindowsTests, WINDOWS_TEST_TIMES, windowsTestDurations } from "../../scripts/plan-windows-tests.js";
import { collectedVitestFiles } from "../../scripts/lib/vitest-collection.mjs";
import { assertWindowsPlan, WINDOWS_TEST_SHARDS, windowsShardFiles } from "../../scripts/run-windows-test-list.mjs";

const root = resolve(import.meta.dirname, "../..");
const collected = collectedVitestFiles(root);
const times = JSON.parse(readFileSync(resolve(root, WINDOWS_TEST_TIMES), "utf8"));
const committedPlan = () => planWindowsTests(collected, windowsTestDurations(times));

describe("Windows shard planning", () => {
  it("assigns every collected suite to exactly one of the fixed shards", () => {
    const plan = committedPlan();
    expect(plan.shards.map(shard => shard.id)).toEqual([...WINDOWS_TEST_SHARDS]);
    expect(plan.suites).toBe(collected.length);
    expect(plan.shards.flatMap(shard => shard.files).sort()).toEqual(collected);
    for (const shard of plan.shards) expect(shard.files.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same checkout and timings", () => {
    expect(JSON.stringify(committedPlan())).toBe(JSON.stringify(planWindowsTests([...collected].reverse(), windowsTestDurations(times))));
  });

  it("balances by duration before file count", () => {
    const [heaviest] = collected;
    if (heaviest === undefined) throw new Error("No collected suites");
    const result = planWindowsTests(collected, file => file === heaviest ? 10_000_000 : 1000);
    expect(result.shards[0]?.files).toEqual([heaviest]);
    expect(result.shards[0]?.weightMs).toBe(10_001_000);
  });

  it("stays within ten percent between the heaviest and lightest shard on the committed timings", () => {
    const weights = committedPlan().shards.map(shard => shard.weightMs);
    expect(Math.max(...weights) / Math.min(...weights)).toBeLessThan(1.1);
  });

  it("places a new suite without a timing entry in exactly one shard", () => {
    const added = "src/core/__tests__/brand-new-suite.test.ts";
    expect(collected).not.toContain(added);
    const plan = planWindowsTests([...collected, added], windowsTestDurations(times));
    expect(plan.shards.filter(shard => shard.files.includes(added))).toHaveLength(1);
    expect(windowsTestDurations(times)(added)).toBe(1000);
  });

  it("uses Windows samples first, then Mac estimates, and ignores stale timing entries", () => {
    const duration = windowsTestDurations({
      unit: "ms",
      files: { "src/a/__tests__/both.test.ts": 7, "src/a/__tests__/gone.test.ts": 9 },
      macEstimate: { scale: 1.19, files: { "src/a/__tests__/both.test.ts": 99, "src/a/__tests__/mac.test.ts": 5 } },
    });
    expect([duration("src/a/__tests__/both.test.ts"), duration("src/a/__tests__/mac.test.ts"), duration("src/a/__tests__/none.test.ts")])
      .toEqual([7, 5, 1000]);
    const plan = planWindowsTests(["src/a/__tests__/both.test.ts", ...collected.slice(0, 9)], duration);
    expect(plan.shards.flatMap(shard => shard.files)).not.toContain("src/a/__tests__/gone.test.ts");
  });

  it("refuses a timing file without its Mac estimates", () => {
    expect(() => windowsTestDurations({ unit: "ms", files: {} } as never)).toThrow(WINDOWS_TEST_TIMES);
  });
});

describe("Windows plan check against the checkout", () => {
  const clone = () => structuredClone(committedPlan());
  it.each([
    ["a duplicate assignment", (plan: ReturnType<typeof clone>) => { plan.shards[1]?.files.push(plan.shards[0]?.files[0] ?? ""); }, "assigns a suite twice"],
    ["an omitted suite", (plan: ReturnType<typeof clone>) => { plan.shards[0]?.files.shift(); }, "omits 1 collected suite"],
    ["an uncollected suite", (plan: ReturnType<typeof clone>) => { plan.shards[0]?.files.push("src/x/__tests__/missing.test.ts"); }, "names an uncollected suite"],
    ["an empty shard", (plan: ReturnType<typeof clone>) => {
      const [first, second] = plan.shards;
      second?.files.push(...(first?.files ?? []));
      if (first) first.files = [];
    }, "non-empty shards"],
    ["a dropped shard", (plan: ReturnType<typeof clone>) => { plan.shards.pop(); }, "non-empty shards"],
    ["reordered shard IDs", (plan: ReturnType<typeof clone>) => { plan.shards.reverse(); }, "non-empty shards"],
  ])("rejects %s", (_name, mutate, message) => {
    const plan = clone();
    mutate(plan);
    expect(() => assertWindowsPlan(plan, collected)).toThrow(message);
    expect(() => windowsShardFiles(plan, 1, root)).toThrow(message);
  });

  it("returns one shard's files and refuses an unknown shard ID", () => {
    const plan = committedPlan();
    expect(windowsShardFiles(plan, 3, root)).toEqual(plan.shards[2]?.files);
    const unknown = WINDOWS_TEST_SHARDS.length + 1;
    expect(() => windowsShardFiles(plan, unknown, root)).toThrow(`Invalid Windows test shard: ${unknown}`);
  });
});

it.each([
  { event: "pull_request", base: "main", mode: "affected", file: "src/core/route-input.ts", runs: true },
  { event: "pull_request", base: "main", mode: "affected", file: "src/ui/renderer/hooks/use-chat-state.ts", runs: false },
  { event: "pull_request", base: "integration/core", mode: "affected", file: "src/core/route-input.ts", runs: false },
  { event: "push", base: "main", mode: "affected", file: "src/core/route-input.ts", runs: true },
  { event: "schedule", base: "main", mode: "full", file: "", runs: true },
  { event: "workflow_dispatch", base: "main", mode: "full", file: "", runs: true },
] as const)("runs every collected suite exactly once when native checks run ($event, $base, $file)", ({ event, base, mode, file, runs }) => {
  const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
  const job = workflow.jobs["windows-permission-tests"];
  expect(workflow.jobs["windows-native-preparation"].if).toBe("needs.build.outputs.platform_checks == 'true'");
  expect(job.if).toBe("needs.build.outputs.platform_checks == 'true' && needs.windows-native-preparation.result == 'success'");
  const plan: CiSuitePlan = { mode, reason: "platform gate", tests: [] };
  const selected = platformChecksRequired(event, plan, file ? [modifiedEntry(file)] : [], base);
  expect(selected).toBe(runs);
  if (!selected) return;

  const shards: number[] = job.strategy.matrix.shard;
  expect(shards).toEqual([...WINDOWS_TEST_SHARDS]);
  const full = committedPlan();
  const scheduled = shards.flatMap(shard => windowsShardFiles(full, shard, root));
  expect(scheduled.sort()).toEqual(collected);
});
