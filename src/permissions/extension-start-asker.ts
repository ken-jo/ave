/** The card and the notice for an extension start that nothing confines. */
import { randomUUID } from "node:crypto";
import { isHostApprovalRejectedDecision, type ApprovalGate } from "./approval-gate.js";
import type { ExtensionStartAsker, PendingExtensionStart } from "./extension-start-consent.js";

const KIND_TEXT: Record<PendingExtensionStart["kind"], string> = {
  "plugin-child": "The plugin",
  "mcp-stdio": "The MCP server",
  worker: "The plugin worker",
  "plugin-hook": "The plugin hook",
};

export function createExtensionStartAsker(deps: {
  approvalGate: Pick<ApprovalGate, "requestAndWait">;
  notify: (start: PendingExtensionStart) => void;
}): ExtensionStartAsker {
  return {
    async ask(start, session) {
      if (session.abortSignal?.aborted) return "no-approver";
      const decision = await deps.approvalGate.requestAndWait({
        id: randomUUID(),
        category: "tool",
        toolName: "extension_start",
        args: { start: start.label, kind: start.kind, isolation: "none", cause: start.cause },
        reason: `${KIND_TEXT[start.kind]} ${start.label} would start without OS isolation. Allow this one start?`,
        createdAt: Date.now(),
        sessionId: session.sessionId,
        // One answer for one start: never remembered, never a rule, always a person.
        allowedChoices: ["allow-once", "deny-once"],
        durableApprovalRecordAllowed: false,
        forceExplicit: true,
        ...(session.abortSignal ? { abortSignal: session.abortSignal } : {}),
      });
      const rejected: boolean = isHostApprovalRejectedDecision(decision);
      if (session.abortSignal?.aborted || rejected) return "no-approver";
      return decision.choice === "allow-once" ? "yes" : "no";
    },
    notify: (start) => deps.notify(start),
  };
}
