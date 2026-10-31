// Shared keyboard-origin request anchors and scripted rationale responses; keep domain dependencies out of general test helpers.
import { randomUUID } from "node:crypto";
import {
  createRequestAnchor,
  RATIONALE_CONTROL_CONTRACT_VERSION,
  type RationaleRequiredControl,
  type RequestAnchor,
} from "../rationale-control.js";
import type { InvocationAuditRecord } from "../rationale-ticket-lifecycle.js";

type RequestAnchorInput = Parameters<typeof createRequestAnchor>[0];

// A null anchor means the fixture is invalid and must throw.
export function createTestRequestAnchor(
  overrides: Partial<RequestAnchorInput> = {},
): RequestAnchor {
  const anchor = createRequestAnchor({
    sessionId: "session-rationale",
    turnId: "turn-rationale",
    inputMessageId: "message-rationale",
    inputOrigin: "user-keyboard",
    rawIntent: "Perform the requested operation.",
    ...overrides,
  });
  if (!anchor) throw new Error("test request anchor was not created");
  return anchor;
}

export function rationaleResponseFor(
  control: RationaleRequiredControl,
  suggestion: string,
) {
  return {
    contractVersion: 1,
    anchorId: control.anchor.anchorId,
    ticketId: control.ticketId,
    actionDigest: control.action.actionDigest,
    round: 1,
    choice: "resubmit",
    rationale: suggestion,
    userQuote: control.anchor.sanitizedIntent,
  } as const;
}

// Real authorization records always pair authorized with automaticRetry forbidden; only identifiers vary.
export function authorizedInvocationRecord(
  overrides: Partial<InvocationAuditRecord> = {},
): InvocationAuditRecord {
  return {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: randomUUID(),
    actionDigest: "c".repeat(64),
    invocationDigest: "d".repeat(64),
    toolUseId: "tool-use-authorized",
    authorizationReceiptId: randomUUID(),
    invocationStartLeaseId: null,
    version: 0,
    state: "authorized",
    automaticRetry: "forbidden",
    ...overrides,
  };
}
