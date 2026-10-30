import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { isHostApprovalRejectedDecision } from "../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../permissions/permission-manager.js";

export function userOwnedSurfaceCardFacts(permission: PermissionCheckResult): Pick<ApprovalRequestInput, "userOwnedSurface" | "userOwnedSurfaceReviewFallback"> {
  const request = permission.pipelineRequest;
  if (!request?.userOwnedSurface || permission.forceModal || request.floor || request.manualRerun) return {};
  return {
    userOwnedSurface: request.userOwnedSurface.kind,
    ...(request.exfiltration !== undefined || request.userOwnedSurface.choice === "auto" && request.reviewer !== undefined
      ? { userOwnedSurfaceReviewFallback: true as const } : {}),
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
  const epoch = manager.getPolicyEpoch();
  const fallback: ApprovalRequestInput = {
    ...request,
    id: randomUUID(),
    userOwnedSurfaceReviewFallback: true,
    reason: permission.reason,
    ...(permission.forceModal ? { forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false } : {}),
  };
  decision = await gate.requestAndWait(fallback);
  request.abortSignal?.throwIfAborted();
  if (epoch !== manager.getPolicyEpoch() && !gate.allowsPolicyTransition(decision, epoch, manager.getPolicyEpoch())) throw new Error("Permission policy changed while approval was pending.");
  permission = manager.recheckPermission(permission);
  if (permission.decision === "deny") throw new Error(permission.reason);
  return { permission, decision, humanApproved: decision.choice === "allow-once" && !isHostApprovalRejectedDecision(decision) };
}
