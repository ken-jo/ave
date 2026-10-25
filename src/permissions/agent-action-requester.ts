// Only the gate mints nonce/HMAC; callers receive one-shot choices and cannot create persistent grants. Record issuer and scope at request time, then verify both on response; violations throw without downgrade.

import { randomUUID } from "node:crypto";
import type { ApprovalGate } from "./approval-gate.js";
import type { ApprovalChoice } from "./approval-gate.js";

export interface AgentApprovalInput {
  toolName: string;
  args: unknown;
  reason: string;
  source: "plugin";
  sourcePluginId: string;
  // Approval action scope — must be listed in the issuer's approved grant.
  scope: string;
}

// Per-request issuer metadata recorded at requestAgentApproval time.
interface IssuerEntry {
  issuerPluginId: string;
  scope: string;
  // Wall-clock ms at which this entry was recorded — used by `purgeStalerThan`.
  recordedAt: number;
}

// Record issuer/scope before requesting; consume once on response and purge stale unanswered entries after gate timeout.
export class ApprovalIssuerRegistry {
  private readonly entries = new Map<string, IssuerEntry>();

  record(requestId: string, issuerPluginId: string, scope: string): void {
    this.entries.set(requestId, {
      issuerPluginId,
      scope,
      recordedAt: Date.now(),
    });
  }

  // Retrieve and remove the issuer entry for `requestId`. Returns null if the entry was never recorded or already consumed.
  consume(requestId: string): IssuerEntry | null {
    const entry = this.entries.get(requestId);
    if (!entry) return null;
    this.entries.delete(requestId);
    return entry;
  }

  // Explicit deletion (no-op if absent). Used by `requestAgentApproval`'s try-finally to prune the entry when the gate throws — without this the entry would leak until `purgeStalerThan` runs.
  delete(requestId: string): void {
    this.entries.delete(requestId);
  }

  // Non-destructive lookup — returns the entry if present, undefined otherwise. Does NOT remove the entry (unlike `consume`). Intended for testing and diagnostic code paths only; production code should use `consume`.
  peek(requestId: string): IssuerEntry | undefined {
    return this.entries.get(requestId);
  }

  // Remove all entries older than `maxAgeMs` milliseconds from `now`. Called by the gate timeout path to prevent unbounded growth when the respond path is never reached (e.g. renderer crash). Returns the count of purged entries.
  purgeStalerThan(maxAgeMs: number, now: number = Date.now()): number {
    const cutoff = now - maxAgeMs;
    let purged = 0;
    for (const [requestId, entry] of this.entries) {
      if (entry.recordedAt < cutoff) {
        this.entries.delete(requestId);
        purged += 1;
      }
    }
    return purged;
  }

  get size(): number {
    return this.entries.size;
  }
}

// Verify that a plugin is allowed to issue an approval request for `scope`. This check must run on the request path, not only on respond, because requestAgentApproval returns the user's choice directly to plugin code.
export function verifyApprovalRequestScope(
  issuerPluginId: string,
  scope: string,
  allowedScopes: readonly string[],
): void {
  if (allowedScopes.includes(scope)) return;
  throw new ApprovalOriginError(
    `[approval-gating] request denied: scope='${scope}' is not in ` +
    `issuer='${issuerPluginId}' agentApprovalScopes=[${allowedScopes.join(",")}]`,
    "scope-not-allowed",
  );
}

// Host-internal only; plugins use hostApi.agentApproval.request. Record issuer/scope before asking to avoid response races; only the gate mints nonce/HMAC. Timeout or non-one-shot choices deny, and thrown gates remove the issuer entry in finally.
export async function requestAgentApproval(
  gate: ApprovalGate,
  input: AgentApprovalInput,
  registry: ApprovalIssuerRegistry,
): Promise<ApprovalChoice> {
  if (!registry) {
    throw new Error("ApprovalIssuerRegistry is required for plugin approval requests");
  }
  const requestId = randomUUID();

  // Record issuer BEFORE gate.requestAndWait so the respond path always sees the entry regardless of how fast the user responds.
  registry.record(requestId, input.sourcePluginId, input.scope);

  let settled = false;
  try {
    const decision = await gate.requestAndWait({
      id: requestId,
      category: "agent-action",
      kind: "agent-action",
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      toolName: input.toolName,
      toolCategory: "meta",
      args: input.args,
      reason: input.reason,
      source: input.source,
      sourcePluginId: input.sourcePluginId,
      approvalScope: input.scope,
      createdAt: Date.now(),
    });
    settled = true;
    return decision.choice === "allow-once" ? "allow-once" : "deny-once";
  } finally {
    // On gate throw (settled=false) we must purge the entry we just recorded, otherwise a subsequent malicious respond with the same id (replay or guessed UUID) could see a leaked issuer mapping. On normal resolve we leave the entry — the respond path consumes it.
    if (!settled) registry.delete(requestId);
  }
}

// Verify that `responderPluginId` is authorized to respond to `requestId`. Checks: (a) entry exists in registry (request was issued by this process) (b) responderPluginId == entry.issuerPluginId (c) entry.scope is listed in allowedScopes (issuer's approved grant) Throws `ApprovalOriginError` on any violation. Consumes the entry from the registry on success. @param registry - Shared ApprovalIssuerRegistry. @param requestId - The approval request ID being responded to. @param responderPluginId - Plugin id of the IPC caller. @param allowedScopes - agentApprovalScopes from the host-approved grant. @returns - The consumed IssuerEntry (for audit logging).
export function verifyApprovalResponder(
  registry: ApprovalIssuerRegistry,
  requestId: string,
  responderPluginId: string,
  allowedScopes: string[],
): IssuerEntry {
  const entry = registry.consume(requestId);

  if (!entry) {
    throw new ApprovalOriginError(
      `[approval-gating] respond denied: no pending approval found for requestId='${requestId}' — unknown or already consumed`,
      "unknown-request",
    );
  }

  if (entry.issuerPluginId !== responderPluginId) {
    // Re-insert so the legitimate issuer can still respond (best-effort)
    registry.record(requestId, entry.issuerPluginId, entry.scope);
    throw new ApprovalOriginError(
      `[approval-gating] respond denied: cross-plugin attack detected — ` +
      `responder='${responderPluginId}' is not the issuer='${entry.issuerPluginId}' ` +
      `for requestId='${requestId}'`,
      "cross-plugin-hijack",
    );
  }

  if (!allowedScopes.includes(entry.scope)) {
    throw new ApprovalOriginError(
      `[approval-gating] respond denied: scope='${entry.scope}' is not in ` +
      `issuer='${responderPluginId}' agentApprovalScopes=[${allowedScopes.join(",")}] ` +
      `for requestId='${requestId}'`,
      "scope-not-allowed",
    );
  }

  return entry;
}

// Thrown by verifyApprovalResponder on any origin/scope violation.
export class ApprovalOriginError extends Error {
  readonly code: "unknown-request" | "cross-plugin-hijack" | "scope-not-allowed";
  constructor(message: string, code: ApprovalOriginError["code"]) {
    super(message);
    this.name = "ApprovalOriginError";
    this.code = code;
  }
}
