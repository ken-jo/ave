// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import { openDecisionMenu, selectDecision } from "./support/decision-bar.js";
import type { ApprovalRequest } from "../../types.js";
import type { ShellRuleApproval } from "../../../../shared/permissions-events.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

const EXACT_RULE = "Bash(printf %s ready)";

function shellRule(overrides: Partial<ShellRuleApproval> = {}): ShellRuleApproval {
  return {
    dialect: "bash", denyRule: EXACT_RULE, denyAllowed: true, exactRule: EXACT_RULE,
    projectCwd: "/workspace/project", projectRoot: "/workspace/project", sessionAllowed: true, persistentAllowed: true,
    ...overrides,
  };
}

function shellRequest(overrides: Partial<ApprovalRequest> = {}, rule: Partial<ShellRuleApproval> = {}): ApprovalRequest {
  return {
    id: "shell-rule-request", category: "tool", kind: "tool", toolCategory: "shell",
    toolName: "bash", args: { command: "printf %s ready" }, source: "builtin",
    reason: "Review shell command", createdAt: Date.now(), requireExplicit: false,
    reviewerVerdict: { level: "medium", reason: "Review shell command" },
    persistentAllowAllowed: true, persistentApprovalCwd: "/workspace/project",
    shellRule: shellRule(rule),
    ...overrides,
  };
}

const ALLOW_SCOPES = { "allow-session": "session", "allow-project": "project", "allow-everywhere": "always" } as const;

const originalLocale = getLocale();
afterEach(() => { vi.unstubAllGlobals(); setLocale(originalLocale); });

