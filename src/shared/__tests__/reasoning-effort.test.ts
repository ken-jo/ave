import { describe, expect, it } from "vitest";
import { assertReasoningEffort, reasoningEffortForBudget } from "../reasoning-effort.js";

describe("persisted reasoning intent", () => {
  it.each([
    [0, "low"], [4_000, "low"], [6_000, "low"], [6_001, "medium"],
    [8_000, "medium"], [10_000, "medium"], [12_000, "medium"],
    [16_000, "high"], [24_000, "high"], [32_000, "xhigh"],
    [48_000, "xhigh"], [64_000, "max"], [999_999, "max"],
  ] as const)("derives %i as %s", (budget, effort) => {
    expect(reasoningEffortForBudget(budget)).toBe(effort);
  });

  it.each([-1, NaN, Infinity, 1.5])("rejects invalid internal budget %s", (budget) => {
    expect(() => reasoningEffortForBudget(budget)).toThrow("Invalid reasoning budget");
  });

  it("rejects unknown internal effort instead of substituting another level", () => {
    expect(() => assertReasoningEffort("ultra")).toThrow("Invalid reasoning effort");
  });
});
