import { BaseSequencer, type TestSpecification, type Vitest } from "vitest/node";
import { describe, expect, it } from "vitest";
import BoundarySequencer from "../../config/vitest-sequencer.js";

function context(index = 1, count = 4): Vitest {
  return { config: { root: "/workspace", shard: { index, count } },
    cache: { getTestSpecificationResult: () => undefined } } as unknown as Vitest;
}
function spec(name: string, groupOrder = 0, projectName = "node"): TestSpecification {
  return { moduleId: `/workspace/${name}`, project: { name: projectName,
    config: { sequence: { groupOrder }, isolate: true } } } as unknown as TestSpecification;
}
const partitions = Array.from({ length: 12 }, (_, index) =>
  spec(`src/permissions/__tests__/powershell-encoded-unicode/boundary-${index}.test.ts`));
const ordinary = Array.from({ length: 31 }, (_, index) => spec(`src/__tests__/ordinary-${index}.test.ts`));

describe("exhaustive boundary scheduling", () => {
  it.each([1, 2, 3, 4, 8, 16])("collects every specification exactly once across %i shards", async count => {
    const files = [...partitions, ...ordinary];
    const results = await Promise.all(Array.from({ length: count }, (_, index) =>
      new BoundarySequencer(context(index + 1, count)).shard(files)));
    expect(new Set(results.flat())).toEqual(new Set(files));
    expect(results.flat()).toHaveLength(files.length);
    const sizes = results.map(result => result.filter(file => partitions.includes(file)).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    if (count === 4) expect(sizes).toEqual([3, 3, 3, 3]);
  });
  it("leaves ordinary sharding unchanged and does not mutate discovery", async () => {
    const files = [...ordinary];
    for (let index = 1; index <= 4; index++) {
      const ctx = context(index);
      expect(await new BoundarySequencer(ctx).shard(files)).toEqual(await new BaseSequencer(ctx).shard(files));
    }
    expect(files).toEqual(ordinary);
    expect(await new BoundarySequencer(context()).shard([])).toEqual([]);
  });
  it("starts long partitions first while retaining timing phases and ordinary order", async () => {
    const measured = spec("src/permissions/__tests__/permission-decision-cost.test.ts", 1, "permission-timing");
    const files = [...ordinary.slice(0, 3), measured, ...partitions.slice(0, 2)];
    const ctx = context();
    const baseline = await new BaseSequencer(ctx).sort(files);
    const result = await new BoundarySequencer(ctx).sort(files);
    expect(result.slice(0, 2)).toEqual(partitions.slice(0, 2));
    expect(result.at(-1)).toBe(measured);
    expect(result.filter(file => !partitions.includes(file))).toEqual(baseline.filter(file => !partitions.includes(file)));
    expect(new Set(result)).toEqual(new Set(files));
  });
  it("retains distinct projects of the same path", async () => {
    const first = partitions[0];
    const second = spec(first.moduleId.slice("/workspace/".length), 0, "other");
    const results = await Promise.all([1, 2].map(index =>
      new BoundarySequencer(context(index, 2)).shard([first, second])));
    expect(new Set(results.flat())).toEqual(new Set([first, second]));
    expect(results.flat()).toHaveLength(2);
  });
});
