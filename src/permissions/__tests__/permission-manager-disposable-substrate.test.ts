import { randomUUID } from "node:crypto";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
// The dispatch input's `disposableSubstrate` must reach the reviewer as the `disposable-container` capability. The executor tests stub `dispatchReviewer`, so this is the one place the argument threading through `resolveReviewerSandboxCacheState` is pinned: drop it and guest calls silently regress to host grading.
import { afterEach, describe, expect, it } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import type { RiskClassifier, RiskVerdict, ToolInvocationContext } from "../reviewer/risk-classifier.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
const tmpFile = resources.tmpFileFactory("ave-pm-disposable-substrate-");

afterEach(async () => {
  await resources.cleanup();
});

function makeManager(): { pm: PermissionManager; seen: ToolInvocationContext[] } {
  const seen: ToolInvocationContext[] = [];
  const classifier: RiskClassifier = {
    classify(ctx: ToolInvocationContext): RiskVerdict {
      seen.push(ctx);
      return { level: "low", reason: "capturing classifier" };
    },
  };
  const pm = new PermissionManager(tmpFile("permissions.json"));
  setReviewerForTest(pm, {
    classifier,
    cache: resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(tmpFile("deferred-queue.jsonl")),
  });
  return { pm, seen };
}

const baseInput = {
  sessionId: "permission-manager-disposable-substrate-session",
  source: "builtin" as const,
  category: "shell" as const,
  pathFields: [] as string[],
  finalInput: { command: "uname -m" },
  executionCwd: process.cwd(),
  allowedDirectories: [] as string[],
  sensitivePathsAdjacent: [] as string[],
  trustOrigin: "llm-tool-arg" as const,
};

describe("PermissionManager.dispatchReviewer — disposable substrate reaches the classifier", () => {
  it("grades a brokered call against the disposable-container capability", async () => {
    const { pm, seen } = makeManager();
    await pm.dispatchReviewer("bash", {
      invocationId: randomUUID(),
      ...baseInput,
      disposableSubstrate: { authority: "workload-broker", id: "1".repeat(64) },
    }, undefined, { defer: "none" });
    expect(seen).toHaveLength(1);
    expect(seen[0].sandboxCapability).toMatchObject({
      kind: "disposable-container",
      confidence: "verified",
      confines: { filesystem: true, process: true, network: false },
    });
  });

  it("grades the same call without a substrate against the host capability", async () => {
    const { pm, seen } = makeManager();
    await pm.dispatchReviewer("bash", { ...baseInput, invocationId: randomUUID() }, undefined, { defer: "none" });
    expect(seen).toHaveLength(1);
    expect(seen[0].sandboxCapability.kind).not.toBe("disposable-container");
  });
});
