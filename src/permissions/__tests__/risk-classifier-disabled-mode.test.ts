import { describe, it, expect } from "vitest";
import { createRiskClassifier, ReviewerDispatchError } from "../reviewer/risk-classifier.js";
import { makeRiskClassifierContext as ctx } from "./test-helpers.js";

describe("disabled automatic review", () => {
  it.each(["read", "write", "shell", "network", "meta"] as const)("produces no automatic verdict for %s", category => {
    const classifier = createRiskClassifier({ mode: "disabled" });
    expect(() => classifier.classify(ctx({ category }))).toThrow(ReviewerDispatchError);
    expect(() => classifier.classify(ctx({ category }))).toThrow("automatic review is unavailable");
  });

  it.each(["user-keyboard", "plugin-emitted", "llm-tool-arg", "file-content"] as const)("does not grant authority to %s", trustOrigin => {
    const classifier = createRiskClassifier({ mode: "disabled" });
    expect(() => classifier.classify(ctx({ trustOrigin }))).toThrow("Permission reviewer is disabled");
  });
});
