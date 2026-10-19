/**
 * The egress ask on the approval surface: turns an `EgressApprovalRequest`
 * into an `egress-host` ApprovalGate request and its answer back into a
 * scope. A shell tool call's ask is drawn on its conversation's dock; a
 * terminal tab's carries `terminalTabId`, and is drawn in that tab's banner
 * in the window that owns the tab.
 *
 * The card offers Deny once and an allow per scope; the renderer answers
 * `allow-once` with the scope it picked (`ApprovalDecision.egressScope`), and
 * the gate refuses any answer whose scope the card did not offer. Nothing is
 * written to the user-approval store: the grant store owns egress grants.
 */
import { randomUUID } from "node:crypto";
import {
  isHostApprovalRejectedDecision,
  isHostApprovalTimeoutDecision,
  type ApprovalGate,
} from "./approval-gate.js";
import type { EgressApprovalAnswer, EgressApprovalRequester } from "./egress-ask.js";

/** The tool name a terminal tab's egress ask carries on the gate (its audit rows and card). */
const TERMINAL_EGRESS_TOOL_NAME = "terminal";

export const EGRESS_APPROVAL_DENY_REASONS = {
  denied: "denied by the user",
  timeout: "network approval timed out",
  rejected: "network approval answer was rejected",
} as const;

export function createApprovalGateEgressRequester(
  gate: Pick<ApprovalGate, "requestAndWait">,
): EgressApprovalRequester {
  return async (request): Promise<EgressApprovalAnswer> => {
    const { host, port } = request.destination;
    const terminal = request.origin === "terminal";
    // A terminal's ask names its tab: the gate draws it in the window that
    // owns that tab, and the renderer in the tab's banner.
    const toolName = terminal ? TERMINAL_EGRESS_TOOL_NAME : request.toolName;
    const decision = await gate.requestAndWait({
      id: randomUUID(),
      category: "tool",
      kind: "egress-host",
      toolName,
      args: terminal ? { host, port, tabId: request.tabId } : { host, port },
      reason: terminal
        ? `A command in workspace terminal ${request.tabId} wants to connect to ${host}:${port}.`
        : `The sandboxed ${request.toolName} command wants to connect to ${host}:${port}.`,
      createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"],
      // A grant is recorded by the egress grant store, never as a
      // user-approval-store record, and the card must be answered by a person.
      durableApprovalRecordAllowed: false,
      forceExplicit: true,
      isReadOnly: false,
      egressHost: {
        host,
        port,
        scopes: [...request.scopes],
        network: request.network,
        ...(terminal ? { terminalTabId: request.tabId } : {}),
      },
      ...(request.origin === "shell" && request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
    });
    if (decision.choice === "allow-once" && decision.egressScope !== undefined && request.scopes.includes(decision.egressScope)) {
      return { allow: true, scope: decision.egressScope };
    }
    return {
      allow: false,
      reason: isHostApprovalTimeoutDecision(decision)
        ? EGRESS_APPROVAL_DENY_REASONS.timeout
        : isHostApprovalRejectedDecision(decision)
          ? EGRESS_APPROVAL_DENY_REASONS.rejected
          : EGRESS_APPROVAL_DENY_REASONS.denied,
    };
  };
}
