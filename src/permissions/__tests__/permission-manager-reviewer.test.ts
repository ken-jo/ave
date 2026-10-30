import { recordApproval, lookupApproval, canonicalStringify, captureApprovalWorkingDirectory, __resetSessionStoreForTest } from "../user-approval-store.js";
import { randomUUID } from "node:crypto";
import { setReviewerForTest, wireJudgeForTest } from "../../__tests__/support/reviewer-judge.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import {
  isReviewerAutoDecisionOutcome,
  PermissionManager,
} from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import type { RecentlyDeniedStore } from "../reviewer/recently-denied.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";
import {
  RuleBasedRiskClassifier,
  LlmRiskClassifier,
  ReviewerDispatchError,
  type RiskClassifier,
  type ToolInvocationContext,
  type RiskVerdict,
} from "../reviewer/risk-classifier.js";
import { BashTool } from "../../tools/shell-tools.js";
import { buildHostShellExecutionPlan } from "../host-shell-execution-plan.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetWrappedPluginWorkersForTest,
  markPluginWorkerWrapped,
  unmarkPluginWorkerWrapped,
  setActiveSandboxCapability,
} from "../sandbox-capability.js";
import { PermissionTestResources } from "./test-resources.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

const resources = new PermissionTestResources();

const tmpFile = resources.tmpFileFactory("ave-pm-reviewer-");

afterEach(async () => {
  await resources.cleanup();
});

function allowedDir(path: string): string {
  return caseFoldForMatch(canonicalizePathForMatch(path));
}

function makeManager(): {
  pm: PermissionManager;
  cache: VerdictCache;
  queue: RecentlyDeniedStore;
  classifier: RiskClassifier;
} {
  const pm = new PermissionManager(tmpFile("permissions.json"));
  pm.setMode("auto");
  const cache = resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl"));
  const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
  const classifier = new RuleBasedRiskClassifier();
  setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
  return { pm, cache, queue, classifier };
}

