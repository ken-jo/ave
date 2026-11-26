import { t } from "../../i18n/runtime.js";
import { answerEpochsOf, personAnswerStands } from "../../permissions/pending-answer-policy.js";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { isHostApprovalRejectedDecision } from "../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../permissions/permission-manager.js";

export function userOwnedSurfaceCardFacts(
  permission: PermissionCheckResult,
): Pick<ApprovalRequestInput, "userOwnedSurface" | "userOwnedSurfaceReviewFallback" | "reasonCode"> {
  const request = permission.pipelineRequest;
  if (!request?.userOwnedSurface || permission.forceModal || request.manualRerun) return {};
  const reviewFallback = request.exfiltration !== undefined || request.userOwnedSurface.choice === "auto" &&
    (request.reviewer !== undefined || request.userOwnedSurface.kind === "host-terminal" && request.automationPause !== undefined);
  return {
    userOwnedSurface: request.userOwnedSurface.kind,
    // The surface card shows its own sentence for the decision that asked; no other card reads it, so no other card is sent it. A review fallback
    // is drawn by the ordinary card, with the host's reason.
    ...(reviewFallback ? { userOwnedSurfaceReviewFallback: true as const }
      : permission.reasonCode === undefined ? {} : { reasonCode: permission.reasonCode }),
  };
}

/** Selection receipts change session policy only after this live native card authorizes them. */
export async function resolveUserOwnedSurfaceApproval(input: {
  manager: PermissionManager;
  gate: ApprovalGate;
  permission: PermissionCheckResult;
  decision: ApprovalDecision;
  request: ApprovalRequestInput;
  sessionId: string | undefined;
  review: (permission: PermissionCheckResult) => Promise<PermissionCheckResult>;
}): Promise<{ permission: PermissionCheckResult; decision: ApprovalDecision; humanApproved?: boolean }> {
  const { manager, gate, request, sessionId } = input;
  let { permission, decision } = input;
  // A person's Deny is a deny permission from here on, whatever a re-check of the call said: no caller has to read the choice again
  // to keep a denied call from running.
  const personDenied = (answer: ApprovalDecision): { permission: PermissionCheckResult; decision: ApprovalDecision; humanApproved: false } => ({
    permission: permission.decision === "deny" ? permission : { ...permission, decision: "deny", reason: t("be_executor.approvalDeniedByUser", { name: request.toolName }) },
    decision: answer, humanApproved: false,
  });
  if (decision.choice.startsWith("deny") && !isHostApprovalRejectedDecision(decision)) return personDenied(decision);
  if (!request.userOwnedSurface || !sessionId || !decision.choice.startsWith("allow") || Boolean(isHostApprovalRejectedDecision(decision))) return { permission, decision };
  permission = manager.recheckPermission(permission);
  if (permission.decision === "deny") return { permission, decision: { requestId: decision.requestId, choice: "deny-once" }, humanApproved: false };
  if (permission.forceModal && !request.forceExplicit) return { permission, decision: { requestId: decision.requestId, choice: "deny-once" }, humanApproved: false };
  if (request.userOwnedSurfaceReviewFallback) return { permission, decision, humanApproved: true };
  const choice = gate.consumeUserOwnedSurfaceChoice(decision, sessionId, request.userOwnedSurface);
  if (choice === undefined) throw new Error("User-owned surface approval receipt is unavailable.");
  manager.setUserOwnedSurfaceChoice(sessionId, request.userOwnedSurface, choice);
  if (choice !== "auto") return { permission, decision, humanApproved: true };
  permission = manager.recheckPermission(permission);
  if (permission.reviewer && permission.decision === "ask") permission = await input.review(permission);
  if (permission.decision === "deny") throw new Error(permission.reason);
  if (permission.decision === "allow") return { permission, decision, humanApproved: false };
  const opened = answerEpochsOf(manager);
  const fallback: ApprovalRequestInput = {
    ...request,
    id: randomUUID(),
    // The ordinary card draws the fallback with this reason; the first card's code belongs to the first card.
    userOwnedSurfaceReviewFallback: true, reasonCode: undefined,
    reason: permission.reason,
    ...(permission.forceModal ? { forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false } : {}),
  };
  decision = await gate.requestAndWait(fallback);
  if (request.abortSignal?.aborted && decision.choice.startsWith("deny")) return { permission, decision, humanApproved: false };
  request.abortSignal?.throwIfAborted();
  let memoryRecheck: PermissionCheckResult | undefined;
  if (!personAnswerStands(manager, opened, fallback.forceExplicit === true, () => {
    memoryRecheck = manager.recheckPermission(permission, { acrossMemoryRuleChanges: true });
    return memoryRecheck;
  }, { gate, decision })) throw new Error("Permission policy changed while approval was pending.");
  permission = memoryRecheck ?? manager.recheckPermission(permission);
  if (permission.decision === "deny") throw new Error(permission.reason);
  if (decision.choice.startsWith("deny") && !isHostApprovalRejectedDecision(decision)) return personDenied(decision);
  return { permission, decision, humanApproved: decision.choice === "allow-once" && !isHostApprovalRejectedDecision(decision) };
}
