import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { t } from "../../i18n/index.js";
import {
  answeredApprovalProvenance,
  HOST_PROVENANCE,
  isAnsweredApprovalDenial,
  isHostApprovalTimeoutDecision,
  isHostApprovalRejectedDecision,
  type ApprovalDecision,
  type DecisionProvenance,
} from "../../permissions/approval-gate.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import { RULE_PROVENANCE } from "../../permissions/decision-provenance.js";
import { isHostExitAbort } from "../../shared/host-exit-abort.js";
import { maskSensitiveData } from "../../shared/dlp.js";

/** The host's refusal of a call the quit seal stopped; no person decided it. */
export function hostShutdownDenial(): PermissionCheckResult {
  return { decision: "deny", reason: "host-shutdown", provenance: HOST_PROVENANCE };
}

/** The refusal of a call the user's abort stopped; every user-abort row carries this one. */
export function userAbortRefusal(): PermissionCheckResult {
  return { decision: "deny", reason: "user aborted turn", provenance: RULE_PROVENANCE };
}

/** A refusal an invocation selected for its terminal row before the host ended it. */
export function isSelectedRefusal(selected: unknown): selected is PermissionCheckResult {
  return typeof selected === "object" && selected !== null && (selected as PermissionCheckResult).decision === "deny";
}

/** A fresh refusal with its own reason and provenance; nothing an earlier result carried, such as its deny reasons, survives into it. */
export function refusal(reason: string, provenance: DecisionProvenance): PermissionCheckResult {
  return { decision: "deny", reason, provenance };
}

/** The host's refusal of an approved call; an answered approval stays on the row as the answer the host overrode. */
export function hostRefusalOfApproval(reason: string, approved: DecisionProvenance): PermissionCheckResult {
  return { ...refusal(reason, HOST_PROVENANCE), ...(approved.kind === "answered" ? { answer: approved } : {}) };
}

/** A result an answerer decided: it carries the gate's record of who answered, and throws when the gate kept none. */
export function answeredPermission(permission: PermissionCheckResult, decision: ApprovalDecision): PermissionCheckResult {
  return { ...permission, provenance: answeredApprovalProvenance(decision) };
}

/** Why the host ended an approval it produced itself, or undefined for a decision a person made. */
export function hostApprovalDenialReason(decision: ApprovalDecision): string | undefined {
  const expired = isHostApprovalTimeoutDecision(decision);
  if (!expired && !isHostApprovalRejectedDecision(decision)) return undefined;
  if (expired && decision.rememberPattern === NO_APPROVER_MESSAGE) return NO_APPROVER_MESSAGE;
  return expired ? "approval request expired" : "approval rejected by host";
}

/** A card answer that is not an allow, or that the host rejected: terminal whatever the policy says afterwards. */
export function isSettledRefusal(decision: ApprovalDecision): boolean {
  return !decision.choice.startsWith("allow") || isHostApprovalRejectedDecision(decision);
}

/** An abort ends the call unless it is the quit seal landing after a person already answered deny: that deny stays theirs. */
export function abortSupersedesApprovalDecision(
  abortSignal: AbortSignal | undefined,
  decision: ApprovalDecision | undefined,
): boolean {
  if (abortSignal?.aborted !== true) return false;
  return decision === undefined || !isHostExitAbort(abortSignal.reason) || !isAnsweredApprovalDenial(decision);
}

/** Preserve host-owned failures in both tool and directory approval results. */
export function approvalFailureOutcome(
  decision: ApprovalDecision,
  toolName: string,
): { content: string; permission: PermissionCheckResult } | null {
  const reason = hostApprovalDenialReason(decision);
  if (reason === undefined) return null;
  const expired = isHostApprovalTimeoutDecision(decision);
  const autoSkipped = reason === NO_APPROVER_MESSAGE;
  const detail = decision.rememberPattern
    ? maskSensitiveData(decision.rememberPattern).masked
    : t("be_executor.approvalHostRejectedReason");
  return {
    content: autoSkipped ? NO_APPROVER_MESSAGE : expired ? t("be_executor.approvalExpired", { name: toolName })
      : t("be_executor.approvalRejectedByHost", { name: toolName, reason: detail }),
    permission: {
      decision: "deny",
      reason,
      // Denial audit must record why approval ended, not merely why it was requested.
      denyReasons: [{ source: "approval-gate", reason }],
      // The host ended the approval; no person's origin belongs on its row.
      provenance: HOST_PROVENANCE,
    },
  };
}
