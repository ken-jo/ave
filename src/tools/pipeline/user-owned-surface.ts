import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { isHostApprovalRejectedDecision, RULE_PROVENANCE, type RuleProvenance } from "../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../permissions/permission-manager.js";
import { abortSupersedesApprovalDecision, isSettledRefusal } from "./approval-outcome.js";

export function userOwnedSurfaceCardFacts(
  permission: PermissionCheckResult,
): Pick<ApprovalRequestInput, "userOwnedSurface" | "userOwnedSurfaceReviewFallback" | "reasonCode"> {
  const request = permission.pipelineRequest;
  if (!request?.userOwnedSurface || permission.forceModal || request.floor || request.manualRerun) return {};
  const reviewFallback = request.exfiltration !== undefined || request.userOwnedSurface.choice === "auto" && request.reviewer !== undefined;
  return {
    userOwnedSurface: request.userOwnedSurface.kind,
    // The surface card shows its own sentence for the decision that asked; no other card reads it, so no other card is sent it. A review fallback
    // is drawn by the ordinary card, with the host's reason.
    ...(reviewFallback ? { userOwnedSurfaceReviewFallback: true as const }
      : permission.reasonCode === undefined ? {} : { reasonCode: permission.reasonCode }),
  };
}

/** Selection receipts change session policy only after this live native card authorizes them. The result marks a decision the
 * current policy made in place of the card with the rule's provenance; any other decision is one the gate returned, with its own. */
export async function resolveUserOwnedSurfaceApproval(input: {
  manager: PermissionManager;
  gate: ApprovalGate;
  permission: PermissionCheckResult;
  decision: ApprovalDecision;
  request: ApprovalRequestInput;
  sessionId: string | undefined;
  review: (permission: PermissionCheckResult) => Promise<PermissionCheckResult>;
}): Promise<{ permission: PermissionCheckResult; decision: ApprovalDecision; provenance?: RuleProvenance }> {
  const { manager, gate, request, sessionId } = input;
  let { permission, decision } = input;
  if (!request.userOwnedSurface || !sessionId || !decision.choice.startsWith("allow") || Boolean(isHostApprovalRejectedDecision(decision))) return { permission, decision };
  permission = manager.recheckPermission(permission);
  if (permission.decision === "deny") return { permission, decision: { requestId: decision.requestId, choice: "deny-once" }, provenance: RULE_PROVENANCE };
  if (permission.forceModal && !request.forceExplicit) return { permission, decision: { requestId: decision.requestId, choice: "deny-once" }, provenance: RULE_PROVENANCE };
  if (request.userOwnedSurfaceReviewFallback) return { permission, decision };
  const choice = gate.consumeUserOwnedSurfaceChoice(decision, sessionId, request.userOwnedSurface);
  if (choice === undefined) throw new Error("User-owned surface approval receipt is unavailable.");
  manager.setUserOwnedSurfaceChoice(sessionId, request.userOwnedSurface, choice);
  if (choice !== "auto") return { permission, decision };
  permission = manager.recheckPermission(permission);
  if (permission.reviewer && permission.decision === "ask") permission = await input.review(permission);
  if (permission.decision === "deny") throw new Error(permission.reason);
  if (permission.decision === "allow") return { permission, decision, provenance: RULE_PROVENANCE };
  const epoch = manager.getPolicyEpoch();
  const fallback: ApprovalRequestInput = {
    ...request,
    id: randomUUID(),
    // The ordinary card draws the fallback with this reason; the first card's code belongs to the first card.
    userOwnedSurfaceReviewFallback: true, reasonCode: undefined,
    reason: permission.reason,
    ...(permission.forceModal ? { forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false } : {}),
  };
  decision = await gate.requestAndWait(fallback);
  if (abortSupersedesApprovalDecision(request.abortSignal, decision)) request.abortSignal?.throwIfAborted();
  // A settled refusal is terminal: neither a policy change nor the refreshed permission reopens it.
  if (isSettledRefusal(decision)) return { permission, decision };
  if (epoch !== manager.getPolicyEpoch() && !gate.allowsPolicyTransition(decision, epoch, manager.getPolicyEpoch())) throw new Error("Permission policy changed while approval was pending.");
  permission = manager.recheckPermission(permission);
  if (permission.decision === "deny") throw new Error(permission.reason);
  return { permission, decision };
}
