/**
 * `builtin-llm` judge provider: the existing auto-mode reviewer
 * ({@link LlmRiskClassifier}, `max(rule, llm)`) behind the judge contract.
 *
 * The risk → decision mapping reproduces
 * `PermissionManager.resolveReviewerDecision` exactly, so moving auto mode
 * behind this provider changes no decision:
 *   - headless:   LOW → allow; MEDIUM/HIGH → deny (the call site defers it).
 *   - foreground: LOW → allow; MEDIUM → allow only under `autoApprove: "medium"`
 *                 and without `requiresExplicitApproval`; otherwise ask.
 *
 * Reviewer failures (provider error, timeout, malformed output) surface as a
 * {@link JudgeFailure} so the engine's never-allow fallback applies. With the
 * shipped `fallbackOnError: "deny"` that is today's outcome (HIGH → ask /
 * deny). Only the non-default `fallbackOnError: "rule"` differs: today a LOW
 * rule verdict would allow on reviewer failure; through the judge it asks.
 */
import type { LlmRiskClassificationTrace, RiskVerdict, ToolInvocationContext } from "../reviewer/risk-classifier.js";
import type { ReviewerInteractiveAutoApprove } from "../permission-settings-store.js";
import {
  JudgeFailure,
  type JudgeDecision,
  type JudgeLane,
  type JudgeRequest,
  type JudgeVerdict,
  type PermissionJudge,
} from "./judge-contract.js";

export interface TracingRiskClassifier {
  classifyWithTrace(
    input: ToolInvocationContext,
    opts?: { abortSignal?: AbortSignal },
  ): Promise<LlmRiskClassificationTrace>;
}

export function mapRiskVerdictToJudgeDecision(
  verdict: RiskVerdict,
  lane: JudgeLane,
  autoApprove: ReviewerInteractiveAutoApprove,
): JudgeDecision {
  const isLow = verdict.level === "low";
  if (lane === "headless") return isLow ? "allow" : "deny";
  const autoApproved =
    isLow ||
    (verdict.level === "medium" && autoApprove === "medium" && verdict.requiresExplicitApproval !== true);
  return autoApproved ? "allow" : "ask";
}

export class BuiltinLlmJudge implements PermissionJudge {
  readonly id = "builtin-llm";
  readonly version = "1";

  constructor(
    private readonly classifier: TracingRiskClassifier,
    private readonly autoApprove: () => ReviewerInteractiveAutoApprove,
  ) {}

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const trace = await this.classifier.classifyWithTrace(request.invocation, { abortSignal: signal });
    switch (trace.outcome) {
      case "timeout":
        throw new JudgeFailure("timeout", `reviewer timeout: ${trace.finalVerdict.reason}`);
      case "error":
        throw new JudgeFailure("error", `reviewer error: ${trace.finalVerdict.reason}`);
      case "malformed":
        throw new JudgeFailure("unparseable", `reviewer output unparseable: ${trace.finalVerdict.reason}`);
      case "fresh":
      case "host-determined":
        break;
      default: {
        const unknown: never = trace.outcome;
        throw new JudgeFailure("error", `unknown reviewer outcome: ${String(unknown)}`);
      }
    }
    const verdict = trace.finalVerdict;
    return {
      decision: mapRiskVerdictToJudgeDecision(verdict, request.lane, this.autoApprove()),
      rationale: `reviewer ${verdict.level}: ${verdict.reason}`,
    };
  }
}
