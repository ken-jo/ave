/** The card and the notice for extension starts that nothing confines. */
import { randomUUID } from "node:crypto";
import type { ExtensionStartApprovalRow, ExtensionStartChoice } from "../shared/permissions-events.js";
import { isHostApprovalRejectedDecision, isHostApprovalTimeoutDecision, type ApprovalGate } from "./approval-gate.js";
import type { ExtensionStartAsker, PendingExtensionStart } from "./extension-start-consent.js";

export function createExtensionStartAsker(deps: {
  approvalGate: Pick<ApprovalGate, "requestAndWait">;
  /** The localized question on the card, for every start it lists. */
  reason: (starts: readonly PendingExtensionStart[]) => string;
  notify: ExtensionStartAsker["notify"];
  record?: ExtensionStartAsker["record"];
}): ExtensionStartAsker {
  return {
    async ask(starts, session) {
      if (starts.length === 0 || session.abortSignal?.aborted) return "no-approver";
      // A row id names one start on this card only. What it stands for stays here, so an answer can only name a start that was shown.
      const shown = starts.map((start) => ({ start, row: { id: randomUUID(), label: start.label, kind: start.kind, cause: start.cause } satisfies ExtensionStartApprovalRow }));
      const decision = await deps.approvalGate.requestAndWait({
        id: randomUUID(),
        category: "tool",
        kind: "extension-start",
        toolName: "extension_start",
        args: { isolation: "none", starts: shown.map(({ row }) => row) },
        reason: deps.reason(starts),
        createdAt: Date.now(),
        sessionId: session.sessionId,
        // One answer for each start: never remembered, never a rule, always a person.
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        forceExplicit: true,
        ...(session.abortSignal ? { abortSignal: session.abortSignal } : {}),
      });
      // A card that timed out or that the host closed was not answered by a person.
      const unanswered: boolean = isHostApprovalRejectedDecision(decision) || isHostApprovalTimeoutDecision(decision);
      if (session.abortSignal?.aborted || unanswered) return "no-approver";
      const choices: Readonly<Record<string, unknown>> | undefined = decision.extensionStartChoices;
      const answers = new Map<string, ExtensionStartChoice>();
      for (const { start, row } of shown) {
        if (choices !== undefined) {
          const choice = Object.hasOwn(choices, row.id) ? choices[row.id] : undefined;
          if (choice === "yes" || choice === "no") answers.set(start.key, choice);
        } else if (decision.choice !== "allow-once") answers.set(start.key, "no");
        // An allow that names no start speaks for a start only when it was the only one on the card.
        else if (shown.length === 1) answers.set(start.key, "yes");
      }
      return answers;
    },
    notify: deps.notify,
    ...(deps.record ? { record: deps.record } : {}),
  };
}
