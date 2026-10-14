/**
 * `builtin-llm` judge provider: the existing auto-mode reviewer
 * ({@link LlmRiskClassifier}, `max(rule, llm)`) behind the judge contract.
 *
 * It reproduces the shipped reviewer dispatch lanes
 * (`src/tools/pipeline/reviewer-dispatch.ts`), so moving auto mode behind this
 * provider changes no decision:
 *
 *   - A successful classification (`fresh`, `host-determined` — the outcomes
 *     `isReviewerAutoDecisionOutcome` accepts) is mapped exactly like
 *     `PermissionManager.resolveReviewerDecision`:
 *       - headless:   LOW → allow; MEDIUM/HIGH → deny (the call site defers it).
 *       - foreground: LOW → allow; MEDIUM → allow only under
 *                     `autoApprove: "medium"` and without
 *                     `requiresExplicitApproval`; otherwise ask.
 *   - A failed classification (`error`, `timeout`, `malformed`) is a
 *     {@link JudgeFailure}. The shipped lanes never map the verdict of a failed
 *     review — whatever `fallbackOnError` put in it — they deny headless and
 *     ask (modal) in the foreground. The engine's never-allow fallback does the
 *     same, so `fallbackOnError: "rule"` cannot turn a failure into an allow.
 */
import type { LlmRiskClassificationTrace, RiskVerdict, ToolInvocationContext } from "../reviewer/risk-classifier.js";
import type { ReviewerInteractiveAutoApprove } from "../permission-settings-store.js";
import {
  JudgeFailure,
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

/** null = the outcome may auto-decide; otherwise the failure it surfaces as. */
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
    /** Resolved `<provider>/<model>` the classifier runs on. */
    readonly model?: string,
  ) {}

  async judge(request: JudgeRequest, signal: AbortSignal): Promise<JudgeVerdict> {
    const trace = await this.classifier.classifyWithTrace(request.invocation, { abortSignal: signal });
    const failure = REVIEWER_FAILURE_KIND[trace.outcome];
    if (failure) {
      throw new JudgeFailure(failure, `reviewer ${trace.outcome}: ${trace.finalVerdict.reason}`);
    }
    const verdict = trace.finalVerdict;
    return {
      decision: mapRiskVerdictToJudgeDecision(verdict, request.lane, this.autoApprove()),
      rationale: `reviewer ${verdict.level}: ${verdict.reason}`,
    };
  }
}
