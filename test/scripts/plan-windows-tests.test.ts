import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { platformChecksRequired, type CiSuitePlan } from "../../scripts/run-ci-suite.mjs";
import { modifiedEntry } from "../../src/__tests__/support/git-diff-entry.js";
import { planWindowsTests } from "../../scripts/plan-windows-tests.js";
import { plannedWindowsFiles, WINDOWS_TEST_LISTS, windowsTestFiles } from "../../scripts/run-windows-test-list.mjs";
import {
  assertWindowsRemovalRecords, windowsCoverageDepartures, WINDOWS_TEST_REMOVALS, type ReadWindowsVersion,
} from "../../scripts/windows-test-inventory.mjs";

const [permission, native, application] = WINDOWS_TEST_LISTS;
const inventories = {
  [permission]: windowsTestFiles(readFileSync(permission, "utf8")),
  [native]: windowsTestFiles(readFileSync(native, "utf8")),
  [application]: windowsTestFiles(readFileSync(application, "utf8")),
};
describe("Windows shard planning", () => {
  it("balances by measured duration before file count", () => {
    const [heaviest] = inventories[permission];
    if (heaviest === undefined) throw new Error("Missing Windows permission suite");
    const result = planWindowsTests(inventories, { [heaviest]: 10_000_000 });
    expect(result.shards[0]?.files).toEqual([heaviest]);
    expect(result.shards[0]?.weightMs).toBe(10_001_000);
  });

  it("rejects a missing inventory member and a duplicate shard assignment", () => {
    const plan = planWindowsTests(inventories);
    const text = inventories[permission].join("\n");
    const incomplete = { ...plan, lists: { ...inventories, [permission]: inventories[permission].slice(1) } };
    expect(() => plannedWindowsFiles(permission, text, incomplete, 1)).toThrow("Invalid Windows plan");
    plan.shards[0]?.files.push(plan.shards[1]?.files[0] ?? "");
    expect(() => plannedWindowsFiles(permission, text, plan, 1)).toThrow("Windows shards must cover every selected test exactly once");
  });
});

it.each([
  { event: "pull_request", base: "main", mode: "affected", file: "src/core/route-input.ts", runs: true },
  { event: "pull_request", base: "main", mode: "affected", file: "src/ui/renderer/hooks/use-chat-state.ts", runs: false },
  { event: "pull_request", base: "integration/core", mode: "affected", file: "src/core/route-input.ts", runs: false },
  { event: "push", base: "main", mode: "affected", file: "src/core/route-input.ts", runs: true },
  { event: "schedule", base: "main", mode: "full", file: "", runs: true },
  { event: "workflow_dispatch", base: "main", mode: "full", file: "", runs: true },
] as const)("runs every committed suite exactly once when native checks run ($event, $base, $file)", ({ event, base, mode, file, runs }) => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const job = workflow.jobs["windows-permission-tests"];
  expect(workflow.jobs["windows-native-preparation"].if).toBe("needs.build.outputs.platform_checks == 'true'");
  expect(job.if).toBe("needs.build.outputs.platform_checks == 'true' && needs.windows-native-preparation.result == 'success'");
  const plan: CiSuitePlan = { mode, reason: "platform gate", tests: [] };
  const selected = platformChecksRequired(event, plan, file ? [modifiedEntry(file)] : [], base);
  expect(selected).toBe(runs);
  if (!selected) return;

  const shards: number[] = job.strategy.matrix.shard;
  const lanes: string[] = job.steps.flatMap((step: { run?: string }) =>
    step.run?.match(/run-windows-test-list\.mjs (config\/[\w-]+\.txt)$/u)?.[1] ?? []);
  expect(lanes).toEqual([...WINDOWS_TEST_LISTS]);
  const required = [...new Set(Object.values(inventories).flat())].sort();
  const full = planWindowsTests(inventories);
  const scheduled = shards.flatMap(shard => lanes.flatMap(lane =>
    plannedWindowsFiles(lane, readFileSync(lane, "utf8"), full, shard)));
  expect(scheduled.sort()).toEqual(required);
});

