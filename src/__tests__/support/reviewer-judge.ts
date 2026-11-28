
import type { JudgeDecision, JudgeFailureKind } from "../../permissions/judge/judge-contract.js";
import type { JudgeOutcome } from "../../permissions/judge/judge-engine.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../permissions/judge/judge-settings.js";

/** Initialize the default judge engine. */
export function wireJudgeForTest(manager: PermissionManager) {
  manager.setJudge({
    settings: {
      ...DEFAULT_JUDGE_SETTINGS,
      chain: [],
      categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
      breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
    },
    chain: [],
    breaker: manager.getJudgeBreaker(),
  });
}

/** Wire reviewer assessment and the default judge engine together. */
export function setReviewerForTest(
  manager: PermissionManager,
  deps: Parameters<PermissionManager["setReviewer"]>[0],
) {
  manager.setReviewer(deps);
  return wireJudgeForTest(manager);
}

/** Completed judge evidence for tests isolating pipeline consumers. */
export function reviewerJudgeOutcomeForTest(
  decision: JudgeDecision,
  rationale: string,
  fallback?: JudgeFailureKind,
): Extract<JudgeOutcome, { judged: true }> {
  return {
    judged: true, mode: "active", decision, applied: true,
    source: fallback ? "fallback" : "judge", rationale, breakerTripped: false,
    ...(fallback ? { fallback } : {}),
  };
}
