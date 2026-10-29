import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { t } from "../../i18n/index.js";
import {
  isHostApprovalTimeoutDecision,
  isHostApprovalRejectedDecision,
  type ApprovalDecision,
} from "../../permissions/approval-gate.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import { maskSensitiveData } from "../../shared/dlp.js";

/** Preserve host-owned failures in both tool and directory approval results. */
export function approvalFailureOutcome(
  decision: ApprovalDecision,
  toolName: string,
  permission: PermissionCheckResult,
): { content: string; permission: PermissionCheckResult } | null {
  const expired = isHostApprovalTimeoutDecision(decision);
  if (!expired && !isHostApprovalRejectedDecision(decision)) return null;
  const autoSkipped = expired && decision.rememberPattern === NO_APPROVER_MESSAGE;
  const reason = autoSkipped ? NO_APPROVER_MESSAGE : expired ? "approval request expired" : "approval rejected by host";
  const detail = decision.rememberPattern
    ? maskSensitiveData(decision.rememberPattern).masked
    : t("be_executor.approvalHostRejectedReason");
  return {
    content: autoSkipped ? NO_APPROVER_MESSAGE : expired ? t("be_executor.approvalExpired", { name: toolName })
      : t("be_executor.approvalRejectedByHost", { name: toolName, reason: detail }),
    permission: {
      ...permission,
      decision: "deny",
      reason,
      // Denial audit must record why approval ended, not merely why it was requested.
      denyReasons: [{ layer: permission.layer, source: "approval-gate", reason }],
    },
  };
}
