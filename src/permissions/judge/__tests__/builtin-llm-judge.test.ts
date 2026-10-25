import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../permission-manager.js";
import {
  LlmRiskClassifier,
  ReviewerDispatchError,
  type LlmReviewerProvider,
  type LlmRiskClassificationTrace,
  type RiskVerdict,
} from "../../reviewer/risk-classifier.js";
import type { ReviewerInteractiveAutoApprove } from "../../permission-settings-store.js";
import { BuiltinLlmJudge, mapRiskVerdictToJudgeDecision, type TracingRiskClassifier } from "../builtin-llm-judge.js";
import { collectingAudit, judgeInvocation, judgeRequest, judgeSettings } from "./judge-request-fixture.js";
import { useTempDirs } from "../../../__tests__/test-helpers.js";
import { VerdictCache } from "../../reviewer/verdict-cache.js";
import { DeferredQueue } from "../../reviewer/deferred-queue.js";
import { buildPermissionEvaluationContext } from "../../evaluation-context.js";
import { canonicalizePathForMatch } from "../../sensitive-paths.js";
import { detectSandboxCapability } from "../../sandbox-capability.js";
import {
  dispatchReviewerForHeadless,
  dispatchReviewerForInteractiveAuto,
} from "../../../tools/pipeline/reviewer-dispatch.js";
import type { ToolPermissionContext } from "../../../tools/executor.js";
import { resolveJudge } from "../judge-engine.js";
import { JudgeCircuitBreaker } from "../judge-breaker.js";

const LEVELS = ["low", "medium", "high"] as const;
const FLAGS = [undefined, false, true] as const;
const AUTO: ReviewerInteractiveAutoApprove[] = ["off", "low", "medium"];

describe("builtin-llm mapping is today's resolveReviewerDecision", () => {
  it("matches PermissionManager for every level × flag × autoApprove × lane", () => {
    const pm = new PermissionManager(join(tmpdir(), "ave-judge-equivalence", "permissions.json"));
    let checked = 0;
    for (const auto of AUTO) {
      pm.setInteractiveAutoApprove(auto);
      for (const level of LEVELS) {
        for (const flag of FLAGS) {
          const verdict: RiskVerdict = { level, reason: "r", ...(flag === undefined ? {} : { requiresExplicitApproval: flag }) };
          expect(mapRiskVerdictToJudgeDecision(verdict, "foreground", auto)).toBe(
            pm.resolveReviewerDecision(verdict, "foreground-auto").decision,
          );
          expect(mapRiskVerdictToJudgeDecision(verdict, "headless", auto)).toBe(
            pm.resolveReviewerDecision(verdict, "headless").decision,
          );
          checked += 2;
        }
      }
    }
    expect(checked).toBe(AUTO.length * LEVELS.length * FLAGS.length * 2);
  });
});

function tracing(trace: Partial<LlmRiskClassificationTrace> & { finalVerdict: RiskVerdict }): TracingRiskClassifier & { signals: Array<AbortSignal | undefined> } {
  const signals: Array<AbortSignal | undefined> = [];
  return {
    signals,
    async classifyWithTrace(_input, opts) {
      signals.push(opts?.abortSignal);
      return { ruleVerdict: trace.finalVerdict, llmVerdict: null, outcome: "fresh", ...trace };
    },
  };
}

describe("BuiltinLlmJudge", () => {
  it("maps a fresh MEDIUM under autoApprove medium to allow and forwards the signal", async () => {
    const classifier = tracing({ finalVerdict: { level: "medium", reason: "build" } });
    const judge = new BuiltinLlmJudge(classifier, () => "medium");
    const signal = new AbortController().signal;
    expect(await judge.judge(judgeRequest(), signal)).toMatchObject({ decision: "allow" });
    expect(classifier.signals[0]).toBe(signal);
    expect(judge.id).toBe("builtin-llm");
  });

  it("headless MEDIUM is deny (call site defers)", async () => {
    const judge = new BuiltinLlmJudge(tracing({ finalVerdict: { level: "medium", reason: "x" } }), () => "medium");
    expect(await judge.judge(judgeRequest({ lane: "headless" }), new AbortController().signal)).toMatchObject({ decision: "deny" });
  });

  it.each([
    ["timeout", "timeout"],
    ["error", "error"],
    ["malformed", "unparseable"],
  ] as const)("reviewer outcome %s is a %s judge failure, never a mapped verdict", async (outcome, kind) => {
    // finalVerdict LOW is what fallbackOnError="rule" leaves behind; it must not allow.
    const judge = new BuiltinLlmJudge(tracing({ outcome, finalVerdict: { level: "low", reason: "rule" } }), () => "medium");
    await expect(judge.judge(judgeRequest(), new AbortController().signal)).rejects.toMatchObject({ kind });
  });
});

