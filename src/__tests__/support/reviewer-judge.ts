import type { AuditEntry } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../../audit/audit-schema.js";
import type { JudgeDecision, JudgeFailureKind } from "../../permissions/judge/judge-contract.js";
import type { JudgeOutcome } from "../../permissions/judge/judge-engine.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import { DEFAULT_JUDGE_SETTINGS } from "../../permissions/judge/judge-settings.js";

/** Initialize the default judge engine while retaining both audit channels. */
export function wireJudgeForTest(manager: PermissionManager) {
  const shadow: AuditEntry[] = [];
  const active: PermissionAuditEntryInput[] = [];
  manager.setJudge({
    settings: {
      ...DEFAULT_JUDGE_SETTINGS,
      chain: [],
      categories: { ...DEFAULT_JUDGE_SETTINGS.categories },
      breaker: { ...DEFAULT_JUDGE_SETTINGS.breaker },
    },
    chain: [],
    breaker: manager.getJudgeBreaker(),
    audit: {
      logShadow(entry: AuditEntry) {
        shadow.push(entry);
      },
      async appendPermissionAuditEntry(entry: PermissionAuditEntryInput) {
        active.push(entry);
        return { ...entry, prevHash: "test" };
      },
    },
  });
  return { shadow, active };
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
    judged: true, mode: "active", decision, applied: true, defer: false,
    source: fallback ? "fallback" : "judge", rationale, breakerTripped: false,
    ...(fallback ? { fallback } : {}),
  };
}
