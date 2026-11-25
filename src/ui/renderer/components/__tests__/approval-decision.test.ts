import { describe, expect, it } from "vitest";
import {
  allowMenuChoices,
  allowRefusalKey,
  defaultAllowChoice,
  exactDecisionModel,
  isWildcardRuleText,
  wildcardWarningKey,
  networkAnswer,
  networkDecisionModel,
  oneShotDecisionModel,
  pathGrantDecisionModel,
  ruleSaveFor,
  shellDecisionModel,
  type ApprovalDecisionModel,
} from "../permissions/approval-decision.js";
import type { ShellRuleApproval } from "../../../../shared/permissions-events.js";
import type { ApprovalRequest } from "../../types.js";

type EgressPayload = NonNullable<ApprovalRequest["egressHost"]>;

const offeredChoices = (model: ApprovalDecisionModel) =>
  Object.entries(model.options).filter(([, option]) => option.offered).map(([choice]) => choice);

const shell = (overrides: Partial<ShellRuleApproval> = {}): ShellRuleApproval => ({
  dialect: "bash", exactRule: "Bash(npm test)", denyRule: "Bash(npm test)", denyAllowed: true,
  projectCwd: "/p", projectRoot: "/p", sessionAllowed: true, persistentAllowed: true, ...overrides,
});

const egress = (overrides: Partial<EgressPayload> = {}): EgressPayload => ({
  host: "example.com", port: 443, rule: "Network(example.com:443)", network: "public",
  scopes: ["once", "session", "project", "always"], projectCwd: "/p", ...overrides,
});

