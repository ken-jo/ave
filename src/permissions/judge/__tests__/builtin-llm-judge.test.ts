import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../permission-manager.js";
import type { LlmRiskClassificationTrace, RiskVerdict } from "../../reviewer/risk-classifier.js";
import type { ReviewerInteractiveAutoApprove } from "../../permission-settings-store.js";
import { BuiltinLlmJudge, mapRiskVerdictToJudgeDecision, type TracingRiskClassifier } from "../builtin-llm-judge.js";
import { judgeRequest } from "./judge-request-fixture.js";

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
  ] as const)("reviewer outcome %s surfaces as %s failure, even when fallbackOnError=rule left LOW", async (outcome, kind) => {
    const judge = new BuiltinLlmJudge(tracing({ outcome, finalVerdict: { level: "low", reason: "rule" } }), () => "medium");
    await expect(judge.judge(judgeRequest(), new AbortController().signal)).rejects.toMatchObject({ kind });
  });
});
