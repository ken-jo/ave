import { describe, expect, it, vi } from "vitest";
import { answerEpochsOf, answerSurvivesRecheck, onlyMemoryRulesChangedSince, personAnswerStands } from "../pending-answer-policy.js";

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
});
