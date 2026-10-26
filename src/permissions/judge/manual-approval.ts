import type { ApprovalDecision } from "../approval-gate.js";

const manualApprovalSessions = new WeakMap<ApprovalDecision, string>();

// Called only after the gate verifies an explicit desktop answer's integrity.
export function recordManualApproval(decision: ApprovalDecision, sessionId: string): void {
  if (decision.choice.startsWith("allow")) manualApprovalSessions.set(decision, sessionId);
}

export function consumeManualApproval(decision: ApprovalDecision, sessionId: string): boolean {
  if (manualApprovalSessions.get(decision) !== sessionId) return false;
  manualApprovalSessions.delete(decision);
  return true;
}
