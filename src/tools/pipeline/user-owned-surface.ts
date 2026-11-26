import { t } from "../../i18n/runtime.js";
import { openPendingAnswerCard, personAnswerStands, type StandingAnswer, type StandingAnswerUse } from "../../permissions/pending-answer-policy.js";
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

/** Selection receipts change session policy only after this live native card authorizes them. `answer` is the standing answer to the
 * card that got `decision`; the result's `answer` is the person's standing answer the settled permission rests on, if any. */
export async function resolveUserOwnedSurfaceApproval(input: {
  manager: PermissionManager;
  gate: ApprovalGate;
  permission: PermissionCheckResult;
  decision: ApprovalDecision;
  answer: StandingAnswer | undefined;
  action: string;
  /** The kinds of use `action` needs; the fallback card declares the same ones. */
  uses: readonly StandingAnswerUse[];
  request: ApprovalRequestInput;
  sessionId: string | undefined;
  review: (permission: PermissionCheckResult) => Promise<PermissionCheckResult>;
}): Promise<{ permission: PermissionCheckResult; decision: ApprovalDecision; answer: StandingAnswer | undefined }> {
  const { manager, gate, request, sessionId } = input;
  let { permission, decision } = input;
  // A person's Deny is a deny permission from here on, whatever a re-check of the call said: no caller has to read the choice again
  // to keep a denied call from running.
  const personDenied = (denial: ApprovalDecision): { permission: PermissionCheckResult; decision: ApprovalDecision; answer: undefined } => ({
    permission: permission.decision === "deny" ? permission : { ...permission, decision: "deny", reason: t("be_executor.approvalDeniedByUser", { name: request.toolName }) },
    decision: denial, answer: undefined,
  });
  if (decision.choice.startsWith("deny") && !isHostApprovalRejectedDecision(decision)) return personDenied(decision);
  if (!request.userOwnedSurface || !sessionId || !decision.choice.startsWith("allow") || Boolean(isHostApprovalRejectedDecision(decision))) return { permission, decision, answer: input.answer };
  permission = manager.recheckPermission(permission);
  if (permission.decision === "deny") return { permission, decision: { requestId: decision.requestId, choice: "deny-once" }, answer: undefined };
  if (permission.forceModal && !request.forceExplicit) return { permission, decision: { requestId: decision.requestId, choice: "deny-once" }, answer: undefined };
  if (request.userOwnedSurfaceReviewFallback) return { permission, decision, answer: input.answer };
  const choice = gate.consumeUserOwnedSurfaceChoice(decision, sessionId, request.userOwnedSurface);
  if (choice === undefined) throw new Error("User-owned surface approval receipt is unavailable.");
  manager.setUserOwnedSurfaceChoice(sessionId, request.userOwnedSurface, choice);
  if (choice !== "auto") return { permission, decision, answer: input.answer };
  permission = manager.recheckPermission(permission);
  if (permission.reviewer && permission.decision === "ask") permission = await input.review(permission);
  if (permission.decision === "deny") throw new Error(permission.reason);
  if (permission.decision === "allow") return { permission, decision, answer: undefined };
  const openedEpoch = manager.getPolicyEpoch();
  const fallbackId = randomUUID();
  const card = openPendingAnswerCard(manager, permission, () => manager.getPolicyEpoch() === openedEpoch
    ? manager.recheckPermission(permission) : manager.recheckPermission(permission, { acrossMemoryRuleChanges: true }), "stale-refused",
    { gate, requestId: fallbackId, action: input.action, uses: input.uses });
  const fallback: ApprovalRequestInput = {
    ...request,
    id: fallbackId,
    // The ordinary card draws the fallback with this reason; the first card's code belongs to the first card.
    userOwnedSurfaceReviewFallback: true, reasonCode: undefined,
    reason: permission.reason,
    ...(permission.forceModal ? { forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false } : {}),
  };
  decision = await gate.requestAndWait(fallback);
  if (request.abortSignal?.aborted && decision.choice.startsWith("deny")) return { permission, decision, answer: undefined };
  request.abortSignal?.throwIfAborted();
  personAnswerStands(card, decision);
  const verdict = card.verdict ?? { kind: "policy-changed" as const };
  if (verdict.kind === "policy-changed") throw new Error("Permission policy changed while approval was pending.");
  if ("fresh" in verdict) {
    permission = verdict.fresh;
    if (permission.decision === "deny") throw new Error(permission.reason);
    if (verdict.kind === "stale" && !isHostApprovalRejectedDecision(decision)) throw new Error(t("be_executor.answerQuestionChanged"));
  }
  if (decision.choice.startsWith("deny") && !isHostApprovalRejectedDecision(decision)) return personDenied(decision);
  return { permission, decision, answer: verdict.kind === "stands" && decision.choice === "allow-once" ? verdict.proof : undefined };
}
