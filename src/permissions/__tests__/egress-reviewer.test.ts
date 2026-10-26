import { describe, expect, it, vi } from "vitest";
import { reviewerJudgeOutcomeForTest } from "../../__tests__/support/reviewer-judge.js";
import type { PermissionManager } from "../permission-manager.js";
import { createApprovalGateEgressRequester } from "../egress-approval.js";
import type { EgressShellApprovalRequest } from "../egress-ask.js";

const request: EgressShellApprovalRequest = {
  origin: "shell", toolName: "bash", toolUseId: "call-1", sessionId: "session-1",
  workspaceRoot: "/workspace/project",
  destination: { host: "downloads.example.com", port: 443 },
  scopes: ["once", "always"], network: "public", abortSignal: undefined,
};

function reviewer(decision: "allow" | "ask", mode: "auto" | "default" = "auto") {
  const dispatchReviewer = vi.fn(async () => ({
    verdict: { level: decision === "allow" ? "low" : "medium", reason: "reviewed destination" },
    outcome: "host-determined", cacheReason: "miss-not-found",
    judge: reviewerJudgeOutcomeForTest(decision, "reviewed destination"),
  }));
  return {
    getMode: () => mode, hasJudge: () => false, dispatchReviewer,
    resumeAutomatedApproval: vi.fn(),
  };
}

describe("sandbox domain review", () => {
  // A background (headless) request never reaches the requester: egress-ask denies it before asking (I5, owner 2026-10-16).
  it("escalates an ambiguous auto-reviewed request to the existing approval gate", async () => {
    const manager = reviewer("ask");
    const requestAndWait = vi.fn(async () => ({ requestId: "network-ask", choice: "deny-once" as const }));
    await expect(createApprovalGateEgressRequester({ requestAndWait }, manager as unknown as PermissionManager)(request))
      .resolves.toEqual({ allow: false, reason: "denied by the user" });
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({
      kind: "egress-host", toolCategory: "network", durableApprovalRecordAllowed: false,
      allowedChoices: ["allow-once", "deny-once"],
      reviewerVerdict: { level: "medium", reason: "reviewed destination" },
    }));
  });

  it("reviews an attended auto request through the foreground lane", async () => {
    const manager = reviewer("allow");
    const requestAndWait = vi.fn();
    await createApprovalGateEgressRequester({ requestAndWait }, manager as unknown as PermissionManager)(request);
    expect(manager.dispatchReviewer).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      evaluationContext: expect.objectContaining({ headless: false }),
    }), undefined, { defer: "none" });
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("keeps an attended ordinary request on its approval dock", async () => {
    const manager = reviewer("allow", "default");
    const requestAndWait = vi.fn(async () => ({ requestId: "network-ask", choice: "allow-once" as const, egressScope: "always" as const }));
    await expect(createApprovalGateEgressRequester({ requestAndWait }, manager as unknown as PermissionManager)(request))
      .resolves.toEqual({ allow: true, scope: "always" });
    expect(manager.dispatchReviewer).not.toHaveBeenCalled();
  });
});
