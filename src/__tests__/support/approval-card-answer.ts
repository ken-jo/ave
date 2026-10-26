import type { ApprovalDecision, ApprovalRequest } from "../../permissions/approval-gate.js";

/** Echo the issued card integrity fields; the real gate still verifies the native responder. */
export function allowOnceCardAnswer(card: ApprovalRequest): ApprovalDecision {
  return { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac };
}
