import { describe, expect, it } from "vitest";
import { planBrowserPipStack } from "../browser-pip-layout.js";

describe("bounded browser preview packing", () => {
  it.each([
    [0, 800, false, [0, 0, 0]],
    [3, 616, false, [3, 0, 0]],
    [3, 500, false, [2, 1, 0]],
    [3, 296, false, [1, 2, 0]],
    [4, 296, false, [1, 1, 2]],
    [3, 136, false, [0, 3, 0]],
    [4, 88, false, [0, 1, 3]],
    [4, 40, false, [0, 0, 4]],
    [4, 39, false, [0, 0, 0]],
    [3, 800, true, [0, 3, 0]],
    [4, 88, true, [0, 1, 3]],
  ] as const)("packs %i tabs into %ipx with compact=%s", (count, height, compact, expected) => {
    const plan = planBrowserPipStack(count, compact, { height, previewHeight: 200, chipHeight: 40, gap: 8 });
    expect([plan.previewCount, plan.chipCount, plan.summaryCount]).toEqual(expected);
    const visible = plan.previewCount + plan.chipCount + Number(plan.summaryCount > 0);
    expect(plan.previewCount * 200 + (visible - plan.previewCount) * 40 + Math.max(0, visible - 1) * 8).toBeLessThanOrEqual(height);
    if (visible) expect(plan.previewCount + plan.chipCount + plan.summaryCount).toBe(count);
  });
});
