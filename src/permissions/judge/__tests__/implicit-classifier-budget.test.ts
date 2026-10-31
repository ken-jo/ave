import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { PermissionManager } from "../../permission-manager.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { LlmRiskClassifier, type LlmReviewerProvider } from "../../reviewer/risk-classifier.js";
import { PermissionTestResources } from "../../__tests__/test-resources.js";
import { setReviewerForTest } from "../../../__tests__/support/reviewer-judge.js";
import { DEFAULT_JUDGE_SETTINGS } from "../judge-settings.js";
import { collectingAudit, judgeInvocation, judgeRecords, scriptedStage } from "./judge-request-fixture.js";

const resources = new PermissionTestResources();
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await resources.cleanup();
});

function subject(provider: LlmReviewerProvider) {
  const root = resources.makeTmpDir("ave-classifier-budget-");
  const manager = new PermissionManager(join(root, "permissions.json"));
  const classifier = new LlmRiskClassifier(provider, "review-model", "deny", {}, {
    maxAttempts: 1, baseDelayMs: 0, jitterPct: 0,
  });
  const audit = setReviewerForTest(manager, {
    classifier,
    cache: resources.makeVerdictCache(join(root, "cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(root, "denied.json")),
  });
  manager.setMode("auto");
  return { root, manager, classifier, audit };
}

describe("implicit reviewer execution budget", () => {
  it.each(["foreground", "headless", "shadow"] as const)("preserves a valid sixteen-second LOW response in %s", async (lane) => {
    vi.useFakeTimers();
    let began!: () => void;
    const providersStarted = new Promise<void>((resolve) => { began = resolve; });
    let calls = 0;
    const provider: LlmReviewerProvider = {
      async complete() {
        if (++calls === 2) began();
        await new Promise<void>((resolve) => setTimeout(resolve, 16_000));
        return { text: '{"level":"low","reason":"review complete"}', tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    };
    const current = subject(provider);
    let shadowAudit: ReturnType<typeof collectingAudit> | undefined;
    if (lane === "shadow") {
      shadowAudit = collectingAudit();
      const stage = scriptedStage();
      current.manager.setJudge({
        settings: { ...DEFAULT_JUDGE_SETTINGS, chain: [stage], mode: "shadow" },
        chain: [{ settings: stage, judge: { id: "observer", version: "1", async judge() { return { decision: "deny", rationale: "shadow observation" }; } } }],
        breaker: current.manager.getJudgeBreaker(), audit: shadowAudit.logger,
      });
    }
    const invocation = judgeInvocation({
      executionCwd: current.root, allowedDirectories: [current.root], finalInput: { command: "echo reviewed" },
    });
    const direct = current.classifier.classifyWithTrace(invocation);
    const throughChain = current.manager.dispatchReviewer("bash", {
      invocationId: `sixteen-second-${lane}`, sessionId: "budget-session",
      source: "builtin", category: "shell", pathFields: [], finalInput: invocation.finalInput,
      executionCwd: current.root, allowedDirectories: [current.root], sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
    }, undefined, { lane: lane === "headless" ? "headless" : "foreground-auto" });
    await providersStarted;
    let resolved = false;
    void throughChain.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    const [before, after] = await Promise.all([direct, throughChain]);
    expect(before).toMatchObject({ outcome: "fresh", finalVerdict: { level: "low" } });
    expect(after).toMatchObject({ outcome: "fresh", verdict: { level: "low" }, judge: { judged: true, applied: true, decision: "allow" } });
    expect(calls).toBe(2);
    const records = shadowAudit ? judgeRecords(shadowAudit) : current.audit.active.map((entry) => {
      if (entry.decision !== "judge") throw new Error("Expected judge audit");
      return entry.judgeRecord;
    });
    expect(records.at(-1)).toMatchObject({ applied: true, fallback: null, latencyMs: 16_000 });
    expect(current.manager.getJudgeBreaker().snapshot("budget-session")).toEqual({ consecutive: 0, total: 0, open: false });
  });

  it("forwards caller cancellation while the classifier owns its budget", async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let classifierSignal: AbortSignal | undefined;
    const current = subject({
      async complete(params) {
        classifierSignal = params.abortSignal;
        began();
        return new Promise<never>((_, reject) => {
          params.abortSignal?.addEventListener("abort", () => reject(params.abortSignal?.reason), { once: true });
        });
      },
    });
    const controller = new AbortController();
    const pending = current.manager.dispatchReviewer("bash", {
      invocationId: "cancel-classifier-budget", sessionId: "budget-session", source: "builtin", category: "shell", pathFields: [],
      finalInput: { command: "echo reviewed" }, executionCwd: current.root, allowedDirectories: [current.root], sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
    }, undefined, { lane: "foreground-auto", abortSignal: controller.signal });
    await started;
    controller.abort(new Error("caller stopped"));
    expect(await pending).toMatchObject({ outcome: "error", judge: { judged: true, decision: "deny" } });
    expect(classifierSignal?.aborted).toBe(true);
    expect(current.manager.getJudgeBreaker().snapshot("budget-session")).toEqual({ consecutive: 0, total: 0, open: false });
  });
});
