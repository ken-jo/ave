import { describe, expect, it } from "vitest";
import { deferred } from "../../../__tests__/support/deferred.js";
import { isAnsweredApprovalDenial, type ApprovalDecision, type ApprovalGate } from "../../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../../permissions/permission-manager.js";
import { HostExitAbortError } from "../../../shared/host-exit-abort.js";
import { resolveUserOwnedSurfaceApproval } from "../user-owned-surface.js";

const ask: PermissionCheckResult = { decision: "ask", reason: "surface review fallback" };

function surfaceFallback() {
  const answer = deferred<ApprovalDecision>();
  const asked = deferred<void>();
  const quit = new AbortController();
  const manager = { recheckPermission: () => ask, setUserOwnedSurfaceChoice: () => {}, getPolicyEpoch: () => "epoch" };
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
    request: { id: "surface-card", userOwnedSurface: "browser", abortSignal: quit.signal } as never,
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
    answer.resolve({ requestId: "fallback-card", choice: "deny-once" });
    quit.abort(new HostExitAbortError());
    await expect(resolution).resolves.toMatchObject({ decision: { choice: "deny-once" }, humanApproved: false });
  });

  it("still ends on the quit when the fallback card was allowed", async () => {
    const { answer, asked, quit, resolution } = surfaceFallback();
    await asked;
    answer.resolve({ requestId: "fallback-card", choice: "allow-once" });
    quit.abort(new HostExitAbortError());
    await expect(resolution).rejects.toBeInstanceOf(HostExitAbortError);
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
  });
});
