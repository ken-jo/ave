import { describe, expect, it, vi } from "vitest";
import { answerEpochsOf, answerSurvivesRecheck, forcedQuestionOf, onlyMemoryRulesChangedSince, personAnswerStands } from "../pending-answer-policy.js";

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
  const floorAsk = (floorSessionEligible: boolean, floor: { code: "sandbox-unavailable" | "protected-path"; reason: string } = sandboxFloor) => ({
    decision: "ask" as const, forceModal: true,
    pipelineRequest: { ...forcedRequest, floor, ...(floorSessionEligible ? { floorSessionEligible: true as const } : {}) },
  });
  it.each([
    ["the same forced question", floorAsk(true), true],
    ["now allowed by the card's own save", allow, true],
    ["now denied (the caller's denial decides)", deny, true],
    ["the floor lost its session eligibility", floorAsk(false), false],
    ["another floor", floorAsk(true, { code: "protected-path", reason: "Protected." }), false],
    ["the same floor with another reason", floorAsk(true, { ...sandboxFloor, reason: "Other." }), false],
    ["another floor now behind it", { ...floorAsk(false), pipelineRequest: { ...floorAsk(false).pipelineRequest, competingFloor: { code: "protected-path" as const, reason: "Protected." } } }, false],
  ] as const)("across the card's own policy step the fresh check decides: %s", (_name, now, stands) => {
    const manager = policy();
    const opened = answerEpochsOf(manager);
    manager.otherStep();
    const recheck = vi.fn(() => allow);
    const question = forcedQuestionOf(floorAsk(true));
    expect(personAnswerStands(manager, opened, true, recheck, {
      gate: { allowsPolicyTransition: () => true }, decision: { requestId: "card", choice: "allow-once" }, question, onTransition: () => now,
    })).toBe(stands);
    expect(recheck).not.toHaveBeenCalled();
  });

  it.each([
    ["an ordinary ask", ask, true],
    ["an allow", allow, true],
    ["a forced ask the card did not put", forcedAsk, false],
  ] as const)("across an unforced card's own policy step the fresh check decides: %s", (_name, now, stands) => {
    const manager = policy();
    const opened = answerEpochsOf(manager);
    manager.otherStep();
    expect(personAnswerStands(manager, opened, false, () => allow, {
      gate: { allowsPolicyTransition: () => true }, decision: { requestId: "card", choice: "allow-once" }, onTransition: () => now,
    })).toBe(stands);
  });
});

it.each([
  ["the same floor behind it", "protected-path", true],
  ["another floor behind it", "critical-delete", false],
] as const)("a card's own policy step keeps a shadowed floor's answer only for %s", (_name, code, stands) => {
  const manager = policy();
  const opened = answerEpochsOf(manager);
  manager.otherStep();
  const behind = (floor: "protected-path" | "critical-delete") => ({
    decision: "ask" as const, forceModal: true,
    pipelineRequest: { tool: { name: "terminal_run", source: "builtin" as const, kind: "shell" as const }, mode: "default" as const, headless: false,
      floor: { code: "sandbox-unavailable" as const, reason: "No sandbox." }, competingFloor: { code: floor, reason: "Shadowed." } },
  });
  expect(personAnswerStands(manager, opened, true, () => allow, {
    gate: { allowsPolicyTransition: () => true }, decision: { requestId: "card", choice: "allow-once" },
    question: forcedQuestionOf(behind("protected-path")), onTransition: () => behind(code),
  })).toBe(stands);
});
