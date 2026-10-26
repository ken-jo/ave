import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { PermissionManager } from "../permission-manager.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import type { RiskVerdict } from "../reviewer/risk-classifier.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
afterEach(() => resources.cleanup());

type DecisionCase = {
  name: string;
  lane: "headless" | "foreground";
  threshold: "low" | "medium";
  verdict: RiskVerdict;
  decision: "allow" | "ask" | "deny";
};

const CASES: DecisionCase[] = [
  { name: "headless low allows", lane: "headless", threshold: "low", verdict: { level: "low", reason: "low risk" }, decision: "allow" },
  { name: "headless medium denies", lane: "headless", threshold: "medium", verdict: { level: "medium", reason: "medium risk" }, decision: "deny" },
  { name: "headless high denies", lane: "headless", threshold: "medium", verdict: { level: "high", reason: "high risk" }, decision: "deny" },
  { name: "foreground low allows", lane: "foreground", threshold: "low", verdict: { level: "low", reason: "low risk" }, decision: "allow" },
  { name: "foreground medium asks above a low threshold", lane: "foreground", threshold: "low", verdict: { level: "medium", reason: "medium risk" }, decision: "ask" },
  { name: "foreground medium allows at the inclusive medium threshold", lane: "foreground", threshold: "medium", verdict: { level: "medium", reason: "medium risk" }, decision: "allow" },
  { name: "foreground medium asks when explicit approval is required", lane: "foreground", threshold: "medium", verdict: { level: "medium", reason: "explicit approval required", requiresExplicitApproval: true }, decision: "ask" },
  { name: "foreground high asks", lane: "foreground", threshold: "medium", verdict: { level: "high", reason: "high risk" }, decision: "ask" },
];

describe("PermissionManager builtin judge decisions", () => {
  it.each(CASES)("$name with preserved verdict and audit evidence", async ({ lane, threshold, verdict, decision }) => {
    const root = resources.makeTmpDir("ave-manager-judge-decision-");
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("auto");
    manager.setInteractiveAutoApprove(threshold);
    const queue = new DeferredQueue(join(root, "deferred.jsonl"));
    const audit = setReviewerForTest(manager, {
      classifier: { classify: () => verdict },
      cache: resources.makeVerdictCache(join(root, "verdicts.jsonl")), deferredQueue: queue,
    });
    const input = {
      sessionId: "builtin-decision-session", source: "builtin" as const, category: "write" as const,
      pathFields: ["path"], finalInput: { path: join(root, "file.txt") },
      executionCwd: root, allowedDirectories: [root], sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    for (const expectedOutcome of ["fresh", "cache"] as const) {
      const result = await manager.dispatchReviewer("write_probe", input, undefined, {
        defer: lane === "headless" ? "medium-high" : "none",
      });
      expect(result.verdict).toEqual(verdict);
      expect(result.outcome).toBe(expectedOutcome);
      expect(result.judge).toMatchObject({ judged: true, decision, applied: true, source: "judge" });
    }
    expect(audit.active).toHaveLength(2);
    expect(audit.active).toEqual(expect.arrayContaining([expect.objectContaining({
      decision: "judge", judgeRecord: expect.objectContaining({ decision, lane }),
    })]));
    expect(audit.shadow).toHaveLength(0);
    expect(queue.listPending()).toHaveLength(lane === "headless" && decision === "deny" ? 2 : 0);
  });
});
