import { describe, expect, it, vi } from "vitest";
import type { PermissionCheckResult } from "../permission-manager.js";
import { answerEpochsOf, answerSurvivesRecheck, onlyMemoryRulesChangedSince, openPendingAnswerCard, permissionQuestionOf, personAnswerStands, samePermissionQuestion } from "../pending-answer-policy.js";

/** A manager's two epochs, moved by hand. */
function policy() {
  const state = { generation: 0, memoryRules: 0 };
  return {
    state,
    getPolicyEpoch: () => `${state.generation}`,
    getPolicyContextEpoch: () => `${state.generation - state.memoryRules}`,
    memoryRuleStep: () => { state.generation += 1; state.memoryRules += 1; },
    otherStep: () => { state.generation += 1; },
  };
}
const ask = { decision: "ask" as const };
const forcedAsk = { decision: "ask" as const, forceModal: true };
const allow = { decision: "allow" as const };
const deny = { decision: "deny" as const };

describe("a person's answer across a policy change", () => {
  it("stands without a re-check when nothing changed", () => {
    const manager = policy();
    const recheck = vi.fn(() => deny);
    expect(personAnswerStands(manager, answerEpochsOf(manager), false, recheck)).toBe(true);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("is refused without a re-check after any change that is not a memory-only allow rule's, also mixed with one", () => {
    const manager = policy();
    const opened = answerEpochsOf(manager);
    manager.memoryRuleStep();
    manager.otherStep();
    const recheck = vi.fn(() => allow);
    expect(onlyMemoryRulesChangedSince(manager, opened)).toBe(false);
    expect(personAnswerStands(manager, opened, false, recheck)).toBe(false);
    expect(recheck).not.toHaveBeenCalled();
  });

  it("refuses an async re-check if a non-memory policy step occurs during it", async () => {
    const manager = policy();
    const opened = answerEpochsOf(manager);
    manager.memoryRuleStep();
    const recheck = vi.fn(async () => {
      manager.otherStep();
      return allow;
    });
    expect(await personAnswerStands(manager, opened, true, recheck)).toBe(false);
    expect(recheck).toHaveBeenCalledOnce();
  });

  it.each([
    ["still asked", ask, false, true],
    ["now allowed", allow, false, true],
    ["now denied", deny, false, false],
    ["now denied, on a forced card", deny, true, false],
    ["now asked under a forced card the person was not shown", forcedAsk, false, false],
    ["still asked under the forced card the person answered", forcedAsk, true, true],
  ] as const)("across memory-only allow rules the re-check decides: %s", (_name, now, cardForced, stands) => {
    const manager = policy();
    const opened = answerEpochsOf(manager);
    manager.memoryRuleStep();
    manager.memoryRuleStep();
    const recheck = vi.fn(() => now);
    expect(onlyMemoryRulesChangedSince(manager, opened)).toBe(true);
    expect(personAnswerStands(manager, opened, cardForced, recheck)).toBe(stands);
    expect(recheck).toHaveBeenCalledOnce();
    expect(answerSurvivesRecheck(now, cardForced)).toBe(stands);
  });


  const forcedRequest = { tool: { name: "terminal_run", source: "builtin" as const, kind: "shell" as const }, mode: "default" as const, headless: false };
  const sandboxFloor = { code: "sandbox-unavailable" as const, reason: "No sandbox." };
  type Floor = { code: "sandbox-unavailable" | "protected-path" | "critical-delete"; reason: string };
  const floorAsk = (floorSessionEligible: boolean, floor: Floor = sandboxFloor, extra: Record<string, unknown> = {}) => ({
    decision: "ask" as const, forceModal: true, reason: "shown", reasonCode: floor.code,
    pipelineRequest: { ...forcedRequest, floor, ...(floorSessionEligible ? { floorSessionEligible: true as const } : {}), ...extra },
  }) as unknown as PermissionCheckResult;
  const answer = (choice: "allow-once" | "deny-once" = "allow-once", transition = true) => {
    const recordStaleAnswer = vi.fn();
    return { recordStaleAnswer, value: { gate: { allowsPolicyTransition: () => transition, recordStaleAnswer }, decision: { requestId: "card", choice } } };
  };
  const result = (value: unknown) => value as PermissionCheckResult;

  it.each([
    ["the same forced question", floorAsk(true), "stands"],
    ["now allowed by the card's own save", result(allow), "stands"],
    ["now denied", result(deny), "denied"],
    ["the floor lost its session eligibility", floorAsk(false), "stale"],
    ["another floor", floorAsk(true, { code: "protected-path", reason: "Protected." }), "stale"],
    ["the same floor with another reason", floorAsk(true, { ...sandboxFloor, reason: "Other." }), "stale"],
    ["another floor now behind it", floorAsk(false, sandboxFloor, { competingFloor: { code: "protected-path", reason: "Protected." } }), "stale"],
    ["shell analysis now limited", floorAsk(true, sandboxFloor, { shellAnalysisLimited: true }), "stale"],
  ] as const)("across the card's own policy step the card's bound check decides: %s", (_name, now, kind) => {
    const manager = policy();
    const check = vi.fn(() => now);
    const card = openPendingAnswerCard(manager, floorAsk(true), check, "stale-reasked");
    manager.otherStep();
    const { value, recordStaleAnswer } = answer();
    expect(personAnswerStands(manager, card, value)).toBe(kind === "stands");
    expect(card.verdict?.kind).toBe(kind);
    expect(check).toHaveBeenCalledOnce();
    if (kind === "stale") {
      expect(recordStaleAnswer).toHaveBeenCalledWith(value.decision, "stale-reasked", permissionQuestionOf(floorAsk(true)), permissionQuestionOf(now));
    } else expect(recordStaleAnswer).not.toHaveBeenCalled();
  });

  it("runs the bound check when nothing changed, so a change the policy epoch does not see still refuses", () => {
    const manager = policy();
    const card = openPendingAnswerCard(manager, floorAsk(true), () => floorAsk(true, { code: "protected-path", reason: "Protected." }), "stale-refused");
    expect(personAnswerStands(manager, card, answer().value)).toBe(false);
    expect(card.verdict?.kind).toBe("stale");
  });

  it("refuses a moved policy without running the check when no receipt covers the step", () => {
    const manager = policy();
    const check = vi.fn(() => floorAsk(true));
    const card = openPendingAnswerCard(manager, floorAsk(true), check, "stale-refused");
    manager.otherStep();
    expect(personAnswerStands(manager, card, answer("allow-once", false).value)).toBe(false);
    expect(card.verdict).toEqual({ kind: "policy-changed" });
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps a Deny as the person's, judging nothing and recording no stale answer", () => {
    const manager = policy();
    const check = vi.fn(() => floorAsk(false));
    const card = openPendingAnswerCard(manager, floorAsk(true), check, "stale-refused");
    manager.otherStep();
    const { value, recordStaleAnswer } = answer("deny-once", false);
    expect(personAnswerStands(manager, card, value)).toBe(false);
    expect(card.verdict).toEqual({ kind: "declined" });
    expect(check).not.toHaveBeenCalled();
    expect(recordStaleAnswer).not.toHaveBeenCalled();
  });

  it.each(["allow-once", "deny-once"] as const)("refuses a %s when the bound check has no result, without its error text", (choice) => {
    const manager = policy();
    const card = openPendingAnswerCard(manager, floorAsk(true), () => { throw new Error("Project rules were not loaded"); }, "stale-refused");
    expect(personAnswerStands(manager, card, answer(choice).value)).toBe(false);
    expect(card.verdict).toEqual({ kind: choice === "allow-once" ? "policy-changed" : "declined" });
  });

  it("reports a Deny as the policy's own denial when the call is now denied", () => {
    const manager = policy();
    const card = openPendingAnswerCard(manager, floorAsk(true), () => result({ decision: "deny", reason: "Saved deny rule" }), "stale-refused");
    expect(personAnswerStands(manager, card, answer("deny-once").value)).toBe(false);
    expect(card.verdict).toMatchObject({ kind: "denied", fresh: { reason: "Saved deny rule" } });
  });

  it("refuses a card the owner did not open", () => {
    const manager = policy();
    const forged = { epochs: answerEpochsOf(manager), question: permissionQuestionOf(floorAsk(true)), forced: true };
    expect(() => personAnswerStands(manager, forged, answer().value)).toThrow(/openPendingAnswerCard/);
  });

  it.each([
    ["an ordinary ask", result(ask), "stands"],
    ["an allow", result(allow), "stands"],
    ["a forced ask the card did not put", floorAsk(true), "stale"],
  ] as const)("across an unforced card's own policy step the bound check decides: %s", (_name, now, kind) => {
    const manager = policy();
    const card = openPendingAnswerCard(manager, result(ask), () => now, "stale-reasked");
    manager.otherStep();
    expect(personAnswerStands(manager, card, answer().value)).toBe(kind === "stands");
    expect(card.verdict?.kind).toBe(kind);
  });
});

describe("the question a card puts", () => {
  const surfaceAsk = (exfiltration: string, extra: Record<string, unknown> = {}) => ({
    decision: "ask" as const, forceModal: true, reason: "replaced by the approval", reasonCode: "exfiltration-guardrail",
    pipelineRequest: { tool: { name: "host_terminal_type", source: "builtin" as const, kind: "shell" as const }, mode: "default" as const, headless: false,
      userOwnedSurface: { kind: "host-terminal" as const, choice: "ask" as const }, exfiltration: { reason: exfiltration }, ...extra },
  }) as unknown as PermissionCheckResult;

  it("names a floorless forced ask by its reason, derived from the request", () => {
    const question = permissionQuestionOf(surfaceAsk("Sends the page to another site."));
    expect(question).toMatchObject({ ask: "exfiltration-guardrail: Sends the page to another site." });
    expect(question.floor).toBeUndefined();
    expect(Object.isFrozen(question)).toBe(true);
    expect(samePermissionQuestion(question, permissionQuestionOf({ ...surfaceAsk("Sends the page to another site."), reason: "other text" } as PermissionCheckResult))).toBe(true);
  });

  it.each([
    ["only the floorless ask reason changed", surfaceAsk("Uploads a file.")],
    ["only shell analysis became limited", surfaceAsk("Sends the page to another site.", { shellAnalysisLimited: true })],
  ] as const)("is another question when %s", (_name, changed) => {
    const opened = surfaceAsk("Sends the page to another site.");
    expect(samePermissionQuestion(permissionQuestionOf(opened), permissionQuestionOf(changed))).toBe(false);
    const manager = policy();
    const card = openPendingAnswerCard(manager, opened, () => changed, "stale-refused");
    expect(personAnswerStands(manager, card, { gate: {}, decision: { requestId: "card", choice: "allow-once" } })).toBe(false);
    expect(card.verdict?.kind).toBe("stale");
  });
});

it.each([
  ["the same floor behind it", "protected-path", true],
  ["another floor behind it", "critical-delete", false],
] as const)("a card's own policy step keeps a shadowed floor's answer only for %s", (_name, code, stands) => {
  const manager = policy();
  const behind = (floor: "protected-path" | "critical-delete") => ({
    decision: "ask" as const, forceModal: true, reasonCode: "sandbox-unavailable",
    pipelineRequest: { tool: { name: "terminal_run", source: "builtin" as const, kind: "shell" as const }, mode: "default" as const, headless: false,
      floor: { code: "sandbox-unavailable" as const, reason: "No sandbox." }, competingFloor: { code: floor, reason: "Shadowed." } },
  }) as unknown as PermissionCheckResult;
  const card = openPendingAnswerCard(manager, behind("protected-path"), () => behind(code), "stale-reasked");
  manager.otherStep();
  expect(personAnswerStands(manager, card, {
    gate: { allowsPolicyTransition: () => true }, decision: { requestId: "card", choice: "allow-once" },
  })).toBe(stands);
});
