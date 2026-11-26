/** The review fallback card of a user-owned surface, answered while the policy moves (pending-answer-policy.ts): a sibling stage's
 * "Allow for this run" leaves the answer standing; any other change, and a call the policy now denies or forces, refuses it. */
import { describe, expect, it, vi } from "vitest";
import { t } from "../../../i18n/runtime.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "../../../permissions/approval-gate.js";
import type { PermissionCheckResult, PermissionManager } from "../../../permissions/permission-manager.js";
import { resolveUserOwnedSurfaceApproval, userOwnedSurfaceCardFacts } from "../user-owned-surface.js";

type Change = "none" | "memory rule" | "other";
const ask: PermissionCheckResult = { decision: "ask", reason: "review could not decide", reviewer: { route: "foreground-auto" } };

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
async function answerFallback(change: Change, rechecked: Partial<PermissionCheckResult> = {}, fallbackChoice: ApprovalDecision["choice"] = "allow-once") {
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
    requestAndWait: async (request: ApprovalRequestInput): Promise<ApprovalDecision> => {
      cards.push(request);
      if (change !== "none") state.generation += 1;
      if (change === "memory rule") state.memoryRules += 1;
      return { requestId: request.id, choice: fallbackChoice };
    },
  } as unknown as ApprovalGate;
  const request = {
    id: "surface-card", sessionId: "stage-session", category: "tool", kind: "tool", toolName: "browser_click", toolCategory: "write",
    args: {}, reason: "surface", createdAt: 0, userOwnedSurface: "browser",
  } as ApprovalRequestInput;
  const resolving = resolveUserOwnedSurfaceApproval({
    manager, gate, permission: ask, decision: { requestId: request.id, choice: "allow-once" }, request, sessionId: "stage-session",
    review: async permission => permission,
  });
  return { resolving, cards, rechecks };
}

describe("a user-owned surface's review fallback card", () => {
  it("is answered as before when nothing changed", async () => {
    const { resolving, cards, rechecks } = await answerFallback("none");
    expect(await resolving).toMatchObject({ humanApproved: true, permission: { decision: "ask" } });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ userOwnedSurfaceReviewFallback: true });
    expect(rechecks.at(-1)).toBeUndefined();
  });

  it("a sibling's run rule leaves the answer standing, judged again across the memory-only step", async () => {
    const { resolving, rechecks } = await answerFallback("memory rule");
    expect(await resolving).toMatchObject({ humanApproved: true, permission: { decision: "ask" } });
    expect(rechecks.at(-1)).toEqual({ acrossMemoryRuleChanges: true });
  });

  it("any other policy change still refuses the answer, without a re-check", async () => {
    const { resolving, rechecks } = await answerFallback("other");
    await expect(resolving).rejects.toThrow("Permission policy changed while approval was pending.");
    expect(rechecks.filter(options => options?.acrossMemoryRuleChanges === true)).toEqual([]);
  });

  it.each([
    ["denies", { decision: "deny" as const, reason: "now denied" }, "now denied"],
    ["asks under a forced card the person was not shown", { forceModal: true }, t("be_executor.answerQuestionChanged")],
  ])("across a sibling's run rule an answer is refused when the policy now %s", async (_name, rechecked, refusal) => {
    const { resolving } = await answerFallback("memory rule", rechecked);
    await expect(resolving).rejects.toThrow(refusal);
  });

  it("the person's Deny on the fallback card stands across a sibling's run rule", async () => {
    const { resolving } = await answerFallback("memory rule", {}, "deny-once");
    expect(await resolving).toMatchObject({ humanApproved: false, decision: { choice: "deny-once" }, permission: { decision: "deny" } });
  });

  it("a person's Deny is a deny permission whatever the caller's re-check said, on a card of any kind", async () => {
    const allowed: PermissionCheckResult = { decision: "allow", reason: "a run rule now allows this" };
    const manager = { recheckPermission: vi.fn() } as unknown as PermissionManager;
    const request = { id: "plain-card", sessionId: "stage-session", category: "tool", kind: "tool", toolName: "write_probe", toolCategory: "write", args: {}, reason: "paused", createdAt: 0 } as ApprovalRequestInput;
    const resolved = await resolveUserOwnedSurfaceApproval({
      manager, gate: {} as ApprovalGate, permission: allowed, decision: { requestId: request.id, choice: "deny-once" }, request, sessionId: "stage-session",
      review: async permission => permission,
    });
    expect(resolved).toMatchObject({ humanApproved: false, permission: { decision: "deny" }, decision: { choice: "deny-once" } });
    expect(manager.recheckPermission).not.toHaveBeenCalled();
  });
});
