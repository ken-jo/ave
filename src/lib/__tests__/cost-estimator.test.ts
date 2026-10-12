import { describe, it, expect } from "vitest";
import { costTier, estimateTokens, estimateTurnTokens, formatCostBadge } from "../cost-estimator.js";

describe("cost-estimator", () => {
  it("re-exports the shared engine heuristic, including Korean weighting", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("abcde")).toBe(3);
    expect(estimateTokens("안녕".repeat(100))).toBe(66);
  });

  it("estimateTurnTokens sums history + draft and takes the output limit", () => {
    const out = estimateTurnTokens({
      historySerialized: ["{\"role\":\"user\",\"content\":\"hi\"}"],
      draft: "hello world",
      maxOutputTokens: 1000,
    });
    expect(out.inputTokens).toBeGreaterThan(0);
    expect(out.outputTokens).toBe(1000);
  });

  it("zero draft and no history yield no tokens", () => {
    const out = estimateTurnTokens({
      historySerialized: [],
      draft: "",
      maxOutputTokens: 0,
    });
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
  });

  it("costTier bucketing matches the spec thresholds", () => {
    expect(costTier(0.001)).toBe("trivial");
    expect(costTier(0.05)).toBe("low");
    expect(costTier(0.5)).toBe("medium");
    expect(costTier(2)).toBe("high");
  });

  it("formatCostBadge renders reasonable strings", () => {
    expect(formatCostBadge(0.001)).toMatch(/^~\$/);
    // Digits come from the shared `formatCost`; only the `~` is this badge's.
    expect(formatCostBadge(0.05)).toBe("~$0.050");
    expect(formatCostBadge(1.5)).toBe("~$1.50");
  });
});