// Owner 2026-10-25 (unified approval card): a shell card draws Deny ▾ | Allow for session ▾ | Allow once; every remembering choice saves a Bash(...)/PowerShell(...) rule, editable before it is saved.
describe("shell approval card: the shared decision row", () => {
  it("draws the three buttons, with no rule row until a choice is selected", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest(), vi.fn());
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "shell");
    expect(screen.getByTestId("approval-shell-outside-sandbox")).toHaveTextContent(t("toolApprovalDialog.shellOutsideSandbox"));
    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent(t("toolApprovalDialog.decisionDeny"));
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent(t("toolApprovalDialog.decisionAllowSession"));
    expect(screen.getByTestId(TEST_IDS.approveButton)).toHaveTextContent(t("toolApprovalDialog.allowOnce"));
    for (const testId of [TEST_IDS.denyButton, TEST_IDS.allowSessionButton, TEST_IDS.approveButton]) {
      expect(screen.getByTestId(testId)).toBeEnabled();
    }
    expect(screen.queryByTestId("approval-rule-row")).toBeNull();
    expect(screen.queryByTestId("approval-edit-rule")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("approval-shell-rule-scope-target")).toHaveTextContent(t("toolApprovalDialog.shellScopeProjectTarget", { root: "/workspace/project" }));
  });

  it("does not claim a sandboxed command runs outside the sandbox or needs an exact rule", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    const executionPlan = { sandboxed: true, mode: "sandboxed" } as unknown as ApprovalRequest["executionPlan"];
    renderApproval(shellRequest({ executionPlan }), vi.fn());
    expect(screen.queryByTestId("approval-shell-outside-sandbox")).toBeNull();
    expect(screen.getByTestId("approval-shell-rule-context").textContent).not.toContain(t("toolApprovalDialog.shellOutsideSandbox"));
    expect(screen.getByTestId("approval-shell-rule-scope-target")).toHaveTextContent(t("toolApprovalDialog.shellScopeProjectTarget", { root: "/workspace/project" }));
  });

  // An -EncodedCommand payload is shown as the script it runs; no allow rule covers it, so the host sends no exact rule.
  it("shows each decoded -EncodedCommand script, and offers no lasting allow for it", () => {
    renderApproval(shellRequest({}, { exactRule: null, decodedCommands: ["Remove-Item -Recurse C:\\data"] }), vi.fn());
    const decoded = screen.getAllByTestId("approval-shell-decoded-command");
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toHaveTextContent("Remove-Item -Recurse C:\\data");
    expect(decoded[0]).toHaveTextContent(t("toolApprovalDialog.shellDecodedCommand"));
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
  });

  it("draws no decoded script for a plain command", () => {
    renderApproval(shellRequest(), vi.fn());
    expect(screen.queryByTestId("approval-shell-decoded-command")).toBeNull();
  });

  it("lists Deny and Always deny in one dropdown, and the three lasting allows in the other", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest(), vi.fn());
    expect(openDecisionMenu("deny-always")).toHaveTextContent(t("toolApprovalDialog.decisionDenyAlways"));
    expect(screen.getByTestId("approval-choice-deny-once")).toHaveTextContent(t("toolApprovalDialog.decisionDeny"));
    fireEvent.keyDown(screen.getByTestId("approval-choice-deny-always"), { key: "Escape" });
    openDecisionMenu("allow-session");
    for (const [choice, key] of [
      ["allow-session", "toolApprovalDialog.decisionAllowSession"],
      ["allow-project", "toolApprovalDialog.decisionAllowProject"],
      ["allow-everywhere", "toolApprovalDialog.decisionAllowEverywhere"],
    ] as const) {
      const item = screen.getByTestId(`approval-choice-${choice}`);
      expect(item).toHaveTextContent(t(key));
      expect(item).not.toHaveAttribute("data-disabled");
    }
  });

  it("saves a session rule from the button itself when nothing is selected", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), onDecide);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { action: "allow", scope: "session" }, decision: "allow", scope: "session" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
  });

  it.each(Object.entries(ALLOW_SCOPES))("selecting %s shows its rule and Edit rule, and the button saves it by name only", async (choice, scope) => {
    let finishSave: ((result: { ok: boolean }) => void) | undefined;
    const record = vi.fn(() => new Promise((resolve) => { finishSave = resolve; }));
    const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), onDecide);
    selectDecision(choice as keyof typeof ALLOW_SCOPES);
    const button = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(button).toHaveAttribute("data-choice", choice);
    expect(screen.getByTestId("approval-rule-pattern")).toHaveTextContent(EXACT_RULE);
    expect(screen.getByTestId("approval-edit-rule")).toHaveTextContent(t("toolApprovalDialog.editRule"));
    fireEvent.click(button);
    expect(onDecide).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      rule: { action: "allow", scope }, decision: "allow", scope: scope === "session" ? "session" : "persistent",
    }));
    expect(JSON.stringify(record.mock.calls[0])).not.toContain("pattern");
    finishSave?.({ ok: true });
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
  });

  it("Always deny saves the deny rule and then denies once", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), onDecide);
    selectDecision("deny-always");
    const deny = screen.getByTestId(TEST_IDS.denyButton);
    expect(deny).toHaveTextContent(t("toolApprovalDialog.decisionDenyAlways"));
    expect(screen.getByTestId("approval-rule-pattern")).toHaveTextContent(EXACT_RULE);
    fireEvent.click(deny);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { action: "deny", scope: "always" }, decision: "deny", scope: "persistent" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("deny-once"));
    expect(onDecide).not.toHaveBeenCalledWith("deny-always");
  });

  it("Always deny with no derived rule opens the editor and waits for a written rule", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest({}, { denyRule: null, exactRule: null, sessionAllowed: false, persistentAllowed: false }), onDecide);
    selectDecision("deny-always");
    const input = screen.getByTestId("approval-rule-input");
    expect(input).toHaveValue("");
    expect(screen.getByTestId("approval-rule-required")).toHaveTextContent(t("toolApprovalDialog.ruleEditRequired"));
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeDisabled();
    fireEvent.change(input, { target: { value: "Bash(printf *)" } });
    expect(screen.queryByTestId("approval-rule-wildcard-warning")).toBeNull();
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { action: "deny", scope: "always", pattern: "Bash(printf *)" } }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("deny-once"));
  });

  it("Edit rule sends the edited rule and warns that a wildcard allow covers matching future commands", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true, warning: "wildcard-allow-broader-scope" }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), onDecide);
    selectDecision("allow-project");
    fireEvent.click(screen.getByTestId("approval-edit-rule"));
    const input = screen.getByTestId("approval-rule-input");
    expect(input).toHaveValue(EXACT_RULE);
    expect(screen.queryByTestId("approval-rule-wildcard-warning")).toBeNull();
    fireEvent.change(input, { target: { value: "Bash(printf %s *)" } });
    expect(screen.getByTestId("approval-rule-wildcard-warning")).toHaveTextContent(t("toolApprovalDialog.wildcardAllowBroaderScope"));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { action: "allow", scope: "project", pattern: "Bash(printf %s *)" }, scope: "persistent" }));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
  });

  it("an edit left as the derived rule saves the derived rule by name", () => {
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), vi.fn());
    selectDecision("allow-everywhere");
    fireEvent.click(screen.getByTestId("approval-edit-rule"));
    fireEvent.change(screen.getByTestId("approval-rule-input"), { target: { value: `  ${EXACT_RULE} ` } });
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { action: "allow", scope: "always" } }));
  });

  it("warns on a PowerShell wildcard allow too", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest({ toolName: "powershell", args: { command: "Get-ChildItem -Force" } }, {
      dialect: "powershell", exactRule: "PowerShell(get-childitem -force)", denyRule: "PowerShell(get-childitem -force)",
    }), vi.fn());
    selectDecision("allow-session");
    expect(screen.getByTestId("approval-rule-pattern")).toHaveTextContent("PowerShell(get-childitem -force)");
    fireEvent.click(screen.getByTestId("approval-edit-rule"));
    fireEvent.change(screen.getByTestId("approval-rule-input"), { target: { value: "PowerShell(get-childitem *)" } });
    expect(screen.getByTestId("approval-rule-wildcard-warning")).toBeVisible();
  });

  it("refuses This session without a conversation, and the button falls to the project allow", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest({}, { sessionAllowed: false }), vi.fn());
    const button = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(button).toHaveTextContent(t("toolApprovalDialog.decisionAllowProject"));
    expect(button).toBeEnabled();
    expect(openDecisionMenu("allow-session")).toHaveAttribute("data-disabled");
    expect(screen.getByTestId("approval-choice-allow-session-reason")).toHaveTextContent(t("toolApprovalDialog.persistentUnavailableOneShot"));
    expect(screen.getByTestId("approval-choice-allow-project")).not.toHaveAttribute("data-disabled");
  });

  it("keeps a command with no exact rule to Deny and Allow once, and says why", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest({ persistentAllowAllowed: false }, { denyRule: null, exactRule: null, sessionAllowed: false, persistentAllowed: false }), vi.fn());
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeEnabled();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeEnabled();
    expect(screen.getByTestId("allow-always-unavailable-reason")).toHaveTextContent(t("toolApprovalDialog.shellExactRuleUnavailable"));
    openDecisionMenu("allow-session");
    for (const choice of ["allow-session", "allow-project", "allow-everywhere"]) {
      expect(screen.getByTestId(`approval-choice-${choice}`)).toHaveAttribute("data-disabled");
    }
  });

  it.each(["git status --short", "make build"])("offers no lasting allow for the unproven tool %s", (command) => {
    renderApproval(shellRequest({ args: { command }, persistentAllowAllowed: false }, {
      denyRule: `Bash(${command})`, exactRule: null, sessionAllowed: false, persistentAllowed: false,
    }), vi.fn());
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeEnabled();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeEnabled();
    expect(screen.getByTestId("allow-always-unavailable-reason")).toHaveTextContent(t("toolApprovalDialog.shellExactRuleUnavailable"));
  });

  it("answers Allow once and Deny without saving anything", () => {
    const record = vi.fn(); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), onDecide);
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(onDecide).toHaveBeenLastCalledWith("deny-once");
    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));
    expect(record).not.toHaveBeenCalled();
  });

  it("Escape inside an open dropdown closes it without deciding", () => {
    const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest(), onDecide);
    const item = openDecisionMenu("deny-always");
    fireEvent.keyDown(item, { key: "d" });
    fireEvent.keyDown(item, { key: "Escape" });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("keeps the request pending and allows retry after a rejected rule save", async () => {
    const record = vi.fn().mockResolvedValueOnce({ ok: false, error: "invalid-rule" }).mockResolvedValueOnce({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), onDecide);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    await waitFor(() => expect(screen.getByTestId("exact-decision-save-error")).toBeVisible());
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
  });

  it.each([
    { error: "invalid-rule", message: "refused prefix", key: "formatIpcError.invalidRule" },
    { error: "rule-does-not-match", message: "Bash(ls) does not allow this request", key: "formatIpcError.ruleDoesNotMatch" },
    { error: "rule-save-failed", message: "permissions.json is corrupt", key: "formatIpcError.ruleSaveFailed" },
  ])("tells a $error apart in the dock", async ({ error, message, key }) => {
    const record = vi.fn().mockResolvedValue({ ok: false, error, message });
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(shellRequest(), vi.fn());
    selectDecision("allow-project");
    fireEvent.click(screen.getByTestId(TEST_IDS.allowSessionButton));
    await waitFor(() => expect(screen.getByTestId("exact-decision-save-error")).toHaveTextContent(`${t(key)} (${message})`));
  });

  it.each(["en", "ko"] as const)("localizes the row and its dropdowns in %s", (locale) => {
    setLocale(locale); vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(shellRequest(), vi.fn());
    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent(t("toolApprovalDialog.decisionDeny"));
    expect(screen.getByTestId(TEST_IDS.allowSessionButton)).toHaveTextContent(t("toolApprovalDialog.decisionAllowSession"));
    expect(screen.getByTestId(TEST_IDS.approveButton)).toHaveTextContent(t("toolApprovalDialog.allowOnce"));
    expect(screen.getByTestId("approval-allow-menu")).toHaveAccessibleName(t("toolApprovalDialog.moreAllowChoices"));
    expect(screen.getByTestId("approval-deny-menu")).toHaveAccessibleName(t("toolApprovalDialog.moreDenyChoices"));
    expect(openDecisionMenu("allow-everywhere")).toHaveTextContent(t("toolApprovalDialog.decisionAllowEverywhere"));
  });
});