describe("last Windows lane removal", () => {
  const file = "src/permissions/__tests__/sensitive-paths-canonicalize.test.ts";
  const source = readFileSync(file, "utf8");
  const updated = { ...inventories, [permission]: inventories[permission].filter(path => path !== file) };
  function versions(record?: string, priorRecord?: string): ReadWindowsVersion {
    return (path, side) => {
      if (path === WINDOWS_TEST_REMOVALS) return (side === "before" ? priorRecord : record) ?? "{}";
      if (path === file) return side === "before" ? source : source.replace("// windows-permission\n", "");
      const list = WINDOWS_TEST_LISTS.find(list => list === path);
      return list ? `${(side === "before" ? inventories : updated)[list].join("\n")}\n` : null;
    };
  }

  it("rejects a matched declaration and row removal without a new record", () => {
    expect(source).toMatch(/^\/\/ windows-permission\n/u);
    const readVersion = versions();
    const departures = windowsCoverageDepartures(readVersion);
    expect([...departures]).toEqual([[file, permission]]);
    expect(() => assertWindowsRemovalRecords(departures, readVersion)).toThrow(file);
    const reused = JSON.stringify({ [file]: { reason: "Previously removed coverage" } });
    expect(() => assertWindowsRemovalRecords(departures, versions(reused, reused))).toThrow(file);
  });

  const recordFor = (record: Record<string, unknown>) => JSON.stringify({ [file]: record });
  const reason = "An equivalent canonicalization suite covers the boundary";
  const surviving = inventories[native][0] ?? "";
  it.each([
    ["an empty reason", { reason: "" }],
    ["a whitespace reason", { reason: " \t 　" }],
    ["a zero-width reason", { reason: "​" }],
    ["a format-character reason", { reason: "‍⁠﻿" }],
    ["a Hangul filler reason", { reason: "ㅤ" }],
    ["a blank Braille reason", { reason: "⠀" }],
    ["a wildcard replacement", { reason, replacement: "*" }],
    ["a nonexistent replacement", { reason, replacement: "src/permissions/__tests__/missing-canonicalize.test.ts" }],
    ["a replacement outside every lane", { reason, replacement: "src/core/__tests__/route-input.test.ts" }],
    ["a padded replacement", { reason, replacement: ` ${surviving}` }],
    ["a dotted replacement", { reason, replacement: `./${surviving}` }],
    ["the departing suite as its own replacement", { reason, replacement: file }],
  ])("rejects a record with %s", (_name, record) => {
    expect(Object.values(inventories).flat()).not.toContain("src/core/__tests__/route-input.test.ts");
    const readVersion = versions(recordFor(record));
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).toThrow(file);
  });

  it("accepts a revised record when a restored suite leaves again", () => {
    // A base record for a departing suite means the suite had returned to a base lane.
    const prior = recordFor({ reason: "Previously removed coverage" });
    const readVersion = versions(recordFor({ reason: "The restored suite moved to the canonicalization audit" }), prior);
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).not.toThrow();
  });

  it.each([
    ["unchanged", "Previously removed coverage"],
    ["padded", "  Previously removed coverage "],
    ["zero-width-marked", "Previously​ removed coverage⁠"],
  ])("rejects an %s historical reason for a suite that leaves again", (_name, revised) => {
    const readVersion = versions(recordFor({ reason: revised }), recordFor({ reason: "Previously removed coverage" }));
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).toThrow(file);
  });

  it("accepts a replacement that a surviving Windows lane collects at head", () => {
    expect(surviving).not.toBe("");
    const readVersion = versions(recordFor({ reason, replacement: surviving }));
    expect(() => assertWindowsRemovalRecords(windowsCoverageDepartures(readVersion), readVersion)).not.toThrow();
  });

  it("accepts every committed record against the lanes at head", () => {
    const records = JSON.parse(readFileSync(WINDOWS_TEST_REMOVALS, "utf8")) as Record<string, unknown>;
    const departures = new Map(Object.keys(records).map(path => [path, permission] as const));
    const head: ReadWindowsVersion = (path, side) => {
      if (path === WINDOWS_TEST_REMOVALS) return side === "after" ? JSON.stringify(records) : "{}";
      return WINDOWS_TEST_LISTS.includes(path as typeof permission) ? readFileSync(path, "utf8") : null;
    };
    expect(departures.size).toBeGreaterThan(0);
    expect(() => assertWindowsRemovalRecords(departures, head)).not.toThrow();
  });

  it("does not count a lane transfer between the three lists as a departure", () => {
    const original = versions();
    expect(windowsCoverageDepartures((path, side) => {
      const value = original(path, side);
      return path === application && side === "after" ? `${value ?? ""}${file}\n` : value;
    }).size).toBe(0);
  });
});
