/** The card and the notice for an extension start that nothing confines. */
import { randomUUID } from "node:crypto";
import { isHostApprovalRejectedDecision, isHostApprovalTimeoutDecision, type ApprovalGate } from "./approval-gate.js";
import type { ExtensionStartAsker, PendingExtensionStart } from "./extension-start-consent.js";

export function createExtensionStartAsker(deps: {
  approvalGate: Pick<ApprovalGate, "requestAndWait">;
  /** The localized question on the card. */
  reason: (start: PendingExtensionStart) => string;
  notify: ExtensionStartAsker["notify"];
  record?: ExtensionStartAsker["record"];
}): ExtensionStartAsker {
  return {
    async ask(start, session) {
      if (session.abortSignal?.aborted) return "no-approver";
      const decision = await deps.approvalGate.requestAndWait({
        id: randomUUID(),
        category: "tool",
        toolName: "extension_start",
        args: { start: start.label, kind: start.kind, isolation: "none", cause: start.cause },
        reason: deps.reason(start),
        createdAt: Date.now(),
        sessionId: session.sessionId,
        // One answer for one start: never remembered, never a rule, always a person.
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        forceExplicit: true,
        ...(session.abortSignal ? { abortSignal: session.abortSignal } : {}),
      });
      // A card that timed out or that the host closed was not answered by a person.
      const unanswered: boolean = isHostApprovalRejectedDecision(decision) || isHostApprovalTimeoutDecision(decision);
      if (session.abortSignal?.aborted || unanswered) return "no-approver";
      return decision.choice === "allow-once" ? "yes" : "no";
    },
    notify: deps.notify,
    ...(deps.record ? { record: deps.record } : {}),
  };
}
