import { describe, expect, it, vi } from "vitest";
import type { PermissionCheckResult } from "../permission-manager.js";
import { answerEpochsOf, answerSurvivesRecheck, onlyMemoryRulesChangedSince, openPendingAnswerCard, pendingQuestionStillAsked, permissionQuestionOf, personAnswerStands, samePermissionQuestion, spendStandingAnswer, standingAnswerFor, type PendingAnswerBinding, type StandingAnswer, type StandingAnswerUse } from "../pending-answer-policy.js";

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
const action = "tool-use:call";
/** What the owner binds a card to at open. */
const bound = (gate: PendingAnswerBinding["gate"] = {}, requestId = "card", uses: readonly StandingAnswerUse[] = ["shell-permit", "terminal-write"]): PendingAnswerBinding =>
  ({ gate, requestId, action, uses });

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
    const { value, recordStaleAnswer } = answer();
    const card = openPendingAnswerCard(manager, floorAsk(true), check, "stale-reasked", bound(value.gate));
    manager.otherStep();
    expect(personAnswerStands(card, value.decision)).toBe(kind === "stands");
    expect(card.verdict?.kind).toBe(kind);
    expect(check).toHaveBeenCalledOnce();
    if (kind === "stale") {
      expect(recordStaleAnswer).toHaveBeenCalledWith(value.decision, "stale-reasked", permissionQuestionOf(floorAsk(true)), permissionQuestionOf(now));
    } else expect(recordStaleAnswer).not.toHaveBeenCalled();
  });

  it("runs the bound check when nothing changed, so a change the policy epoch does not see still refuses", () => {
    const manager = policy();
    const { value } = answer();
    const card = openPendingAnswerCard(manager, floorAsk(true), () => floorAsk(true, { code: "protected-path", reason: "Protected." }), "stale-refused", bound(value.gate));
    expect(personAnswerStands(card, value.decision)).toBe(false);
    expect(card.verdict?.kind).toBe("stale");
  });

  it("refuses a moved policy without running the check when no receipt covers the step", () => {
    const manager = policy();
    const check = vi.fn(() => floorAsk(true));
    const { value } = answer("allow-once", false);
    const card = openPendingAnswerCard(manager, floorAsk(true), check, "stale-refused", bound(value.gate));
    manager.otherStep();
    expect(personAnswerStands(card, value.decision)).toBe(false);
    expect(card.verdict).toEqual({ kind: "policy-changed" });
    expect(check).not.toHaveBeenCalled();
  });

  it("keeps a Deny as the person's, judging nothing and recording no stale answer", () => {
    const manager = policy();
    const check = vi.fn(() => floorAsk(false));
    const { value, recordStaleAnswer } = answer("deny-once", false);
    const card = openPendingAnswerCard(manager, floorAsk(true), check, "stale-refused", bound(value.gate));
    manager.otherStep();
    expect(personAnswerStands(card, value.decision)).toBe(false);
    expect(card.verdict).toEqual({ kind: "declined" });
    expect(check).not.toHaveBeenCalled();
    expect(recordStaleAnswer).not.toHaveBeenCalled();
  });

  it.each(["allow-once", "deny-once"] as const)("refuses a %s when the bound check has no result, without its error text", (choice) => {
    const manager = policy();
    const { value } = answer(choice);
    const card = openPendingAnswerCard(manager, floorAsk(true), () => { throw new Error("Project rules were not loaded"); }, "stale-refused", bound(value.gate));
    expect(personAnswerStands(card, value.decision)).toBe(false);
    expect(card.verdict).toEqual({ kind: choice === "allow-once" ? "policy-changed" : "declined" });
  });

  it("reports a Deny as the policy's own denial when the call is now denied", () => {
    const manager = policy();
    const { value } = answer("deny-once");
    const card = openPendingAnswerCard(manager, floorAsk(true), () => result({ decision: "deny", reason: "Saved deny rule" }), "stale-refused", bound(value.gate));
    expect(personAnswerStands(card, value.decision)).toBe(false);
    expect(card.verdict).toMatchObject({ kind: "denied", fresh: { reason: "Saved deny rule" } });
  });

  it.each([
    ["the same forced question", floorAsk(true), floorAsk(true), true],
    ["an ordinary ask", floorAsk(true), result(ask), true],
    ["the floor lost its session eligibility", floorAsk(true), floorAsk(false), false],
    ["another floor", floorAsk(true), floorAsk(true, { code: "protected-path", reason: "Protected." }), false],
    ["a forced ask behind an ordinary card", result(ask), floorAsk(true), false],
    ["an allow", floorAsk(true), result(allow), false],
    ["a deny", floorAsk(true), result(deny), false],
  ] as const)("a card not yet asked keeps its question only while the call still asks it: %s", (_name, pending, now, stillAsked) => {
    expect(pendingQuestionStillAsked(pending, now)).toBe(stillAsked);
  });

  const allowOnce = (requestId = "card") => ({ requestId, choice: "allow-once" as const });
  const proofOf = (card: ReturnType<typeof openPendingAnswerCard>): StandingAnswer | undefined =>
    card.verdict?.kind === "stands" ? card.verdict.proof : undefined;

  it("refuses an answer crossed between two cards open at the same epoch, and still takes each card's own", () => {
    const manager = policy();
    const check = vi.fn(() => floorAsk(true));
    const first = openPendingAnswerCard(manager, floorAsk(true), check, "stale-refused", bound({}, "first"));
    const second = openPendingAnswerCard(manager, floorAsk(true), check, "stale-refused", bound({}, "second"));
    expect(personAnswerStands(first, allowOnce("second"))).toBe(false);
    expect(first.verdict).toEqual({ kind: "policy-changed" });
    expect(check).not.toHaveBeenCalled();
    expect(personAnswerStands(first, allowOnce("first"))).toBe(true);
    expect(personAnswerStands(second, allowOnce("second"))).toBe(true);
    expect(proofOf(first)).not.toBe(proofOf(second));
  });

  it("binds the standing answer to its request, answer, action and question, and spends it once per use", () => {
    const manager = policy();
    const card = openPendingAnswerCard(manager, floorAsk(true), () => floorAsk(true), "stale-refused", bound());
    const decision = allowOnce();
    expect(personAnswerStands(card, decision)).toBe(true);
    const proof = proofOf(card);
    expect(standingAnswerFor(proof, action)).toBe(proof);
    expect(standingAnswerFor(proof, "tool-use:other")).toBeUndefined();
    expect(spendStandingAnswer(proof, "shell-permit", "tool-use:other")).toBeUndefined();
    const facts = spendStandingAnswer(proof, "shell-permit", action);
    expect(facts).toMatchObject({ requestId: "card", action, forced: true, question: permissionQuestionOf(floorAsk(true)) });
    expect(facts?.decision).toBe(decision);
    expect(spendStandingAnswer(proof, "shell-permit", action)).toBeUndefined();
    expect(spendStandingAnswer(proof, "terminal-write", action)).toBeDefined();
    expect(spendStandingAnswer(proof, "terminal-write", action)).toBeUndefined();
  });

  it("refuses a use the card did not declare when it was opened", () => {
    const declared: StandingAnswerUse[] = ["shell-permit"];
    const card = openPendingAnswerCard(policy(), floorAsk(true), () => floorAsk(true), "stale-refused", bound({}, "card", declared));
    // The set is fixed at open: a kind added afterwards is not declared.
    declared.push("terminal-write");
    expect(personAnswerStands(card, allowOnce())).toBe(true);
    const proof = proofOf(card);
    for (const undeclared of ["terminal-write", "directory-grant", "shell-policy", "effect"] as const) {
      expect(spendStandingAnswer(proof, undeclared, action)).toBeUndefined();
    }
    expect(spendStandingAnswer(proof, "shell-permit", action)).toBeDefined();
  });

  it("refuses a second spend of a declared use", () => {
    const card = openPendingAnswerCard(policy(), floorAsk(true), () => floorAsk(true), "stale-refused", bound({}, "card", ["shell-permit", "shell-policy"]));
    expect(personAnswerStands(card, allowOnce())).toBe(true);
    const proof = proofOf(card);
    expect(spendStandingAnswer(proof, "shell-policy", action)).toBeDefined();
    expect(spendStandingAnswer(proof, "shell-policy", action)).toBeUndefined();
    expect(spendStandingAnswer(proof, "shell-permit", action)).toBeDefined();
    expect(spendStandingAnswer(proof, "shell-permit", action)).toBeUndefined();
  });

  it("gives a card one judgement: a second answer mints nothing", () => {
    const manager = policy();
    const card = openPendingAnswerCard(manager, floorAsk(true), () => floorAsk(true), "stale-refused", bound());
    expect(personAnswerStands(card, allowOnce())).toBe(true);
    expect(personAnswerStands(card, allowOnce())).toBe(false);
    expect(card.verdict).toEqual({ kind: "policy-changed" });
  });

  it.each([
    ["a throwing check", () => { throw new Error("Project rules were not loaded"); }],
    ["a denying check", () => result({ decision: "deny", reason: "Saved deny rule" })],
    ["another forced question", () => floorAsk(false)],
  ] as const)("mints no standing answer on %s", (_name, check) => {
    const card = openPendingAnswerCard(policy(), floorAsk(true), check, "stale-refused", bound());
    expect(personAnswerStands(card, allowOnce())).toBe(false);
    expect(card.verdict).not.toHaveProperty("proof");
  });

  it("takes no look-alike for a standing answer", () => {
    const card = openPendingAnswerCard(policy(), floorAsk(true), () => floorAsk(true), "stale-refused", bound());
    personAnswerStands(card, allowOnce());
    const proof = proofOf(card);
    if (!proof) throw new Error("the answer did not stand");
    const Made = (proof as unknown as { constructor: new () => StandingAnswer }).constructor;
    for (const forged of [{}, true, Object.create(Object.getPrototypeOf(proof)), new Made(), structuredClone(proof)]) {
      expect(standingAnswerFor(forged, action)).toBeUndefined();
      expect(spendStandingAnswer(forged as StandingAnswer, "shell-permit", action)).toBeUndefined();
    }
    expect(Object.isFrozen(proof)).toBe(true);
  });

  it("refuses a card the owner did not open", () => {
    const manager = policy();
    const forged = { epochs: answerEpochsOf(manager), question: permissionQuestionOf(floorAsk(true)), forced: true };
    expect(() => personAnswerStands(forged, answer().value.decision)).toThrow(/openPendingAnswerCard/);
  });

  it.each([
    ["an ordinary ask", result(ask), "stands"],
    ["an allow", result(allow), "stands"],
    ["a forced ask the card did not put", floorAsk(true), "stale"],
  ] as const)("across an unforced card's own policy step the bound check decides: %s", (_name, now, kind) => {
    const manager = policy();
    const { value } = answer();
    const card = openPendingAnswerCard(manager, result(ask), () => now, "stale-reasked", bound(value.gate));
    manager.otherStep();
    expect(personAnswerStands(card, value.decision)).toBe(kind === "stands");
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
    const card = openPendingAnswerCard(manager, opened, () => changed, "stale-refused", bound());
    expect(personAnswerStands(card, { requestId: "card", choice: "allow-once" })).toBe(false);
    expect(card.verdict?.kind).toBe("stale");
  });

  // The card renders these beside the reason; the floor and its reason stay fixed.
  const pathAsk = (pathFacts: Record<string, string>) => ({
    decision: "ask" as const, forceModal: true, reason: "shown", reasonCode: "protected-path",
    pipelineRequest: { tool: { name: "write_file", source: "builtin" as const, kind: "write" as const }, mode: "default" as const, headless: false,
      floor: { code: "protected-path" as const, reason: "Protected." }, pathFacts },
  }) as unknown as PermissionCheckResult;

  it.each([
    ["only the secret pattern changed", pathAsk({ protectedEntry: ".git", secretPattern: "*.pem" })],
    ["only the protected entry changed", pathAsk({ protectedEntry: ".husky", secretPattern: ".env" })],
    ["a secret pattern is no longer shown", pathAsk({ protectedEntry: ".git" })],
  ] as const)("is another question when %s", (_name, changed) => {
    const opened = pathAsk({ protectedEntry: ".git", secretPattern: ".env" });
    expect(permissionQuestionOf(opened)).toMatchObject({ protectedEntry: ".git", secretPattern: ".env" });
    expect(samePermissionQuestion(permissionQuestionOf(opened), permissionQuestionOf(changed))).toBe(false);
    expect(samePermissionQuestion(permissionQuestionOf(opened), permissionQuestionOf(pathAsk({ protectedEntry: ".git", secretPattern: ".env" })))).toBe(true);
    const manager = policy();
    const card = openPendingAnswerCard(manager, opened, () => changed, "stale-refused", bound());
    expect(personAnswerStands(card, { requestId: "card", choice: "allow-once" })).toBe(false);
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
  const card = openPendingAnswerCard(manager, behind("protected-path"), () => behind(code), "stale-reasked", bound({ allowsPolicyTransition: () => true }));
  manager.otherStep();
  expect(personAnswerStands(card, { requestId: "card", choice: "allow-once" })).toBe(stands);
});
