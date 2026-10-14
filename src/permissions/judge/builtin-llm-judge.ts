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
 * Reviewer failures (provider error, timeout, malformed output) keep today's
 * outcome exactly: the classifier's configured `fallbackOnError` already shaped
 * `finalVerdict` (deny → HIGH; rule → the rule verdict, which may allow), and
 * the provider maps it like any other verdict, tagging `providerFallback` so
 * the audit records the failure and the breaker ignores it. The judge-level
 * never-allow fallback still covers this provider's own timeout and errors
 * raised outside the classifier.
 */
import type { LlmRiskClassificationTrace, RiskVerdict, ToolInvocationContext } from "../reviewer/risk-classifier.js";
import type { ReviewerInteractiveAutoApprove } from "../permission-settings-store.js";
import {
  type JudgeDecision,
  type JudgeFailureKind,
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

const REVIEWER_FAILURE_KIND: Record<LlmRiskClassificationTrace["outcome"], JudgeFailureKind | null> = {
  fresh: null,
  "host-determined": null,
  timeout: "timeout",
  error: "error",
  malformed: "unparseable",
};

export class BuiltinLlmJudge implements PermissionJudge {
  readonly id = "builtin-llm";
  readonly version = "1";

  constructor(
    private readonly classifier: TracingRiskClassifier,
    private readonly autoApprove: () => ReviewerInteractiveAutoApprove,
  ) {}

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const trace = await this.classifier.classifyWithTrace(request.invocation, { abortSignal: signal });
    const providerFallback = REVIEWER_FAILURE_KIND[trace.outcome];
    // On reviewer failure the classifier has already applied the shipped
    // `fallbackOnError` policy to `finalVerdict` (deny → HIGH; rule → the rule
    // verdict). Mapping that verdict is exactly today's decision in both
    // configurations, so the provider answers instead of throwing.
    const verdict = trace.finalVerdict;
    return {
      decision: mapRiskVerdictToJudgeDecision(verdict, request.lane, this.autoApprove()),
      rationale: `reviewer ${verdict.level}: ${verdict.reason}`,
      ...(providerFallback ? { providerFallback } : {}),
    };
  }
}
