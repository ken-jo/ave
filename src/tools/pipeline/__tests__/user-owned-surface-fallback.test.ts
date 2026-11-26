/** The review fallback card of a user-owned surface, answered while the policy moves (pending-answer-policy.ts): a sibling stage's
 * "Allow for this run" leaves the answer standing; any other change, and a call the policy now denies or forces, refuses it. */
import { describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/runtime.js";
import { answeredApprovalDecision, answeringRequestAndWait } from "../../../__tests__/support/answering-approval-gate.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "../../../permissions/approval-gate.js";
import { RULE_PROVENANCE } from "../../../permissions/decision-provenance.js";
import type { PermissionCheckResult, PermissionManager } from "../../../permissions/permission-manager.js";
import { approvalFailureOutcome } from "../approval-outcome.js";
import { resolveUserOwnedSurfaceApproval, userOwnedSurfaceCardFacts } from "../user-owned-surface.js";
import { standingAnswer } from "../../../__tests__/support/standing-answer.js";
import { standingAnswerFor } from "../../../permissions/pending-answer-policy.js";

const ACTION = "tool-use:surface";

type Change = "none" | "memory rule" | "other";
const ask: PermissionCheckResult = { decision: "ask", reason: "review could not decide", reviewer: { route: "foreground-auto" }, provenance: RULE_PROVENANCE };
const policyRefusal = {
  decision: { choice: "deny-once" },
  answer: undefined,
  permission: { decision: "deny", reason: "Permission policy changed while approval was pending.", provenance: RULE_PROVENANCE },
};

it("includes review fallback facts only for the ordinary surface card when the request carries a floor", () => {
  const permission: PermissionCheckResult = {
    ...ask, reasonCode: "user-owned-surface-human-required",
    pipelineRequest: {
      tool: { name: "terminal_run", source: "builtin", kind: "shell" }, mode: "default", headless: false,
      floor: { code: "sandbox-unavailable", reason: "No sandbox." },
      userOwnedSurface: { kind: "host-terminal", choice: "auto" },
      reviewer: { status: "error" },
    },
  };
  expect(userOwnedSurfaceCardFacts(permission)).toEqual({
    userOwnedSurface: "host-terminal", userOwnedSurfaceReviewFallback: true,
  });
  expect(userOwnedSurfaceCardFacts({ ...permission, forceModal: true })).toEqual({});
});

/** Resolves a surface card answered "auto" whose review asks again, so the fallback card is raised; `change` happens while it is open. */
async function answerFallback(change: Change, rechecked: Partial<PermissionCheckResult> = {}, fallbackChoice: ApprovalDecision["choice"] = "allow-once", recordless = false) {
  const state = { generation: 0, memoryRules: 0 };
  const rechecks: Array<{ acrossMemoryRuleChanges: true } | undefined> = [];
  const manager = {
    getPolicyEpoch: () => `${state.generation}`,
    getPolicyContextEpoch: () => `${state.generation - state.memoryRules}`,
    setUserOwnedSurfaceChoice: vi.fn(),
    recheckPermission: (permission: PermissionCheckResult, options?: { acrossMemoryRuleChanges: true }) => {
      rechecks.push(options);
      return options?.acrossMemoryRuleChanges === true ? { ...permission, ...rechecked } : { ...permission };
    },
  } as unknown as PermissionManager;
  const cards: ApprovalRequestInput[] = [];
  const gate = {
    consumeUserOwnedSurfaceChoice: () => "auto",
    allowsPolicyTransition: () => false,
    requestAndWait: recordless
      ? async (request: ApprovalRequestInput) => { cards.push(request); return { requestId: request.id, choice: fallbackChoice }; }
      : answeringRequestAndWait((request: ApprovalRequestInput) => {
      cards.push(request);
      if (change !== "none") state.generation += 1;
      if (change === "memory rule") state.memoryRules += 1;
      return { choice: fallbackChoice };
    }),
  } as unknown as ApprovalGate;
  const request = {
    id: "surface-card", sessionId: "stage-session", category: "tool", kind: "tool", toolName: "browser_click", toolCategory: "write",
    args: {}, reason: "surface", createdAt: 0, userOwnedSurface: "browser",
  } as ApprovalRequestInput;
  const decision = await answeredApprovalDecision({ requestId: request.id, choice: "allow-once" }, "desk", request.toolName);
  const answer = standingAnswer(ACTION, decision);
  const resolving = resolveUserOwnedSurfaceApproval({
    manager, gate, permission: ask, decision, answer, action: ACTION, uses: [], request, sessionId: "stage-session",
    review: async permission => permission,
  });
  return { resolving, cards, rechecks, answer };
}

describe("a user-owned surface's review fallback card", () => {
  it("is answered as before when nothing changed", async () => {
    const { resolving, cards, rechecks, answer } = await answerFallback("none");
    const resolved = await resolving;
    expect(resolved).toMatchObject({ permission: { decision: "ask" } });
    // The fallback card's own standing answer, not the first card's.
    expect(standingAnswerFor(resolved.answer, ACTION)).toBeDefined();
    expect(resolved.answer).not.toBe(answer);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ userOwnedSurfaceReviewFallback: true });
    expect(rechecks.at(-1)).toBeUndefined();
  });

  it("a sibling's run rule leaves the answer standing, judged again across the memory-only step", async () => {
    const { resolving, rechecks } = await answerFallback("memory rule");
    const resolved = await resolving;
    expect(resolved).toMatchObject({ permission: { decision: "ask" } });
    expect(standingAnswerFor(resolved.answer, ACTION)).toBeDefined();
    expect(rechecks.at(-1)).toEqual({ acrossMemoryRuleChanges: true });
  });

  it("any other policy change still refuses the answer, without a re-check", async () => {
    const { resolving, rechecks } = await answerFallback("other");
    expect(await resolving).toMatchObject(policyRefusal);
    expect(rechecks.filter(options => options?.acrossMemoryRuleChanges === true)).toEqual([]);
  });

  it.each([
    ["denies", { decision: "deny" as const, reason: "now denied" }, "now denied"],
    ["asks under a forced card the person was not shown", { forceModal: true }, t("be_executor.answerQuestionChanged")],
  ])("across a sibling's run rule an answer is refused when the policy now %s", async (_name, rechecked, refusal) => {
    const { resolving } = await answerFallback("memory rule", rechecked);
    expect(await resolving).toMatchObject({ ...policyRefusal, permission: { ...policyRefusal.permission, reason: refusal } });
  });

  it("the person's Deny on the fallback card stands across a sibling's run rule", async () => {
    const { resolving } = await answerFallback("memory rule", {}, "deny-once");
    expect(await resolving).toMatchObject({ answer: undefined, decision: { choice: "deny-once" }, permission: { decision: "deny" } });
  });

  it("leaves a recordless fallback refusal to the host outcome", async () => {
    const { resolving } = await answerFallback("none", {}, "deny-once", true);
    const resolved = await resolving;
    expect(resolved).toMatchObject({ answer: undefined, decision: { choice: "deny-once" }, permission: ask });
    expect(approvalFailureOutcome(resolved.decision, "browser_click")?.permission).toMatchObject({
      decision: "deny", reason: "approval rejected by host", provenance: { kind: "host" },
    });
  });

  it.each([false, true])("uses the bound deny on an initial card (authenticated=%s)", async (authenticated) => {
    const allowed: PermissionCheckResult = { decision: "allow", reason: "a run rule now allows this", provenance: RULE_PROVENANCE };
    const manager = { recheckPermission: vi.fn() } as unknown as PermissionManager;
    const request = { id: "plain-card", sessionId: "stage-session", category: "tool", kind: "tool", toolName: "write_probe", toolCategory: "write", args: {}, reason: "paused", createdAt: 0 } as ApprovalRequestInput;
    const refusal = { requestId: request.id, choice: "deny-once" as const };
    const decision = authenticated ? await answeredApprovalDecision(refusal, "desk", request.toolName) : refusal;
    const resolved = await resolveUserOwnedSurfaceApproval({
      manager, gate: {} as ApprovalGate, permission: allowed, decision, answer: undefined, action: ACTION, uses: [], request, sessionId: "stage-session",
      review: async permission => permission,
    });
    expect(resolved).toMatchObject({ answer: undefined, permission: { decision: authenticated ? "deny" : "allow" }, decision: { choice: "deny-once" } });
    expect(manager.recheckPermission).not.toHaveBeenCalled();
  });
});