// Parity through the SHIPPED dispatch lanes: the same LlmRiskClassifier drives `dispatchReviewerForHeadless` / `dispatchReviewerForInteractiveAuto` (which gate on `isReviewerAutoDecisionOutcome`) and the judge engine with the builtin-llm provider. Any drift in the mapping or the failure handling fails here.
describe("builtin-llm parity with the shipped reviewer dispatch", () => {
  const makeRoot = useTempDirs("ave-judge-parity-");
  const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0, jitterPct: 0 };
  const reply = (text: string): LlmReviewerProvider => ({ complete: async () => ({ text, tokensIn: 0, tokensOut: 0, costUsd: 0 }) });
  const providers: Array<[string, LlmReviewerProvider, boolean]> = [
    ["llm low", reply('{"level":"low","reason":"fine"}'), false],
    ["llm medium", reply('{"level":"medium","reason":"check"}'), false],
    ["llm high", reply('{"level":"high","reason":"danger"}'), false],
    ["provider error", { complete: async () => Promise.reject(new Error("HTTP 400 bad request")) }, true],
    ["provider timeout", { complete: async () => Promise.reject(new ReviewerDispatchError("timeout", "reviewer timed out")) }, true],
    ["malformed output", reply("not a verdict"), true],
  ];

  // Rule verdicts: `ls` is LOW (the case fallbackOnError="rule" would allow), `git status` MEDIUM.
  for (const command of ["ls", "git status"]) {
  for (const fallbackOnError of ["deny", "rule"] as const) {
    for (const [label, provider, failure] of providers) {
      for (const lane of ["foreground", "headless"] as const) {
        it(`${command}: fallbackOnError=${fallbackOnError}, ${label}, ${lane}`, async () => {
          const dir = makeRoot();
          const cwd = canonicalizePathForMatch(dir);
          const finalInput = { command };
          const classifier = new LlmRiskClassifier(provider, "model-under-test", fallbackOnError, {}, NO_RETRY);
          const pm = new PermissionManager(join(dir, "permissions.json"));
          pm.setReviewer({
            classifier,
            cache: new VerdictCache(join(dir, "cache.jsonl")),
            deferredQueue: new DeferredQueue(join(dir, "queue.jsonl")),
          });
          pm.setInteractiveAutoApprove("medium");
          const evaluationContext = buildPermissionEvaluationContext({
            policyMode: "unmanaged",
            headless: lane === "headless",
            source: "builtin",
            category: "shell",
            trustOrigin: "llm-tool-arg",
            executionCwd: cwd,
            allowedDirectories: [cwd],
            pathFields: [],
            targetFilePaths: [],
            sensitivePathsAdjacent: [],
          });
          const args: unknown[] = [
            pm, "bash", "builtin", "shell", [], finalInput, [cwd], [],
            { trustOrigin: "llm-tool-arg", headless: lane === "headless" } as ToolPermissionContext,
            evaluationContext, {}, undefined, { groupId: "g1", toolUseId: "tu1", displayOrder: 0 }, undefined,
          ];
          const today =
            lane === "headless"
              ? (await dispatchReviewerForHeadless(...(args as Parameters<typeof dispatchReviewerForHeadless>))).permissionResult.decision
              : (await dispatchReviewerForInteractiveAuto(...(args as Parameters<typeof dispatchReviewerForInteractiveAuto>)))?.decision;

          const settings = judgeSettings({ timeoutMs: 10_000, chain: [{ provider: "builtin-llm", id: "builtin-llm" }] });
          const { logger } = collectingAudit();
          const judged = await resolveJudge(
            { priorDecision: "undecided", strictMode: false, capabilityGrant: false, remoteController: false },
            judgeRequest({
              lane,
              invocation: judgeInvocation({
                toolName: "bash", source: "builtin", category: "shell", pathFields: [], finalInput,
                trustOrigin: "llm-tool-arg", executionCwd: cwd, allowedDirectories: [cwd],
                sandboxCapability: detectSandboxCapability(),
              }),
            }),
            {
              settings,
              chain: [{
                settings: settings.chain[0]!,
                judge: new BuiltinLlmJudge(new LlmRiskClassifier(provider, "model-under-test", fallbackOnError, {}, NO_RETRY), () => "medium"),
              }],
              breaker: new JudgeCircuitBreaker(settings.breaker),
              audit: logger,
            },
          );
          if (!judged.judged) throw new Error("expected judged");
          expect(judged.decision).toBe(today);
          if (failure) {
            expect(judged.decision).not.toBe("allow");
            expect(judged.source).toBe("fallback");
          }
        });
      }
    }
  }
  }
});
