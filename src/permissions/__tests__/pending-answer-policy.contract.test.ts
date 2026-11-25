import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { answerSurvivesRecheck, onlyMemoryRulesChangedSince, personAnswerStands } from "../pending-answer-policy.js";
import type { ApprovalDecision } from "../approval-gate.js";

const decision: ApprovalDecision = { requestId: "card", choice: "allow-once" };

describe("the policy of a pending tool answer", () => {
  it("keeps the same-card policy transition in the shared check for CD1 cards", () => {
    for (const file of [
      "../../tools/invocation-authorization.ts",
      "../../tools/invocation-execution.ts",
      "../../tools/pipeline/user-owned-surface.ts",
      "../../hooks/hook-command-policy.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).toMatch(/personAnswerStands\(/);
      expect(source).not.toMatch(/\.allowsPolicyTransition/);
    }
    const source = readFileSync(new URL("../pending-answer-policy.ts", import.meta.url), "utf8");
    expect(source.match(/\.allowsPolicyTransition\?\.\(/g)).toHaveLength(1);
  });

  it.each([
    { card: "destination action", decision: "actionDecision", epochs: "actionOpened" },
    { card: "site consent", decision: "siteDecision", epochs: "siteOpened" },
  ])("captures and checks the $card answer through the shared policy", ({ decision, epochs }) => {
    const source = readFileSync(new URL("../../tools/invocation-execution.ts", import.meta.url), "utf8");
    const browserCards = source.slice(source.indexOf("authorizeBrowserSite: async"), source.indexOf("authorizeNetworkTarget:"));
    const issue = browserCards.indexOf(`const ${decision} = await gate.requestAndWait(`);
    const capture = browserCards.indexOf(`const ${epochs} = destinationEpochs`);
    const sharedCheck = browserCards.indexOf(`personAnswerStands(manager, ${epochs},`);
    expect(issue).toBeGreaterThan(browserCards.indexOf("const rules = await manager.checkNetworkRules("));
    expect(capture).toBeGreaterThan(browserCards.lastIndexOf("gate.requestAndWait(", issue));
    expect(capture).toBeLessThan(issue);
    expect(sharedCheck).toBeGreaterThan(issue);
    expect(browserCards.slice(issue, sharedCheck).match(/gate\.requestAndWait\(/g)).toHaveLength(1);
    const nextCard = browserCards.indexOf("gate.requestAndWait(", sharedCheck);
    expect(browserCards.slice(issue, nextCard === -1 ? undefined : nextCard)).toContain(`${decision}.choice`);
    expect(browserCards).toContain("let destinationEpochs = rules.answerEpochs");
    expect(browserCards).not.toMatch(/onlyMemoryRulesChangedSince|getPolicy(?:Context)?Epoch/);
  });

  it.each([
    { epoch: "opened", context: "same", signed: false, rechecked: { decision: "deny" } },
    { epoch: "changed", context: "same", signed: false, rechecked: { decision: "allow" } },
    { epoch: "changed", context: "same", signed: false, rechecked: { decision: "ask", forceModal: true } },
    { epoch: "changed", context: "same", signed: false, rechecked: { decision: "deny" } },
    { epoch: "changed", context: "other", signed: false, rechecked: { decision: "allow" } },
    { epoch: "changed", context: "other", signed: true, rechecked: { decision: "deny" } },
  ] as const)("preserves the previous same-card exception for $epoch/$context/$signed/$rechecked.decision", (test) => {
    const opened = { epoch: "opened", contextEpoch: "same" };
    const manager = { getPolicyEpoch: () => test.epoch, getPolicyContextEpoch: () => test.context };
    for (const forced of [false, true]) {
      const legacy = test.epoch === opened.epoch || test.signed ||
        onlyMemoryRulesChangedSince(manager, opened) && answerSurvivesRecheck(test.rechecked, forced);
      const recheck = vi.fn(() => test.rechecked);
      const onTransition = vi.fn();
      const allowsPolicyTransition = vi.fn(() => false).mockReturnValueOnce(test.signed);
      expect(personAnswerStands(manager, opened, forced, recheck, { gate: { allowsPolicyTransition }, decision, onTransition })).toBe(legacy);
      expect(onTransition).toHaveBeenCalledTimes(test.signed ? 1 : 0);
      if (test.signed) {
        expect(allowsPolicyTransition).toHaveBeenCalledWith(decision, "opened", "changed");
        expect(recheck).not.toHaveBeenCalled();
        expect(personAnswerStands(manager, opened, forced, recheck, { gate: { allowsPolicyTransition }, decision })).toBe(false);
      }
    }
  });
});
