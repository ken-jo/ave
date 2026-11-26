import { RULE_PROVENANCE } from "../../../permissions/decision-provenance.js";
import { describe, expect, it } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { abortSupersedesApprovalDecision } from "../approval-outcome.js";
import {
  ApprovalGate,
  IPC_APPROVAL_REQUEST,
  approvalDecisionTrustOrigin,
  isAnsweredApprovalDenial,
  type ApprovalDecision,
  type ApprovalRequest,
} from "../../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../../permissions/permission-manager.js";
import { HostExitAbortError } from "../../../shared/host-exit-abort.js";
import { resolveUserOwnedSurfaceApproval } from "../user-owned-surface.js";

const ask: PermissionCheckResult = { decision: "ask", provenance: RULE_PROVENANCE, reason: "surface review fallback" };

// A deny a person answered on a real gate, so it carries the gate's record of who decided.
async function answeredDeny(answeredBy: "desk" | "platform-bridge" = "desk"): Promise<ApprovalDecision> {
  const card = deferred<ApprovalRequest>();
  const gate = new ApprovalGate({
    isDestroyed: () => false,
    send: (channel: string, request: ApprovalRequest) => { if (channel === IPC_APPROVAL_REQUEST) card.resolve(request); },
  } as never);
  const decision = gate.requestAndWait({ id: "fallback-card", category: "tool", toolName: "probe", args: {}, reason: "probe", createdAt: Date.now() });
  const asked = await card.promise;
  gate.resolve(asked.id, { requestId: asked.id, choice: "deny-once", nonce: asked.nonce, hmac: asked.hmac }, answeredBy);
  return decision;
}

function surfaceFallback() {
  const answer = deferred<ApprovalDecision>();
  const asked = deferred<void>();
  const quit = new AbortController();
  const manager = { recheckPermission: () => ask, setUserOwnedSurfaceChoice: () => {}, getPolicyEpoch: () => "epoch", getPolicyContextEpoch: () => "epoch" };
  const gate = {
    consumeUserOwnedSurfaceChoice: () => "auto",
    requestAndWait: () => { asked.resolve(); return answer.promise; },
    allowsPolicyTransition: () => false,
  };
  const resolution = resolveUserOwnedSurfaceApproval({
    manager: manager as unknown as PermissionManager,
    gate: gate as unknown as ApprovalGate,
    permission: ask,
    decision: { requestId: "surface-card", choice: "allow-once" },
    request: { id: "surface-card", toolName: "probe", userOwnedSurface: "browser", abortSignal: quit.signal } as never,
    sessionId: "surface-session",
    review: async (permission) => permission,
  });
  return { answer, asked: asked.promise, quit, resolution };
}

describe("user-owned surface approval across the quit seal", () => {
  it("returns the fallback card's answered deny when the quit lands before it resumes", async () => {
    const { answer, asked, quit, resolution } = surfaceFallback();
    await asked;
    // The person's answer settles the card; the quit lands before the awaiting resolution runs again.
    answer.resolve(await answeredDeny());
    quit.abort(new HostExitAbortError());
    // The deny is the gate's own answer, not one the policy put in its place.
    const resolved = await resolution;
    expect(resolved.decision.choice).toBe("deny-once");
    expect(resolved.provenance).toBeUndefined();
  });

  it("ends on the quit for a deny no person answered through the gate", async () => {
    const { answer, asked, quit, resolution } = surfaceFallback();
    await asked;
    answer.resolve({ requestId: "fallback-card", choice: "deny-once" });
    quit.abort(new HostExitAbortError());
    // The cancellation comes back for the caller to end as a stop, so its terminal writer still runs.
    const resolved = await resolution;
    expect(abortSupersedesApprovalDecision(quit.signal, resolved.decision)).toBe(true);
    expect(resolved.provenance).toBeUndefined();
  });

  it("still ends on the quit when the fallback card was allowed", async () => {
    const { answer, asked, quit, resolution } = surfaceFallback();
    await asked;
    answer.resolve({ requestId: "fallback-card", choice: "allow-once" });
    quit.abort(new HostExitAbortError());
    const resolved = await resolution;
    expect(abortSupersedesApprovalDecision(quit.signal, resolved.decision)).toBe(true);
  });

  it("marks a policy recheck's deny as the host's, not a person's answer", async () => {
    const resolution = await resolveUserOwnedSurfaceApproval({
      manager: { recheckPermission: () => ({ decision: "deny", reason: "rule denies" }) } as unknown as PermissionManager,
      gate: {} as ApprovalGate,
      permission: ask,
      decision: { requestId: "surface-card", choice: "allow-once" },
      request: { id: "surface-card", userOwnedSurface: "browser" } as never,
      sessionId: "surface-session",
      review: async (permission) => permission,
    });
    expect(resolution.decision.choice).toBe("deny-once");
    expect(isAnsweredApprovalDenial(resolution.decision)).toBe(false);
    expect(resolution.provenance).toEqual({ kind: "rule" });
  });

  it.each([
    ["desk", "user-keyboard"],
    ["platform-bridge", "platform-bridge"],
  ] as const)("records who answered a %s deny on the decision itself", async (answeredBy, origin) => {
    const decision = await answeredDeny(answeredBy);
    expect(approvalDecisionTrustOrigin(decision)).toBe(origin);
    expect(isAnsweredApprovalDenial(decision)).toBe(true);
    // A copy is not the gate's decision, so it carries no answerer.
    expect(isAnsweredApprovalDenial({ ...decision })).toBe(false);
  });
});