// Owner 2026-10-25 (unified approval card): one row, six choices, and per approval type which are offered, why the others are not, and the rule each saves.
describe("approval decision models", () => {
  it("a shell card offers every choice with its exact rule, editable in the card, and warns on wildcard allows", () => {
    const model = shellDecisionModel(shell());
    expect(offeredChoices(model)).toEqual(["deny-always", "allow-session", "allow-project", "allow-everywhere"]);
    // The run choice belongs to a template run's stage card only (below).
    expect(Object.entries(model.options).filter(([choice]) => choice !== "allow-run").every(([, option]) => option.rule === "Bash(npm test)" && option.editing === "inline")).toBe(true);
    expect(model.options["allow-run"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.runAllowUnavailable" });
    expect(model.warnsOnWildcardAllow).toBe(true);
    expect(wildcardWarningKey(model)).toBe("toolApprovalDialog.wildcardAllowBroaderScope");
    expect(defaultAllowChoice(model)).toBe("allow-session");
  });

  it("a shell command with no exact rule refuses every allow and asks for a written deny rule", () => {
    const model = shellDecisionModel(shell({ exactRule: null, denyRule: null, sessionAllowed: false, persistentAllowed: false }));
    expect(offeredChoices(model)).toEqual(["deny-always"]);
    expect(model.options["deny-always"].needsEdit).toBe(true);
    expect(defaultAllowChoice(model)).toBeNull();
    expect(allowRefusalKey(model)).toBe("toolApprovalDialog.shellExactRuleUnavailable");
  });

  it("a sandbox-unavailable floor card offers only this session, with no rule to show or edit, even for a command no rule can name", () => {
    const model = shellDecisionModel(shell({ exactRule: null, denyRule: null, denyAllowed: false, sessionAllowed: true, persistentAllowed: false, floorSessionOnly: true }));
    expect(offeredChoices(model)).toEqual(["allow-session"]);
    expect(model.options["allow-session"]).toMatchObject({ rule: null, editing: null, needsEdit: false });
    expect(defaultAllowChoice(model)).toBe("allow-session");
    expect(ruleSaveFor("allow-session", undefined)).toEqual({ action: "allow", scope: "session" });
    expect(offeredChoices(shellDecisionModel(shell({ exactRule: null, sessionAllowed: false, persistentAllowed: false, floorSessionOnly: true })))).toEqual([]);
  });

  it("a shell card without Always deny (a remote controller) refuses it", () => {
    expect(shellDecisionModel(shell({ denyAllowed: false })).options["deny-always"].offered).toBe(false);
  });

  it("a shell card with no conversation falls to the project allow", () => {
    const model = shellDecisionModel(shell({ sessionAllowed: false }));
    expect(model.options["allow-session"].offered).toBe(false);
    expect(defaultAllowChoice(model)).toBe("allow-project");
    expect(allowRefusalKey(model)).toBeNull();
  });

  it("a network card offers the scopes the host sent, and host rules only where a rule can be saved", () => {
    const model = networkDecisionModel(egress(), "conversation-1");
    expect(offeredChoices(model)).toEqual(["deny-always", "allow-session", "allow-project", "allow-everywhere"]);
    expect(model.options["allow-session"].editing).toBe("inline");
    const noConversation = networkDecisionModel(egress(), undefined);
    expect(noConversation.options["allow-session"].offered).toBe(true);
    expect(noConversation.options["allow-session"].editing).toBeNull();
  });

  it("a terminal tab's allow is a tab grant without a rule; an address literal has no rule at all", () => {
    const tab = networkDecisionModel(egress({ terminalTabId: "terminal:0a1b2c3d-1", scopes: ["once", "tab", "always"], projectCwd: undefined }), undefined);
    expect(tab.options["allow-session"]).toMatchObject({ offered: true, editing: null, labelKey: "toolApprovalDialog.decisionAllowShell" });
    expect(tab.options["allow-project"].offered).toBe(false);
    const literal = networkDecisionModel(egress({ host: "203.0.113.7", rule: null }), "conversation-1");
    expect(literal.options["deny-always"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.networkRuleUnavailable" });
    expect(literal.options["allow-everywhere"]).toMatchObject({ offered: true, editing: null });
    // Host rules are shell-origin: a terminal tab's Always deny names that, not an address problem.
    const tabNoRule = networkDecisionModel(egress({ terminalTabId: "terminal:0a1b2c3d-1", scopes: ["once", "tab", "always"], projectCwd: undefined, rule: null }), undefined);
    expect(tabNoRule.options["deny-always"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.networkRuleTerminal" });
  });

  it("a network card warns on an edited wildcard host allow, with the host-rule wording", () => {
    const model = networkDecisionModel(egress(), "conversation-1");
    expect(model.warnsOnWildcardAllow).toBe(true);
    expect(wildcardWarningKey(model)).toBe("toolApprovalDialog.wildcardHostAllowSandboxedOnly");
  });

  it("a local destination refuses the lasting allows with its own reason", () => {
    const model = networkDecisionModel(egress({ network: "local", scopes: ["once", "session"] }), "conversation-1");
    expect(model.options["allow-everywhere"].reasonKey).toBe("toolApprovalDialog.networkLocalScopeNotOffered");
  });

  it("an exact tool approval offers session, project and everywhere, and edits Always deny in Settings", () => {
    const model = exactDecisionModel({ sessionOnly: false, hasSession: true, allowRefusalKey: null, denyRefusalKey: null, settingsEditing: true });
    expect(offeredChoices(model)).toEqual(["deny-always", "allow-session", "allow-project", "allow-everywhere"]);
    expect(model.options["deny-always"].editing).toBe("settings");
    expect(model.options["allow-everywhere"]).toMatchObject({ offered: true, labelKey: "toolApprovalDialog.decisionAllowEverywhere" });
    expect(model.options["allow-session"].editing).toBeNull();
  });

  it("an exact approval the host records nothing for offers no Always deny, with the one-shot reason", () => {
    const model = exactDecisionModel({ sessionOnly: false, hasSession: true, allowRefusalKey: "toolApprovalDialog.persistentUnavailableOneShot", denyRefusalKey: "toolApprovalDialog.persistentUnavailableOneShot", settingsEditing: true });
    expect(offeredChoices(model)).toEqual([]);
    expect(model.options["deny-always"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.persistentUnavailableOneShot", editing: null });
  });

  it("an exact approval names the right refusal: high risk before a missing conversation, session-only scopes, no Settings", () => {
    const high = exactDecisionModel({ sessionOnly: false, hasSession: false, allowRefusalKey: "toolApprovalDialog.persistentUnavailableHighRisk", denyRefusalKey: null, settingsEditing: true });
    expect(allowRefusalKey(high)).toBe("toolApprovalDialog.persistentUnavailableHighRisk");
    const noConversation = exactDecisionModel({ sessionOnly: true, hasSession: false, allowRefusalKey: null, denyRefusalKey: null, settingsEditing: true });
    expect(allowRefusalKey(noConversation)).toBe("toolApprovalDialog.sessionAllowNeedsConversation");
    const browser = exactDecisionModel({ sessionOnly: true, hasSession: true, allowRefusalKey: null, denyRefusalKey: null, settingsEditing: false });
    expect(offeredChoices(browser)).toEqual(["deny-always", "allow-session"]);
    expect(browser.options["deny-always"].editing).toBeNull();
  });

  it("a folder card offers its parent for the session or persistently", () => {
    const model = pathGrantDecisionModel("/Users/me/project", "toolApprovalDialog.persistentUnavailableNoParent", true, null, "/Users/me/project");
    expect(offeredChoices(model)).toEqual(["deny-always", "allow-session", "allow-everywhere"]);
    expect(model.options["allow-session"].rule).toBe("/Users/me/project");
    expect(model.options["allow-everywhere"].rule).toBe("/Users/me/project");
    expect(model.options["allow-everywhere"].labelKey).toBe("toolApprovalDialog.decisionAllowFolder");
    const unrecordable = pathGrantDecisionModel("/Users/me/project", "toolApprovalDialog.persistentUnavailableNoParent", true, "toolApprovalDialog.persistentUnavailableOneShot");
    expect(unrecordable.options["deny-always"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.persistentUnavailableOneShot" });
    expect(defaultAllowChoice(model)).toBe("allow-everywhere");
    const noParent = pathGrantDecisionModel(null, "toolApprovalDialog.persistentUnavailableNoParent", true, null);
    expect(allowRefusalKey(noParent)).toBe("toolApprovalDialog.persistentUnavailableNoParent");
  });

  it("a one-shot request refuses every remembering choice with one reason", () => {
    const model = oneShotDecisionModel("toolApprovalDialog.persistentUnavailableOneShot");
    expect(offeredChoices(model)).toEqual([]);
    expect(allowRefusalKey(model)).toBe("toolApprovalDialog.persistentUnavailableOneShot");
  });
});

describe("approval decision answers", () => {
  it("maps each remembering choice onto its rule save; Always deny is user-global", () => {
    expect(ruleSaveFor("deny-always", undefined)).toEqual({ action: "deny", scope: "always" });
    expect(ruleSaveFor("allow-session", undefined)).toEqual({ action: "allow", scope: "session" });
    expect(ruleSaveFor("allow-project", "Bash(npm *)")).toEqual({ action: "allow", scope: "project", pattern: "Bash(npm *)" });
    expect(ruleSaveFor("allow-everywhere", undefined)).toEqual({ action: "allow", scope: "always" });
  });

  it("a network choice left as it is answers with its grant; Always deny and edited allows save a host rule first", () => {
    const payload = egress();
    expect(networkAnswer(payload, "deny-once", undefined)).toEqual({ choice: "deny-once" });
    expect(networkAnswer(payload, "allow-once", undefined)).toEqual({ choice: "allow-once", egressScope: "once" });
    expect(networkAnswer(payload, "allow-session", undefined)).toEqual({ choice: "allow-once", egressScope: "session" });
    expect(networkAnswer(payload, "allow-project", undefined)).toEqual({ choice: "allow-once", egressScope: "project" });
    expect(networkAnswer(payload, "allow-everywhere", undefined)).toEqual({ choice: "allow-once", egressScope: "always" });
    expect(networkAnswer(payload, "deny-always", undefined)).toEqual({ rule: { action: "deny", scope: "always" }, choice: "deny-once" });
    expect(networkAnswer(payload, "allow-project", "Network(*.example.com)")).toEqual({
      rule: { action: "allow", scope: "project", pattern: "Network(*.example.com)" }, choice: "allow-once", egressScope: "once",
    });
    expect(networkAnswer(egress({ terminalTabId: "terminal:0a1b2c3d-1" }), "allow-session", undefined)).toEqual({ choice: "allow-once", egressScope: "tab" });
  });

  it.each([
    ["Bash(git *)", true],
    ["bash(git status *)", true],
    ["PowerShell(get-childitem *)", true],
    ["Bash(*)", true],
    ["Bash(git status)", false],
    ["Bash(git status*)", false],
    ["Network(*.example.com)", true],
    ["network( *.example.com:443)", true],
    ["Network(api.example.com)", false],
    ["Network(api.example.com:443)", false],
  ])("treats %s as a wildcard rule the host warns about: %s", (text, wildcard) => {
    expect(isWildcardRuleText(text)).toBe(wildcard);
  });
});

// Owner decision 2026-11-16 (per-stage approval lane, run-scoped grant): a card a template run's stage session raised lists "Allow for
// this run" between the conversation and the saved scopes; the host says whether it is offered.
describe("a template-run stage card", () => {
  const stage = (runAllowOffered: boolean) => ({ stageId: "plan", stageName: "Plan", runAllowOffered });
  const exact = (over: Partial<Parameters<typeof exactDecisionModel>[0]> = {}) =>
    exactDecisionModel({ sessionOnly: false, hasSession: true, allowRefusalKey: null, denyRefusalKey: null, settingsEditing: true, ...over });

  it("lists the run allow on a stage card and on no other card", () => {
    expect(allowMenuChoices(shellDecisionModel(shell(), stage(true)))).toEqual(["allow-session", "allow-run", "allow-project", "allow-everywhere"]);
    expect(allowMenuChoices(exact({ stage: stage(true) }))).toEqual(["allow-session", "allow-run", "allow-project", "allow-everywhere"]);
    for (const model of [shellDecisionModel(shell()), exact(), networkDecisionModel(egress(), "s"), oneShotDecisionModel("toolApprovalDialog.persistentUnavailableOneShot")]) {
      expect(allowMenuChoices(model)).not.toContain("allow-run");
      expect(model.options["allow-run"].offered).toBe(false);
    }
  });

  it("offers it where the host does, with the session rule's text on a shell card, and saves a run-scope rule", () => {
    const model = shellDecisionModel(shell(), stage(true));
    expect(model.options["allow-run"]).toMatchObject({ offered: true, rule: "Bash(npm test)", editing: "inline" });
    expect(ruleSaveFor("allow-run", undefined)).toEqual({ action: "allow", scope: "run" });
    expect(ruleSaveFor("allow-run", "Bash(npm *)")).toEqual({ action: "allow", scope: "run", pattern: "Bash(npm *)" });
    expect(exact({ stage: stage(true) }).options["allow-run"]).toMatchObject({ offered: true, rule: null });
    // The conversation stays the middle button's default.
    expect(defaultAllowChoice(model)).toBe("allow-session");
  });

  it("refuses it with a reason where the host does not offer it: a schedule-started run, a floor, a session-only memory", () => {
    expect(shellDecisionModel(shell(), stage(false)).options["allow-run"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.runAllowUnavailable" });
    expect(exact({ stage: stage(false) }).options["allow-run"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.runAllowUnavailable" });
    expect(shellDecisionModel(shell({ floorSessionOnly: true }), stage(true)).options["allow-run"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.persistentUnavailableOneShot" });
    expect(exact({ stage: stage(true), sessionOnly: true }).options["allow-run"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.sessionOnlyRemember" });
    expect(shellDecisionModel(shell({ exactRule: null, sessionAllowed: false, persistentAllowed: false }), stage(true)).options["allow-run"].offered).toBe(false);
  });

  it("a network card answers no run allow", () => {
    expect(() => networkAnswer(egress(), "allow-run", undefined)).toThrow("A network card offers no run allow");
  });
});
