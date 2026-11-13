import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planBackgroundShards, writeBackgroundShardPlan } from "../../scripts/plan-background-e2e-shards.mjs";

function collection() {
  const files = [
    ["ui/agent-tab-pip.spec.ts", 5],
    ["ui/browser-navigation-readiness.spec.ts", 5],
    ["ui/browser-observation-preview.spec.ts", 4],
    ["ui/terminal-observation.spec.ts", 2],
    ["ui/shared-lifetime.spec.ts", 12],
  ] as const;
  return {
    config: { fullyParallel: false, workers: 1, projects: [{ name: "background", retries: 0 }] },
    errors: [] as Array<{ message: string }>,
    suites: files.map(([file, count]) => ({
      title: file,
      specs: Array.from({ length: count }, (_, index) => ({
        id: `${file}-${index}`, file, title: `case ${index}`, tests: [{ projectName: "background" }],
      })),
      suites: [] as Array<{ title: string; specs: Array<{ id: string; file: string; title: string; tests: Array<{ projectName: string }> }> }>,
    })),
  };
}

describe("background partition planning", () => {
  it("covers every ID exactly once while leaving ordinary files to native sharding", () => {
    const input = collection();
    const plan = planBackgroundShards(input);
    expect(plan.matrix.include.slice(0, 96)).toEqual(Array.from({ length: 96 }, (_, index) => ({ id: index + 1, regularShard: index + 1, testList: "" })));
    expect(plan.manifest.totalPartitions).toBe(105);
    expect(plan.manifest.specialPartitions.map(partition => partition.testIds.length)).toEqual([2, 2, 1, 3, 2, 2, 2, 1, 1]);
    const assigned = [...plan.manifest.regularTestIds, ...plan.manifest.specialPartitions.flatMap(partition => partition.testIds)];
    const collected = input.suites.flatMap(suite => suite.specs.map(spec => spec.id));
    expect(assigned.sort()).toEqual(collected.sort());
    expect(new Set(assigned).size).toBe(collected.length);
    expect(plan.manifest.regularTestIds).toHaveLength(12);
    expect(plan.lists["special-files.txt"]).not.toContain("shared-lifetime");
  });

  it("derives groups from the current collection without fixed case counts or titles", () => {
    const input = collection();
    input.suites[0].specs.push({ id: "new-case", file: input.suites[0].title, title: "new independent scenario", tests: [{ projectName: "background" }] });
    const plan = planBackgroundShards(input);
    expect(plan.manifest.specialPartitions[2].testIds).toEqual(["ui/agent-tab-pip.spec.ts-4", "new-case"]);
    expect(plan.lists["partition-99.txt"]).toContain("new independent scenario");
  });

  it("keeps complete nested title paths in exact selectors", () => {
    const input = collection();
    const spec = input.suites[0].specs.pop();
    if (!spec) throw new Error("Expected a collected case");
    input.suites[0].suites.push({ title: "nested suite", specs: [spec] });
    const plan = planBackgroundShards(input);
    expect(plan.lists["partition-99.txt"]).toBe(`[background] › ${spec.file} › nested suite › ${spec.title}\n`);
  });

  it.each(["id", "title"] as const)("rejects duplicate %s values", (key) => {
    const input = collection();
    input.suites[0].specs[1][key] = input.suites[0].specs[0][key];
    expect(() => planBackgroundShards(input)).toThrow(/Duplicate background/);
  });

  it("rejects a complete title that would also select another case's suite prefix", () => {
    const input = collection();
    input.suites[0].suites.push({ title: "case 0", specs: [{
      id: "nested-case", file: input.suites[0].title, title: "child case", tests: [{ projectName: "background" }],
    }] });
    expect(() => planBackgroundShards(input)).toThrow(/also selects a nested case/);
  });

  it.each(["ambiguous › title", "line\nbreak", " trailing "])("rejects ambiguous selector %j", (title) => {
    const input = collection();
    input.suites[0].specs[0].title = title;
    expect(() => planBackgroundShards(input)).toThrow(/ambiguous test selector/);
  });

  it("refuses collection errors and missing independently partitioned files", () => {
    const input = collection();
    input.errors.push({ message: "collection failed" });
    expect(() => planBackgroundShards(input)).toThrow(/runner errors/);
    input.errors = [];
    input.suites.shift();
    expect(() => planBackgroundShards(input)).toThrow(/was not collected/);
  });

  it.each(["fullyParallel", "workers", "retries"])("refuses changed execution policy %s", (key) => {
    const input = collection();
    if (key === "fullyParallel") input.config.fullyParallel = true;
    else if (key === "workers") input.config.workers = 2;
    else input.config.projects[0].retries = 1;
    expect(() => planBackgroundShards(input)).toThrow(/one worker, ordered files and zero retries/);
  });

  it("refuses an already sharded inventory", () => {
    const input = { ...collection(), config: { ...collection().config, shard: { current: 1, total: 2 } } };
    expect(() => planBackgroundShards(input)).toThrow(/must be unsharded/);
  });

  it("writes the collection, canonical mapping, selectors and dynamic matrix outputs together", () => {
    const directory = mkdtempSync(join(tmpdir(), "background-plan-"));
    try {
      const source = join(directory, "input.json");
      const output = join(directory, "plan");
      const variables = join(directory, "outputs");
      writeFileSync(source, JSON.stringify(collection()));
      const plan = writeBackgroundShardPlan(source, output, variables);
      expect(JSON.parse(readFileSync(join(output, "collection.json"), "utf8"))).toEqual(collection());
      expect(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")).matrix).toEqual(plan.matrix);
      for (const [name, contents] of Object.entries(plan.lists)) expect(readFileSync(join(output, name), "utf8")).toBe(contents);
      expect(readFileSync(variables, "utf8")).toContain(`matrix=${JSON.stringify(plan.matrix)}\npartitions=105\nregular-shards=96\n`);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