describe("PermissionManager.dispatchReviewer", () => {
  let pm: PermissionManager;
  let cache: VerdictCache;
  let queue: RecentlyDeniedStore;

  beforeEach(() => {
    ({ pm, cache, queue } = makeManager());
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetWrappedPluginWorkersForTest();
  });

  it.each([
    ['echo "$TARGET"', "low"],
    ["rm -rf ./build", "high"],
    ["eval 'printf ready'", "medium"],
  ] as const)("reuses scoped approval while retaining the fresh risk of %s", async (command, expectedRisk) => {
    pm.setMode("auto");

    const classify = vi.fn(() => ({ level: "medium" as const, reason: "reviewed once" }));
    setReviewerForTest(pm, { classifier: { classify }, cache, recentlyDenied: queue });
    const cwd = process.cwd();
    const sessionId = "shell-floor-memory";
    const finalInput = { command };
    const plan = buildHostShellExecutionPlan({ platform: "darwin", requestedSandbox: true,
      activeCapability: { kind: "asrt", confidence: "verified", platform: "darwin", reason: "confined",
        confines: { filesystem: true, process: true, network: true } } });
    const permissionDecision = pm.checkDetailed("bash", "builtin", "shell", null, {
      ruleSubject: { kind: "shell", dialect: "bash", command, cwd }, shellExecution: { runsSandboxed: true }, hostShellExecutionPlan: plan,
    });
    const lookup = vi.spyOn(cache, "lookup");
    const store = vi.spyOn(cache, "store");
    try {
      await recordApproval("bash", canonicalStringify(finalInput), "builtin", {
        scope: "session", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard",
        sessionId, workingDirectoryIdentity: captureApprovalWorkingDirectory(cwd).identity,
      });
      expect(await lookupApproval("bash", canonicalStringify(finalInput), "builtin", "user-keyboard", undefined, cwd, sessionId)).not.toBeNull();
      for (let index = 0; index < 2; index += 1) {
        const reviewed = await pm.dispatchReviewer("bash", {
          invocationId: randomUUID(), sessionId, source: "builtin", category: "shell", pathFields: [],
          finalInput, executionCwd: cwd, allowedDirectories: [cwd], sensitivePathsAdjacent: [],
          trustOrigin: "user-keyboard", hostShellExecutionPlan: plan, permissionDecision,
        }, undefined, { lane: "foreground-auto" });
        expect(reviewed.outcome).toBe("approval-memory");
        expect(reviewed.verdict.level).toBe(expectedRisk);
      }
      expect(classify).not.toHaveBeenCalled();
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(store).not.toHaveBeenCalled();
    } finally { __resetSessionStoreForTest(); }
  });

  it("hasReviewer = false until setReviewer called", () => {
    const fresh = new PermissionManager(tmpFile("permissions.json"));
    expect(fresh.hasReviewer()).toBe(false);
  });

  it("hasReviewer = true after setReviewer", () => {
    expect(pm.hasReviewer()).toBe(true);
  });

  it("LOW verdict — no deferred entry, cacheReason='miss-not-found'", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("low");
    expect(r.cacheReason).toBe("miss-not-found");
  });

  it("HIGH verdict produces evidence without persisting a runnable request", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/etc/passwd" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("high");
    expect(await queue.list()).toHaveLength(0);
  });

  it("MEDIUM verdict produces evidence without persisting a request", async () => {
    const r = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "plugin",
      category: "write",
      pathFields: [],
      finalInput: { content: "updated state" },
      ownerPluginSandboxRoot: "/Users/example/work/plugin-state",
      pluginId: "pathless-writer",
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("medium");
    expect(await queue.list()).toHaveLength(0);
  });

  it("MEDIUM headless verdict does not persist a request", async () => {
    const r = await pm.dispatchReviewer(
      "fs_write",
      {
        invocationId: randomUUID(),
        sessionId: "permission-manager-reviewer-session",
        source: "plugin",
        category: "write",
        pathFields: [],
        finalInput: { content: "updated state" },
        ownerPluginSandboxRoot: "/Users/example/work/plugin-state",
        pluginId: "pathless-writer",
        allowedDirectories: [allowedDir("/Users/example/work")],
        executionCwd: process.cwd(),
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg" as const,
      },
      undefined,
      { lane: "headless" },
    );
    expect(r.verdict.level).toBe("medium");
    expect(await queue.list()).toHaveLength(0);
  });

  it("second dispatch hits cache", async () => {
    const input = {
      sessionId: "permission-manager-reviewer-session",
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    const first = await pm.dispatchReviewer("fs_write", { ...input, invocationId: randomUUID() });
    expect(first.cacheReason).toBe("miss-not-found");
    const second = await pm.dispatchReviewer("fs_write", { ...input, invocationId: randomUUID() });
    expect(second.cacheReason).toBe("hit");
    expect(second.verdict).toEqual(first.verdict);
  });

  it("uses the sealed full-ASRT host plan for reviewer capability and cache partitioning", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn((ctx: ToolInvocationContext): RiskVerdict => (
        ctx.sandboxCapability.kind === "asrt"
          ? { level: "low", reason: "sealed full ASRT" }
          : { level: "high", reason: "unconfined shell" }
      )),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const fullPlan = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "full ASRT sealed before review",
        confines: { filesystem: true, process: true, network: true },
      },
    });
    const explicitOffPlan = buildHostShellExecutionPlan({
      platform: "darwin",
      requestedSandbox: false,
      activeCapability: {
        kind: "none",
        confidence: "verified",
        platform: "darwin",
        reason: "sandbox explicitly off",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    const base = {
      source: "builtin" as const,
      category: "shell" as const,
      pathFields: [],
      finalInput: { command: "echo sealed-plan" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };

    // No process-global active capability is published: the reviewer must still receive the invocation's sealed full-ASRT plan, not recompute `none`.
    const first = await pm.dispatchReviewer("bash", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      hostShellExecutionPlan: fullPlan,
    }, undefined, { lane: "foreground-auto" });
    const samePlan = await pm.dispatchReviewer("bash", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      hostShellExecutionPlan: fullPlan,
    }, undefined, { lane: "foreground-auto" });
    const changedPlan = await pm.dispatchReviewer("bash", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      hostShellExecutionPlan: explicitOffPlan,
    }, undefined, { lane: "foreground-auto" });

    expect(first.verdict.level).toBe("low");
    expect(samePlan.cacheReason).toBe("hit");
    expect(changedPlan.verdict.level).toBe("high");
    expect(changedPlan.cacheReason).not.toBe("hit");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
    expect(classifier.classify).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sandboxCapability: fullPlan.capability }),
    );
    expect(classifier.classify).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sandboxCapability: explicitOffPlan.capability }),
    );
  });
  it("does not replay a plugin-worker relaxed verdict after the worker un-wraps", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    const classifier: RiskClassifier = {
      classify: vi.fn((ctx: ToolInvocationContext): RiskVerdict => (
        ctx.sandboxCapability.kind === "asrt"
          ? { level: "low", reason: "wrapped worker relaxation" }
          : { level: "high", reason: "unwrapped worker must re-review" }
      )),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const input = {
      sessionId: "permission-manager-reviewer-session",
      source: "plugin" as const,
      category: "network" as const,
      pathFields: [],
      pluginId: "local-indexer",
      workerId: "embed",
      finalInput: { url: "https://api.example.com/index" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
      conversationContext: { recentUserMessage: "인덱스 상태를 확인해줘." },
    };

    markPluginWorkerWrapped("local-indexer", "embed");
    const wrapped = await pm.dispatchReviewer("index_fetch", { ...input, invocationId: randomUUID() });
    expect(wrapped.cacheReason).toBe("miss-not-found");
    expect(wrapped.verdict.level).toBe("low");

    unmarkPluginWorkerWrapped("local-indexer", "embed");
    const unwrapped = await pm.dispatchReviewer("index_fetch", { ...input, invocationId: randomUUID() });
    expect(unwrapped.cacheReason).toBe("miss-stale");
    expect(unwrapped.verdict.level).toBe("high");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it("does not return or cache a relaxed verdict if the worker unwraps during async classification", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
      confines: { filesystem: true, process: true, network: true },
    });
    let firstCall = true;
    const classifier: RiskClassifier = {
      classify: vi.fn(async (ctx: ToolInvocationContext): Promise<RiskVerdict> => {
        if (firstCall) {
          firstCall = false;
          expect(ctx.sandboxCapability.kind).toBe("asrt");
          unmarkPluginWorkerWrapped("local-indexer", "embed");
          await Promise.resolve();
          return { level: "low", reason: "stale wrapped worker relaxation" };
        }
        return ctx.sandboxCapability.kind === "asrt"
          ? { level: "low", reason: "wrapped worker relaxation" }
          : { level: "high", reason: "unwrapped worker must re-review" };
      }),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const input = {
      sessionId: "permission-manager-reviewer-session",
      source: "plugin" as const,
      category: "network" as const,
      pathFields: [],
      pluginId: "local-indexer",
      workerId: "embed",
      finalInput: { url: "https://api.example.com/index" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
      conversationContext: { recentUserMessage: "인덱스 상태를 확인해줘." },
    };

    markPluginWorkerWrapped("local-indexer", "embed");
    const raced = await pm.dispatchReviewer("index_fetch", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
    expect(raced.cacheReason).toBe("miss-not-found");
    expect(raced.verdict).toEqual({
      level: "high",
      reason: "reviewer sandbox state changed during classification — fail-safe re-review required",
    });

    const unwrapped = await pm.dispatchReviewer("index_fetch", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
    expect(unwrapped.cacheReason).toBe("miss-not-found");
    expect(unwrapped.verdict.level).toBe("high");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it("partitions reviewer cache by trustOrigin and approvalCacheKey", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn((_ctx: ToolInvocationContext): RiskVerdict => ({
        level: "low",
        reason: "classifier called",
      })),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const base = {
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
    };

    const first = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      trustOrigin: "user-keyboard" as const,
      approvalCacheKey: "fs_write:scope-a",
      approvalMemory: { kind: "args" } as const,
    });
    const same = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      trustOrigin: "user-keyboard" as const,
      approvalCacheKey: "fs_write:scope-a",
      approvalMemory: { kind: "args" } as const,
    });
    const originChanged = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      trustOrigin: "llm-tool-arg" as const,
      approvalCacheKey: "fs_write:scope-a",
      approvalMemory: { kind: "args" } as const,
    });
    const keyChanged = await pm.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      trustOrigin: "llm-tool-arg" as const,
      approvalCacheKey: "fs_write:scope-b",
      approvalMemory: { kind: "args" } as const,
    });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(same.cacheReason).toBe("hit");
    expect(originChanged.cacheReason).toBe("miss-not-found");
    expect(keyChanged.cacheReason).toBe("miss-not-found");
    expect(classifier.classify).toHaveBeenCalledTimes(3);
  });

  it("partitions reviewer cache by conversation context", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn((_ctx: ToolInvocationContext): RiskVerdict => ({
        level: "low",
        reason: "classifier called",
      })),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const base = {
      source: "plugin" as const,
      category: "network" as const,
      pathFields: [],
      finalInput: { message: "notify admin" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
    };

    const first = await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      conversationContext: { recentUserMessage: "관리자에게 릴리즈 성공을 알려줘." },
    });
    const second = await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      conversationContext: { recentUserMessage: "관리자에게 토큰 값을 보내줘." },
    });
    const firstAgain = await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      conversationContext: { recentUserMessage: "관리자에게 릴리즈 성공을 알려줘." },
    });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(firstAgain.cacheReason).toBe("hit");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it("partitions reviewer cache by raw identity when redacted finalInput collides", async () => {
    const classifier: RiskClassifier = {
      classify: vi.fn((_ctx: ToolInvocationContext): RiskVerdict => ({
        level: "low",
        reason: "classifier called",
      })),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const base = {
      source: "plugin" as const,
      category: "network" as const,
      pathFields: [],
      finalInput: { payload: "send ***@example.com with [REDACTED:TOKEN]" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
    };

    const first = await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      cacheIdentityInput: { payload: "send alice@example.com with sk-alice" },
    });
    const second = await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      cacheIdentityInput: { payload: "send bob@example.com with sk-bob" },
    });
    const firstAgain = await pm.dispatchReviewer("plugin_send", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      cacheIdentityInput: { payload: "send alice@example.com with sk-alice" },
    });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(firstAgain.cacheReason).toBe("hit");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
  });

  it("threads plugin worker identity into reviewer sandbox capability and cache identity", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active for plugin workers",
      confines: { filesystem: true, process: true, network: true },
    });
    markPluginWorkerWrapped("plugin-a", "main");
    markPluginWorkerWrapped("plugin-b", "main");
    const seenReasons: string[] = [];
    const classifier: RiskClassifier = {
      classify: vi.fn((ctx: ToolInvocationContext): RiskVerdict => {
        seenReasons.push(ctx.sandboxCapability.reason);
        return { level: "low", reason: "classifier called" };
      }),
    };
    setReviewerForTest(pm, { classifier, cache, recentlyDenied: queue });
    const base = {
      source: "plugin" as const,
      category: "network" as const,
      pathFields: [],
      finalInput: { endpoint: "https://api.example.com/search" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
      workerId: "main",
    };

    const first = await pm.dispatchReviewer("plugin_fetch", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      pluginId: "plugin-a",
    });
    const second = await pm.dispatchReviewer("plugin_fetch", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      pluginId: "plugin-b",
    });
    const firstAgain = await pm.dispatchReviewer("plugin_fetch", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      ...base,
      pluginId: "plugin-a",
    });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(firstAgain.cacheReason).toBe("hit");
    expect(classifier.classify).toHaveBeenCalledTimes(2);
    expect(seenReasons[0]).toContain("plugin worker 'plugin-a/main' ASRT-wrapped");
    expect(seenReasons[1]).toContain("plugin worker 'plugin-b/main' ASRT-wrapped");
  });

  it("does not reuse reversible shell reviewer cache for destructive shell commands", async () => {
    const bash = new BashTool();
    const allowedDirectories = [allowedDir("/Users/example/work")];
    const firstInput = { command: "echo ok" };
    const destructiveInput = { command: "rm -rf ./build" };
    const first = await pm.dispatchReviewer("bash", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "builtin",
      category: "shell",
      pathFields: [],
      finalInput: firstInput,
      allowedDirectories,
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg",
      approvalCacheKey: `bash:${bash.approvalCacheKey(firstInput)}`,
      approvalMemory: { kind: "args" } as const,
    });
    const second = await pm.dispatchReviewer("bash", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "builtin",
      category: "shell",
      pathFields: [],
      finalInput: destructiveInput,
      allowedDirectories,
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg",
      approvalCacheKey: `bash:${bash.approvalCacheKey(destructiveInput)}`,
      approvalMemory: { kind: "args" } as const,
    });

    expect(first.verdict.level).toBe("low");
    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(second.verdict.level).toBe("high");
    expect(second.verdict.reason).toContain("destructive");
  });

  it("settings change invalidates stale cache (different allowedDirectories)", async () => {
    const ctxA = {
      sessionId: "permission-manager-reviewer-session",
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    await pm.dispatchReviewer("fs_write", { ...ctxA, invocationId: randomUUID() });
    // Same input, different allowedDirectories context.
    const ctxB = { sessionId: "permission-manager-reviewer-session", ...ctxA, allowedDirectories: [allowedDir("/different")] };
    const r = await pm.dispatchReviewer("fs_write", { ...ctxB, invocationId: randomUUID() });
    expect(r.cacheReason).toBe("miss-stale");
  });

  it("reviewer cache is partitioned by reviewer wiring settings", async () => {
    const classifierA: RiskClassifier = {
      classify: vi.fn(() => ({ level: "low", reason: "classifier A" })),
    };
    const classifierB: RiskClassifier = {
      classify: vi.fn(() => ({ level: "medium", reason: "classifier B" })),
    };
    setReviewerForTest(pm, {
      classifier: classifierA,
      cache,
      recentlyDenied: queue,
      cacheScope: { mode: "rule", model: "a" },
    });
    const input = {
      sessionId: "permission-manager-reviewer-session",
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    const first = await pm.dispatchReviewer("fs_write", { ...input, invocationId: randomUUID() });
    setReviewerForTest(pm, {
      classifier: classifierB,
      cache,
      recentlyDenied: queue,
      cacheScope: { mode: "llm", model: "b" },
    });
    const second = await pm.dispatchReviewer("fs_write", { ...input, invocationId: randomUUID() });

    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-stale");
    expect(second.verdict.reason).toBe("classifier B");
    expect(classifierB.classify).toHaveBeenCalledOnce();
  });

  it("reclassifies a cached verdict from before host policy facts were supplied", async () => {
    const classify = vi.fn(() => ({ level: "medium" as const, reason: "current review" }));
    setReviewerForTest(pm, { classifier: { classify }, cache, recentlyDenied: queue });
    const store = cache.store.bind(cache);
    vi.spyOn(cache, "store").mockImplementationOnce((key, context, verdict) => {
      const { reviewerFrameworkVersion: _obsolete, ...oldScope } = context.scope;
      return store(key, { ...context, scope: oldScope }, verdict);
    });
    const input = {
      sessionId: "permission-manager-reviewer-session",
      source: "builtin" as const,
      category: "write" as const,
      pathFields: ["path"],
      finalInput: { path: "/Users/example/work/note.md" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    };
    await pm.dispatchReviewer("fs_write", { ...input, invocationId: randomUUID() });
    const result = await pm.dispatchReviewer("fs_write", { ...input, invocationId: randomUUID() });
    expect(result.cacheReason).toBe("miss-stale");
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it("rejects an automated dispatch when the judge engine was never wired", async () => {
    const fresh = new PermissionManager(tmpFile("permissions.json"));
    await expect(fresh.dispatchReviewer("fs_write", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/x" },
      allowedDirectories: [],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    })).rejects.toThrow("Permission judge is not wired");
  });

  it("async classifier (LLM) is awaited", async () => {
    const asyncClassifier: RiskClassifier = {
      classify: vi.fn(
        async (_ctx: ToolInvocationContext): Promise<RiskVerdict> => ({
          level: "high",
          reason: "async high",
        }),
      ),
    };
    setReviewerForTest(pm, { classifier: asyncClassifier, cache, recentlyDenied: queue });
    const r = await pm.dispatchReviewer("any_tool", {
      invocationId: randomUUID(),
      sessionId: "permission-manager-reviewer-session",
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/x" },
      allowedDirectories: [allowedDir("/Users/example/work")],
      executionCwd: process.cwd(),
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });
    expect(r.verdict.level).toBe("high");
    expect(r.verdict.reason).toBe("async high");
    expect(asyncClassifier.classify).toHaveBeenCalled();
  });
});

// MAJOR-1 R2: abortSignal end-to-end dispatchReviewer → LlmRiskClassifier

describe("MAJOR-1 R2: dispatchReviewer threads abortSignal to LlmRiskClassifier.classifyWithTrace", () => {
  it("forwards caller cancellation through the judge stage signal", async () => {
    const { pm } = makeManager();
    const ac = new AbortController();

    let capturedOpts: { abortSignal?: AbortSignal } | undefined;
    const { LlmRiskClassifier } = await import("../reviewer/risk-classifier.js");
    const providerStub = {
      complete: vi.fn(({ abortSignal }: { abortSignal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        if (!abortSignal) throw new Error("Reviewer signal missing");
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      })),
    };
    const llmClassifier = new LlmRiskClassifier(providerStub, "gpt-4o-mini");
    const origClassifyWithTrace = llmClassifier.classifyWithTrace.bind(llmClassifier);
    vi.spyOn(llmClassifier, "classifyWithTrace").mockImplementation(
      async (ctx: import("../reviewer/risk-classifier.js").ToolInvocationContext, opts?: { abortSignal?: AbortSignal }) => {
        capturedOpts = opts;
        return origClassifyWithTrace(ctx, opts);
      },
    );

    const cache = resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
    setReviewerForTest(pm, { classifier: llmClassifier, cache, recentlyDenied: queue });

    const dispatch = pm.dispatchReviewer(
      "bash",
      {
        invocationId: randomUUID(),
        sessionId: "permission-manager-reviewer-session",
        source: "builtin",
        category: "shell",
        pathFields: [],
        finalInput: { command: "echo hello" },
        allowedDirectories: [allowedDir("/Users/example/work")],
        executionCwd: process.cwd(),
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      },
      undefined,
      { abortSignal: ac.signal },
    );

    await vi.waitFor(() => expect(capturedOpts?.abortSignal).toBeDefined());
    const reason = new Error("Caller cancelled review");
    ac.abort(reason);
    await dispatch;
    expect(capturedOpts?.abortSignal?.aborted).toBe(true);
    expect(capturedOpts?.abortSignal?.reason).toBe(reason);
  });

  it("mid-call abort → classify throws and dispatchReviewer returns HIGH (fallbackOnError=deny)", async () => {
    const { pm } = makeManager();
    const ac = new AbortController();

    const { LlmRiskClassifier } = await import("../reviewer/risk-classifier.js");
    const providerStub = {
      complete: vi.fn(async (_params: { abortSignal?: AbortSignal }) => {
        // Abort during the in-flight call
        ac.abort();
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      }),
    };
    const llmClassifier = new LlmRiskClassifier(providerStub, "gpt-4o-mini", "deny");
    const cache = resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
    setReviewerForTest(pm, { classifier: llmClassifier, cache, recentlyDenied: queue });

    const result = await pm.dispatchReviewer(
      "bash",
      {
        invocationId: randomUUID(),
        sessionId: "permission-manager-reviewer-session",
        source: "builtin",
        category: "shell",
        pathFields: [],
        finalInput: { command: "echo hello" },
        allowedDirectories: [allowedDir("/Users/example/work")],
        executionCwd: process.cwd(),
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      },
      undefined,
      { abortSignal: ac.signal },
    );

    // fallbackOnError=deny → AbortError yields HIGH
    expect(result.verdict.level).toBe("high");
  });
});

describe("#664 flood guard — degraded rule reviewer does not over-defer headless sandbox writes", () => {
  it("allows a low-risk headless plugin sandbox write without denial history", async () => {
    // Without configured credentials, model review degrades to rules; host-proven own-data writes must still classify LOW rather than defer.
    const { wireReviewerAgent } = await import("../../boot/steps/reviewer-wiring.js");
    const { detectSandboxCapability } = await import("../sandbox-capability.js");
    const { realpathSync } = await import("node:fs");

    const pm = new PermissionManager(tmpFile("permissions.json"));
    pm.setMode("auto");
    const wiring = wireReviewerAgent({
      permissionManager: pm,
      // Degrades to the rule classifier — no adapter is built and nothing is ever fetched, so the transport is the tripwire.
      networkFetch: unusedNetworkFetch,
      readSettings: () => ({
        mode: "llm",
        fallbackOnError: "deny",
      }),
      readActiveLlm: () => ({ provider: "openai", model: "gpt-4o-mini" }),
      // Factory present (boot contract honored) but the user has not configured an API key → provider unconfigured → degrade to rule.
      streamProviderFor: () => null,
      verdictCachePath: tmpFile("flood-cache.jsonl"),
      recentlyDenied: makeRecentlyDeniedStore(tmpFile("flood-denied.jsonl")),
    });
    wireJudgeForTest(pm);
    const wiredCache = pm.getVerdictCache();
    if (wiredCache) resources.trackFlushable(wiredCache);
    expect(wiring.runtimeMode).toBe("llm-degraded-to-rule");
    expect(pm.isReviewerDegradedToRule()).toBe(true);

    const TMP = realpathSync(tmpdir());
    const sandboxRoot = `${TMP}/ave-664-flood/.ave/plugins/ave-plugin-samplemail`;

    const r = await pm.dispatchReviewer(
      "samplemail_auth",
      {
        invocationId: randomUUID(),
        sessionId: "permission-manager-reviewer-session",
        source: "plugin",
        category: "write",
        pathFields: ["path"],
        finalInput: { path: `${sandboxRoot}/msal-cache.bin` },
        allowedDirectories: [allowedDir(`${TMP}/ave-664-flood/work`)],
        executionCwd: process.cwd(),
        sensitivePathsAdjacent: [],
        trustOrigin: "plugin-emitted",
        // v6 — auto-LOW keys solely on the host-computed ownerPluginSandboxRoot.
        ownerPluginSandboxRoot: sandboxRoot,
        sandboxCapability: detectSandboxCapability(),
      },
      undefined,
      // Headless lane uses the default "high" defer policy.
      { lane: "headless" },
    );

    expect(r.verdict.level).toBe("low");
    expect(await wiring.recentlyDenied.list()).toHaveLength(0);
  });
});

describe("PermissionManager.checkDetailed — headless mutating reviewer lane", () => {
  it("headless+write routes through the category reviewer lane", () => {
    const { pm } = makeManager();
    const result = pm.checkDetailed("any_write", "builtin", "write", null, {
      headless: true,
    });
    expect(result.decision).toBe("ask");
    expect(result.reasonCode).toBe("review-required");
  });

  it("non-headless writes retain their reviewer request", () => {
    const { pm } = makeManager();
    const result = pm.checkDetailed("any_write", "builtin", "write", null, {
      headless: false,
    });
    expect(result.decision).toBe("ask");
  });
});

describe("reviewer outcome provenance and base-cache safety", () => {
  const input = {
    sessionId: "permission-manager-reviewer-session",
    source: "builtin" as const,
    category: "shell" as const,
    pathFields: [] as string[],
    finalInput: { command: "echo hello" },
    allowedDirectories: [] as string[],
    executionCwd: process.cwd(),
    sensitivePathsAdjacent: [] as string[],
    trustOrigin: "llm-tool-arg" as const,
  };

  function makeLlmManager(
    complete: () => Promise<import("../reviewer/risk-classifier.js").LlmCompletionResult>,
  ) {
    const pm = new PermissionManager(tmpFile("permissions.json"));
    pm.setMode("auto");
  pm.setMode("auto");
    const cache = resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
    const provider = { complete: vi.fn(complete) };
    setReviewerForTest(pm, {
      classifier: new LlmRiskClassifier(provider, "test-model", "deny"),
      cache,
      recentlyDenied: queue,
    });
    return { pm, complete: provider.complete };
  }

  it("auto-decides only the three explicitly successful outcomes", () => {
    for (const outcome of [
      "fresh",
      "cache",
      "approval-memory",
    ] as const) {
      expect(isReviewerAutoDecisionOutcome(outcome)).toBe(true);
    }
    for (const outcome of [
      "unavailable",
      "error",
      "timeout",
      "malformed",
      "sandbox-state-changed",
    ] as const) {
      expect(isReviewerAutoDecisionOutcome(outcome)).toBe(false);
    }
    expect(isReviewerAutoDecisionOutcome(undefined)).toBe(false);
  });

  it("stores only a typed fresh success and reports the subsequent hit as cache", async () => {
    const { pm, complete } = makeLlmManager(async () => ({
      text: '{"level":"medium","reason":"bounded shell action"}',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));

    const first = await pm.dispatchReviewer("bash", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
    const second = await pm.dispatchReviewer("bash", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });

    expect(first.outcome).toBe("fresh");
    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.outcome).toBe("cache");
    expect(second.cacheReason).toBe("hit");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("does not cache a malformed provider response", async () => {
    const { pm, complete } = makeLlmManager(async () => ({
      text: "not-json",
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));

    const first = await pm.dispatchReviewer("bash", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
    const second = await pm.dispatchReviewer("bash", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });

    expect(first.outcome).toBe("malformed");
    expect(second.outcome).toBe("malformed");
    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      name: "provider error",
      expected: "error",
      makeError: () => new Error("provider unavailable"),
    },
    {
      name: "provider timeout",
      expected: "timeout",
      makeError: () => new ReviewerDispatchError("timeout", "provider timed out"),
    },
  ] as const)("does not cache a $name fallback", async ({ expected, makeError }) => {
    const { pm, complete } = makeLlmManager(async () => {
      throw makeError();
    });

    const first = await pm.dispatchReviewer("bash", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });
    const second = await pm.dispatchReviewer("bash", { ...input, invocationId: randomUUID() }, undefined, { lane: "foreground-auto" });

    expect(first.outcome).toBe(expected);
    expect(second.outcome).toBe(expected);
    expect(first.cacheReason).toBe("miss-not-found");
    expect(second.cacheReason).toBe("miss-not-found");
    expect(complete).toHaveBeenCalledTimes(6);
  });

  it("does not cache a valid fresh verdict when the caller aborts before return", async () => {
    const abortController = new AbortController();
    const classify = vi.fn(async () => {
      abortController.abort();
      return { level: "medium" as const, reason: "valid fresh result" };
    });
    const queue = makeRecentlyDeniedStore(tmpFile("recently-denied.jsonl"));
    const pm = new PermissionManager(tmpFile("permissions.json"));
    pm.setMode("auto");
  pm.setMode("auto");
    setReviewerForTest(pm, {
      classifier: { classify },
      cache: resources.makeVerdictCache(tmpFile("reviewer-cache.jsonl")),
      recentlyDenied: queue,
    });

    const aborted = await pm.dispatchReviewer(
      "bash",
      { ...input, invocationId: randomUUID() },
      undefined,
      { lane: "headless", abortSignal: abortController.signal },
    );
    const next = await pm.dispatchReviewer(
      "bash",
      { ...input, invocationId: randomUUID() },
      undefined,
      { lane: "foreground-auto" },
    );

    expect(aborted.outcome).toBe("error");
    expect(next.outcome).toBe("fresh");
    expect(classify).toHaveBeenCalledTimes(2);
    expect(await queue.list()).toHaveLength(0);
  });
});
