import { t } from "../../i18n/runtime.js";
import { bindPendingAnswerRequest, openPendingAnswerCard, personAnswerStands, saveStandingAnswerRule, type StandingAnswer, type StandingAnswerUse } from "../../permissions/pending-answer-policy.js";
import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { HOST_PROVENANCE, isHostApprovalRejectedDecision, isHostApprovalTimeoutDecision, RULE_PROVENANCE, type HostProvenance, type RuleProvenance } from "../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../permissions/permission-manager.js";
import { errorMessage } from "../../shared/error-message.js";
import { abortSupersedesApprovalDecision, isSettledRefusal, refusal } from "./approval-outcome.js";

type SurfaceResolution = {
  permission: PermissionCheckResult;
  decision: ApprovalDecision;
  provenance?: RuleProvenance | HostProvenance;
  answer: StandingAnswer | undefined;
};

function refused(decision: ApprovalDecision, reason: string, provenance: RuleProvenance | HostProvenance): SurfaceResolution {
  return { permission: refusal(reason, provenance), decision: { requestId: decision.requestId, choice: "deny-once" }, provenance, answer: undefined };
}

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

/** Selection receipts change session policy only after this live native card authorizes them. The result marks a decision the
 * current policy made in place of the card with the rule's provenance, and a failure of the host with the host's. A standing answer
 * authorizes only the action and card that issued it. An abort returns the caller's decision for the caller to end as a stop. */
export async function resolveUserOwnedSurfaceApproval(input: SurfaceInput): Promise<SurfaceResolution> {
  try {
    return await resolveSurface(input);
  } catch (error) {
    if (input.request.abortSignal?.aborted) return { permission: input.permission, decision: input.decision, answer: undefined };
    return refused(input.decision, errorMessage(error), HOST_PROVENANCE);
  }
}

type SurfaceInput = {
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
};

async function resolveSurface(input: SurfaceInput): Promise<SurfaceResolution> {
  const { manager, gate, request, sessionId } = input;
  let { permission, decision } = input;
  // A person's Deny is a deny permission from here on, whatever a re-check of the call said: no caller has to read the choice again
  // to keep a denied call from running.
  const personDenied = (denial: ApprovalDecision): { permission: PermissionCheckResult; decision: ApprovalDecision; answer: undefined } => ({
    permission: permission.decision === "deny" ? permission : { ...permission, decision: "deny", reason: t("be_executor.approvalDeniedByUser", { name: request.toolName }) },
    decision: denial, answer: undefined,
  });
  if (isSettledRefusal(decision)) {
    return isHostApprovalRejectedDecision(decision) || isHostApprovalTimeoutDecision(decision)
      ? { permission, decision, answer: undefined } : personDenied(decision);
  }
  if (!request.userOwnedSurface || !sessionId) return { permission, decision, answer: input.answer };
  permission = manager.recheckPermission(permission);
  if (permission.decision === "deny" || permission.forceModal && !request.forceExplicit) return refused(decision, permission.reason, RULE_PROVENANCE);
  if (request.userOwnedSurfaceReviewFallback) return { permission, decision, answer: input.answer };
  const choice = gate.consumeUserOwnedSurfaceChoice(decision, sessionId, request.userOwnedSurface);
  if (choice === undefined) return refused(decision, "User-owned surface approval receipt is unavailable.", HOST_PROVENANCE);
  manager.setUserOwnedSurfaceChoice(sessionId, request.userOwnedSurface, choice);
  if (choice !== "auto") return { permission, decision, answer: input.answer };
  permission = manager.recheckPermission(permission);
  if (permission.reviewer && permission.decision === "ask") permission = await input.review(permission);
  if (permission.decision === "deny") return refused(decision, permission.reason, RULE_PROVENANCE);
  if (permission.decision === "allow") return { permission, decision, answer: undefined, provenance: RULE_PROVENANCE };
  const openedEpoch = manager.getPolicyEpoch();
  const fallbackId = randomUUID();
  const card = openPendingAnswerCard(manager, permission, () => manager.getPolicyEpoch() === openedEpoch
    ? manager.recheckPermission(permission) : manager.recheckPermission(permission, { acrossMemoryRuleChanges: true }), "stale-refused",
    { gate, requestId: fallbackId, action: input.action, uses: ["rule-save", ...input.uses] });
  const fallback: ApprovalRequestInput = {
    ...request,
    id: fallbackId,
    // The ordinary card draws the fallback with this reason; the first card's code belongs to the first card.
    userOwnedSurfaceReviewFallback: true, reasonCode: undefined,
    reason: permission.reason,
    ...(permission.forceModal ? { forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false } : {}),
  };
  decision = await gate.requestAndWait(bindPendingAnswerRequest(fallback, card));
  if (abortSupersedesApprovalDecision(request.abortSignal, decision)) return { permission, decision, answer: undefined };
  if (isSettledRefusal(decision)) {
    return isHostApprovalRejectedDecision(decision) || isHostApprovalTimeoutDecision(decision)
      ? { permission, decision, answer: undefined } : personDenied(decision);
  }
  personAnswerStands(card, decision);
  const verdict = card.verdict ?? { kind: "policy-changed" as const };
  if (verdict.kind === "policy-changed") return refused(decision, "Permission policy changed while approval was pending.", RULE_PROVENANCE);
  if ("fresh" in verdict) {
    permission = verdict.fresh;
    if (permission.decision === "deny") return refused(decision, permission.reason, RULE_PROVENANCE);
    if (verdict.kind === "stale") return refused(decision, t("be_executor.answerQuestionChanged"), RULE_PROVENANCE);
  }
  const refusal = (await saveStandingAnswerRule(card, decision)).refusal;
  if (refusal !== undefined) return refused(decision, refusal, RULE_PROVENANCE);
  return { permission, decision, answer: verdict.kind === "stands" && decision.choice === "allow-once" ? verdict.proof : undefined };
}
