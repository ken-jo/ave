import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { openPendingAnswerCard, personAnswerStands } from "../pending-answer-policy.js";
import type { PermissionCheckResult } from "../permission-manager.js";
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
    expect(browserCards).not.toMatch(/siteAnswerStands|answerSurvivesRecheck|onlyMemoryRulesChangedSince|getPolicy(?:Context)?Epoch/);
  });

  it.each([
    { epoch: "opened", context: "same", signed: false, rechecked: { decision: "deny" }, verdict: "denied" },
    { epoch: "opened", context: "same", signed: false, rechecked: { decision: "ask" }, verdict: "stands" },
    { epoch: "changed", context: "same", signed: false, rechecked: { decision: "allow" }, verdict: "stands" },
    { epoch: "changed", context: "same", signed: false, rechecked: { decision: "ask", forceModal: true }, verdict: "stale" },
    { epoch: "changed", context: "same", signed: false, rechecked: { decision: "deny" }, verdict: "denied" },
    { epoch: "changed", context: "other", signed: false, rechecked: { decision: "allow" }, verdict: "policy-changed" },
    { epoch: "changed", context: "other", signed: true, rechecked: { decision: "deny" }, verdict: "denied" },
    { epoch: "changed", context: "other", signed: true, rechecked: { decision: "allow" }, verdict: "stands" },
  ] as const)("judges an unforced card by its bound check for $epoch/$context/$signed/$rechecked.decision", (test) => {
    const now = { epoch: "opened", context: "same" };
    const manager = { getPolicyEpoch: () => now.epoch, getPolicyContextEpoch: () => now.context };
    const check = vi.fn(() => test.rechecked as unknown as PermissionCheckResult);
    const allowsPolicyTransition = vi.fn(() => false).mockReturnValueOnce(test.signed);
    const bound = { gate: { allowsPolicyTransition }, requestId: decision.requestId, action: "tool-use:call" };
    const card = openPendingAnswerCard(manager, { decision: "ask" }, check, "stale-refused", bound);
    Object.assign(now, { epoch: test.epoch, context: test.context });
    expect(personAnswerStands(card, decision)).toBe(test.verdict === "stands");
    expect(card.verdict?.kind).toBe(test.verdict);
    expect(check).toHaveBeenCalledTimes(test.verdict === "policy-changed" ? 0 : 1);
    if (test.signed) {
      expect(allowsPolicyTransition).toHaveBeenCalledWith(decision, "opened", "changed");
      Object.assign(now, { epoch: "opened", context: "same" });
      const again = openPendingAnswerCard(manager, { decision: "ask" }, check, "stale-refused", bound);
      Object.assign(now, { epoch: test.epoch, context: test.context });
      expect(personAnswerStands(again, decision)).toBe(false);
      expect(again.verdict).toEqual({ kind: "policy-changed" });
    }
  });
});
