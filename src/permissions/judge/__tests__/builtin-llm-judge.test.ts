import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../permission-manager.js";
import {
  LlmRiskClassifier,
  RuleBasedRiskClassifier,
  type LlmReviewerProvider,
  type LlmRiskClassificationTrace,
  type RiskVerdict,
} from "../../reviewer/risk-classifier.js";
import type { ReviewerInteractiveAutoApprove } from "../../permission-settings-store.js";
import { BuiltinLlmJudge, mapRiskVerdictToJudgeDecision, type TracingRiskClassifier } from "../builtin-llm-judge.js";
import { judgeInvocation, judgeRequest } from "./judge-request-fixture.js";

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
  ] as const)("reviewer outcome %s maps the configured fallback verdict and tags %s", async (outcome, kind) => {
    const judge = new BuiltinLlmJudge(tracing({ outcome, finalVerdict: { level: "low", reason: "rule" } }), () => "medium");
    expect(await judge.judge(judgeRequest(), new AbortController().signal)).toMatchObject({
      decision: "allow",
      providerFallback: kind,
    });
  });
});

describe("builtin-llm parity through a real LlmRiskClassifier on reviewer failure", () => {
  const NO_RETRY = { maxAttempts: 1, baseDelayMs: 0, jitterPct: 0 };
  const providers: Array<[string, LlmReviewerProvider]> = [
    ["provider error", { complete: async () => Promise.reject(new Error("HTTP 400 bad request")) }],
    ["malformed output", { complete: async () => ({ text: "not a verdict", tokensIn: 0, tokensOut: 0, costUsd: 0 }) }],
  ];
  const lanes = [
    ["foreground", "foreground-auto"],
    ["headless", "headless"],
  ] as const;

  for (const fallbackOnError of ["deny", "rule"] as const) {
    for (const [label, provider] of providers) {
      for (const [lane, pmLane] of lanes) {
        it(`fallbackOnError=${fallbackOnError}, ${label}, ${lane}: same decision as today`, async () => {
          const classifier = new LlmRiskClassifier(provider, "model-under-test", fallbackOnError, {}, NO_RETRY);
          const pm = new PermissionManager(join(tmpdir(), "ave-judge-parity", "permissions.json"));
          pm.setInteractiveAutoApprove("medium");
          const request = judgeRequest({ lane, invocation: judgeInvocation({ toolName: "read_file", category: "read", finalInput: { path: "/workspace/sample/a.txt" }, pathFields: ["path"] }) });
          const today = pm.resolveReviewerDecision(await classifier.classify(request.invocation), pmLane).decision;
          const judged = await new BuiltinLlmJudge(classifier, () => "medium").judge(request, new AbortController().signal);
          expect(judged.decision).toBe(today);
          expect(judged.providerFallback).toBeDefined();
          // Control: the rule verdict is LOW, so "rule" fallback is the case that allows today.
          expect(new RuleBasedRiskClassifier().classify(request.invocation).level).toBe("low");
          if (fallbackOnError === "rule") expect(judged.decision).toBe("allow");
          else expect(judged.decision).not.toBe("allow");
        });
      }
    }
  }
});
