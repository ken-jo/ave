import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { buildPermissionEvaluationContext } from "../../../permissions/evaluation-context.js";
import { JudgeContractError, JudgeFailure, type JudgeDecision, type JudgeFailureKind, type PermissionJudge } from "../../../permissions/judge/judge-contract.js";
import { collectingAudit, judgeSettings, scriptedStage } from "../../../permissions/judge/__tests__/judge-request-fixture.js";
import { PermissionManager, type PermissionCheckResult } from "../../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../../__tests__/support/recently-denied.js";
import { RuleBasedRiskClassifier, type RiskClassifier } from "../../../permissions/reviewer/risk-classifier.js";
import type { ToolExecutorCallbacks } from "../../executor.js";
import { dispatchReviewerForHeadless, dispatchReviewerForInteractiveAuto } from "../reviewer-dispatch.js";

const SESSION_ID = "reviewer-delegation-session";
const resources = new PermissionTestResources();

afterEach(async () => {
  vi.restoreAllMocks();
  await resources.cleanup();
});

function subject(judge?: PermissionJudge | null, classifier: RiskClassifier = new RuleBasedRiskClassifier()) {
  const root = resources.makeTmpDir("ave-reviewer-delegation-");
  const manager = new PermissionManager(join(root, "permissions.json"));
  const queue = makeRecentlyDeniedStore(join(root, "deferred.jsonl"));
  const audit = collectingAudit();
  manager.setMode("auto");
  manager.setInteractiveAutoApprove("low");
  manager.setReviewer({ classifier, cache: resources.makeVerdictCache(join(root, "cache.jsonl")), recentlyDenied: queue });
  const stage = scriptedStage("decision-provider");
  const settings = judgeSettings({ chain: judge === undefined ? [] : [stage] });
  manager.setJudge({
    settings, chain: judge === undefined ? [] : [{ settings: stage, judge }],
    breaker: manager.getJudgeBreaker(), audit: audit.logger,
  });
  return { root, manager, queue, audit };
}

type Subject = ReturnType<typeof subject>;
type Lane = "foreground-auto" | "headless";

async function dispatch(current: Subject, lane: Lane, callbacks?: ToolExecutorCallbacks, abortSignal?: AbortSignal): Promise<PermissionCheckResult> {
  const evaluation = buildPermissionEvaluationContext({
    policyMode: "auto", headless: lane === "headless", source: "builtin", category: "write",
    trustOrigin: "user-keyboard", executionCwd: current.root, allowedDirectories: [current.root],
    pathFields: ["path"], targetFilePaths: [join(current.root, "file.txt")], sensitivePathsAdjacent: [],
  });
  const args: Parameters<typeof dispatchReviewerForHeadless> = [
    current.manager, "write_probe", "builtin", "write", ["path"],
    { path: join(current.root, "file.txt") }, [current.root], [],
    { trustOrigin: "user-keyboard", headless: lane === "headless" }, evaluation, {}, callbacks,
    { groupId: "decision-group", toolUseId: "decision-call", displayOrder: 0 },
    undefined, undefined, abortSignal, undefined, SESSION_ID,
  ];
  if (lane === "headless") {
    const result = await dispatchReviewerForHeadless(...args);
    expect(result.allowed).toBe(result.permissionResult.decision === "allow");
    return result.permissionResult;
  }
  const result = await dispatchReviewerForInteractiveAuto(...args);
  if (!result) throw new Error("Foreground reviewer result missing");
  return result;
}

function deciding(decision: JudgeDecision): PermissionJudge {
  return { id: "decision-provider", version: "1", judge: vi.fn(async () => ({ decision, rationale: "provider decision" })) };
}

describe("reviewer dispatch consumes chain decisions", () => {
  for (const lane of ["foreground-auto", "headless"] as const) {
    it.each(["allow", "deny"] as const)(`${lane} preserves a supplied provider %s and its rule provenance`, async (decision) => {
      const judge = deciding(decision);
      const current = subject(judge);
      const result = await dispatch(current, lane);
      expect(result).toMatchObject({ decision, layer: 5, reviewer: { route: lane } });
      expect(judge.judge).toHaveBeenCalledOnce();
      const reviewedRequest = vi.mocked(judge.judge).mock.calls[0]?.[0];
      expect(reviewedRequest).toBeDefined();
      expect(result.reviewer?.verdict).toEqual(reviewedRequest?.ruleVerdict);
      expect(current.audit.chained).toEqual([expect.objectContaining({
        decision: "judge", judgeRecord: expect.objectContaining({ decision, source: "judge" }),
      })]);
      expect((await current.queue.list())).toHaveLength(lane === "headless" && decision === "deny" ? 1 : 0);
      if (lane === "headless" && decision === "deny") {
        expect(result.reason).toContain("do not retry");
      }
    });

    it.each(["error", "timeout", "unparseable", "unavailable"] as const)(`${lane} applies %s failure through the chain`, async (kind: JudgeFailureKind) => {
      const judge: PermissionJudge | null = kind === "unavailable" ? null : {
        id: "decision-provider", version: "1",
        judge: async () => { throw new JudgeFailure(kind, "provider failed"); },
      };
      const current = subject(judge);
      const result = await dispatch(current, lane);
      expect(result).toMatchObject({ decision: lane === "headless" ? "deny" : "ask", forceModal: true });
      expect(current.audit.chained).toEqual([expect.objectContaining({
        judgeRecord: expect.objectContaining({ fallback: kind, source: "fallback" }),
      })]);
      expect((await current.queue.list())).toHaveLength(lane === "headless" ? 1 : 0);
      expect(current.manager.getJudgeBreaker().snapshot(SESSION_ID)).toEqual({ consecutive: 0, total: 0, open: false });
    });

    it(`${lane} rejects missing judge evidence as an internal contract violation`, async () => {
      const current = subject();
      const original = current.manager.dispatchReviewer.bind(current.manager);
      vi.spyOn(current.manager, "dispatchReviewer").mockImplementation(async (...args) => {
        const { judge: _judge, ...withoutJudge } = await original(...args);
        return withoutJudge;
      });
      await expect(dispatch(current, lane)).rejects.toBeInstanceOf(JudgeContractError);
    });

    it(`${lane} treats caller cancellation as terminal without deferring or granting`, async () => {
      const abort = new AbortController();
      const current = subject(undefined, {
        classify: () => {
          abort.abort(new Error("Caller cancelled review"));
          return { level: "low", reason: "late classifier verdict" };
        },
      });
      const statuses: string[] = [];
      const result = await dispatch(current, lane, {
        onPermissionReview: (event) => statuses.push(event.status),
      }, abort.signal);
      expect(result.decision).toBe("deny");
      expect((await current.queue.list())).toHaveLength(0);
      expect(statuses).toEqual(["reviewing", "failed"]);
      if (lane === "foreground-auto") expect(result.reviewer).toBeUndefined();
    });
  }
});
