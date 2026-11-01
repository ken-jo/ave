import { describe, expect, it } from "vitest";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import { wireJudgeForTest } from "../../__tests__/support/reviewer-judge.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { issueApprovalRuleBasis, type ApprovalRuleBasis } from "../approval-rule-evidence.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { PermissionManager } from "../permission-manager.js";
import type { ToolInvocationContext } from "../reviewer/risk-classifier.js";
import { resolveReviewerSandboxCapability } from "../sandbox-capability.js";

function invocation(): ToolInvocationContext {
  return {
    toolName: "network_probe", source: "builtin", category: "network", pathFields: [],
    trustOrigin: "user-keyboard", finalInput: { url: "https://service.example.test/action" },
    executionCwd: "/workspace/project", allowedDirectories: ["/workspace/project"], sensitivePathsAdjacent: [],
    sandboxCapability: resolveReviewerSandboxCapability("builtin", "network_probe"),
  };
}

function request(): ApprovalRequestInput {
  const context = invocation();
  return {
    id: "rule-basis-card", category: "tool", toolName: context.toolName, source: context.source,
    toolCategory: context.category, trustOrigin: context.trustOrigin, args: context.finalInput,
    reason: "Human approval required", createdAt: Date.now(), approvalCacheKey: "network-action",
    reviewerVerdict: { level: "high", reason: "No automatic assessment" },
    evaluationContext: buildPermissionEvaluationContext({
      ...context, headless: false, policyMode: "strict", targetFilePaths: [],
    }),
  };
}

async function cardSnapshot(input: ApprovalRequestInput) {
  const surface = makeMockWebContents();
  const gate = new ApprovalGate(surface as never);
  const pending = gate.requestAndWait(input);
  const card = sentApprovalCards<ApprovalRequest>(surface)[0]!;
  const snapshot = gate.getRequestSnapshot(input.id);
  expect(card).not.toHaveProperty("approvalRuleBasis");
  expect(card).not.toHaveProperty("reviewerApprovalBasis");
  gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac }, surface as never);
  await pending;
  return snapshot;
}

describe("host-issued rules-only approval ceiling", () => {
  it("retains a matching host assessment as a rules-only memory ceiling without changing the card verdict", async () => {
    const input = request();
    const basis = issueApprovalRuleBasis(invocation(), { level: "medium", reason: "Rules-only assessment" }, input.approvalCacheKey);
    expect(Object.isFrozen(basis.workingDirectory)).toBe(true);
    expect(await cardSnapshot({ ...input, approvalRuleBasis: basis })).toMatchObject({
      riskCeilingAtApproval: "medium", verdictAtApproval: "high", persistentAllowAllowed: true,
      workingDirectoryIdentity: basis.workingDirectory.identity,
    });
  });

  it.each(["copied", "forged", "wrong-arguments"] as const)("does not accept a %s basis as ceiling provenance", async (failure) => {
    const input = request();
    const issued = issueApprovalRuleBasis(invocation(), { level: "medium", reason: "Rules-only assessment" }, input.approvalCacheKey);
    const approvalRuleBasis: ApprovalRuleBasis = failure === "copied" ? { ...issued }
      : failure === "forged" ? { ...issued, ruleVerdict: "low" } : issued;
    const args = failure === "wrong-arguments" ? { url: "https://different.example.test/action" } : input.args;
    expect((await cardSnapshot({ ...input, args, approvalRuleBasis }))?.riskCeilingAtApproval).toBeUndefined();
  });

  it.each([
    { forceExplicit: true as const },
    { durableApprovalRecordAllowed: false },
    { childProvenance: { childSessionId: "child", childTitle: "Child", originSessionId: "owner", spawnTaskSummary: "Request action" } },
  ])("keeps one-shot memory restrictions despite issued evidence %j", async (restriction) => {
    const input = request();
    const basis = issueApprovalRuleBasis(invocation(), { level: "medium", reason: "Rules-only assessment" }, input.approvalCacheKey);
    expect(await cardSnapshot({ ...input, ...restriction, approvalRuleBasis: basis })).toMatchObject({
      riskCeilingAtApproval: undefined, persistentAllowAllowed: false, durableApprovalRecordAllowed: false,
    });
  });

  it("retains the ordinary memory ceiling for an authenticated session-bound remote user", async () => {
    const input = request();
    const basis = issueApprovalRuleBasis(invocation(), { level: "medium", reason: "Rules-only assessment" }, input.approvalCacheKey);
    const remoteControllerAuthority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:owner" }, "session");
    expect(await cardSnapshot({ ...input, sessionId: "session", remoteControllerOrigin: "tailnet-controller", remoteControllerAuthority, approvalRuleBasis: basis })).toMatchObject({
      riskCeilingAtApproval: "medium", persistentAllowAllowed: true,
    });
  });

  it("does not replace a successful reviewer verdict with unrelated rules-only evidence", async () => {
    const input = request();
    const basis = issueApprovalRuleBasis(invocation(), { level: "medium", reason: "Rules-only assessment" }, input.approvalCacheKey);
    expect((await cardSnapshot({ ...input, reviewerOutcome: "fresh", approvalRuleBasis: basis }))?.riskCeilingAtApproval).toBeUndefined();
  });

  it("retains issued rules evidence from an unavailable reviewer without accepting a copied assessment", async () => {
    const input = request();
    const manager = new PermissionManager("/workspace/permissions.json");
    manager.setMode("auto");
    wireJudgeForTest(manager);
    const context = invocation();
    const review = await manager.dispatchReviewer(context.toolName, {
      ...context, invocationId: "unavailable-review", sessionId: "review-session", approvalCacheKey: input.approvalCacheKey,
    }, undefined, { lane: "foreground-auto" });
    expect(review.outcome).toBe("unavailable");
    expect(review.approvalBasis).toBeDefined();
    expect((await cardSnapshot({ ...input, reviewerOutcome: review.outcome, reviewerApprovalBasis: review.approvalBasis }))?.riskCeilingAtApproval).toBe(review.approvalBasis?.ruleVerdict);
    expect((await cardSnapshot({ ...input, reviewerOutcome: review.outcome, reviewerApprovalBasis: { ...review.approvalBasis! } }))?.riskCeilingAtApproval).toBeUndefined();
  });
});
