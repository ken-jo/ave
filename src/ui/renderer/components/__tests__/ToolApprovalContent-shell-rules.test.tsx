// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

const EXACT_RULE = "Bash(git status --short)";

function shellRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "shell-rule-request", category: "tool", kind: "tool", toolCategory: "shell",
    toolName: "bash", args: { command: "git status --short" }, source: "builtin",
    reason: "Review shell command", createdAt: Date.now(), requireExplicit: false,
    reviewerVerdict: { level: "medium", reason: "Review shell command" },
    persistentAllowAllowed: true, persistentApprovalCwd: "/workspace/project",
    shellRule: { exactRule: EXACT_RULE, projectCwd: "/workspace/project", projectRoot: "/workspace/project", sessionAllowed: true, persistentAllowed: true },
    ...overrides,
  };
}

const SAVE_BUTTONS = {
  session: "approval-allow-session",
  project: "approval-allow-project",
  always: TEST_IDS.allowAlwaysButton,
} as const;

const originalLocale = getLocale();
afterEach(() => { vi.unstubAllGlobals(); setLocale(originalLocale); });

// Owner 2026-10-25 (D3): an unsandboxed bash card offers exactly Deny, Allow once, This session, This project and Always; every save stores the host's exact rule.
describe("shell approval five choices", () => {
  it("offers exactly the five choices and shows the exact rule read-only", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    expect(screen.getByTestId("approval-shell-outside-sandbox")).toHaveTextContent(t("toolApprovalDialog.shellOutsideSandbox"));
    const pattern = screen.getByTestId("approval-shell-rule-pattern");
    expect(pattern.tagName).toBe("CODE");
    expect(pattern).toHaveTextContent(EXACT_RULE);
    for (const testId of [TEST_IDS.denyButton, TEST_IDS.approveButton, ...Object.values(SAVE_BUTTONS)]) {
      expect(screen.getByTestId(testId)).toBeEnabled();
    }
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByTestId("approval-deny-always")).toBeNull();
    expect(screen.getByTestId("approval-shell-rule-scope-target")).toHaveTextContent(t("toolApprovalDialog.shellScopeProjectTarget", { root: "/workspace/project" }));
  });

  it.each(Object.entries(SAVE_BUTTONS))("saves the %s scope by name only, then answers allow-once", async (scope, testId) => {
    let finishSave: ((result: { ok: boolean }) => void) | undefined;
    const record = vi.fn(() => new Promise((resolve) => { finishSave = resolve; }));
    const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(testId));
    expect(onDecide).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      rule: { scope }, decision: "allow", scope: scope === "session" ? "session" : "persistent",
    }));
    expect(JSON.stringify(record.mock.calls[0])).not.toContain("pattern");
    finishSave?.({ ok: true });
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
  });

  it("answers Allow once and Deny without saving anything", () => {
    const record = vi.fn(); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.denyButton));
    expect(onDecide).toHaveBeenLastCalledWith("deny-once");
    fireEvent.click(screen.getByTestId(TEST_IDS.approveButton));
    expect(record).not.toHaveBeenCalled();
  });

  it("disables only This session when the request has no conversation", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest({ shellRule: { exactRule: EXACT_RULE, projectCwd: "/workspace/project", projectRoot: "/workspace/project", sessionAllowed: false, persistentAllowed: true } })} onDecide={vi.fn()} />);
    expect(screen.getByTestId(SAVE_BUTTONS.session)).toBeDisabled();
    expect(screen.getByTestId(SAVE_BUTTONS.project)).toBeEnabled();
    expect(screen.getByTestId(SAVE_BUTTONS.always)).toBeEnabled();
  });

  it("keeps a command with no exact rule to Deny and Allow once, and says why", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest({ persistentAllowAllowed: false, allowedChoices: ["allow-once", "deny-once"], shellRule: { exactRule: null, projectCwd: "/workspace/project", projectRoot: "/workspace/project", sessionAllowed: false, persistentAllowed: false } })} onDecide={vi.fn()} />);
    for (const testId of Object.values(SAVE_BUTTONS)) expect(screen.getByTestId(testId)).toBeDisabled();
    expect(screen.getByTestId(TEST_IDS.approveButton)).toBeEnabled();
    expect(screen.getByTestId(TEST_IDS.denyButton)).toBeEnabled();
    expect(screen.queryByTestId("approval-shell-rule-pattern")).toBeNull();
    expect(screen.getByTestId("allow-always-unavailable-reason")).toHaveTextContent(t("toolApprovalDialog.shellExactRuleUnavailable"));
  });

  it("keeps the request pending and allows retry after a rejected rule save", async () => {
    const record = vi.fn().mockResolvedValueOnce({ ok: false, error: "invalid-rule" }).mockResolvedValueOnce({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId(TEST_IDS.allowAlwaysButton));
    await waitFor(() => expect(screen.getByTestId("exact-decision-save-error")).toBeVisible());
    expect(onDecide).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(TEST_IDS.allowAlwaysButton));
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
  });

  it.each([
    { error: "invalid-rule", message: "refused prefix", key: "formatIpcError.invalidRule" },
    { error: "rule-save-failed", message: "permissions.json is corrupt", key: "formatIpcError.ruleSaveFailed" },
  ])("tells a $error apart in the dock", async ({ error, message, key }) => {
    const record = vi.fn().mockResolvedValue({ ok: false, error, message });
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByTestId(SAVE_BUTTONS.project));
    await waitFor(() => expect(screen.getByTestId("exact-decision-save-error")).toHaveTextContent(`${t(key)} (${message})`));
  });

  it.each(["en", "ko"] as const)("localizes the five choices in %s", (locale) => {
    setLocale(locale); vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    expect(screen.getByTestId(SAVE_BUTTONS.session)).toHaveTextContent(t("toolApprovalDialog.allowForSession"));
    expect(screen.getByTestId(SAVE_BUTTONS.project)).toHaveTextContent(t("toolApprovalDialog.allowForProject"));
    expect(screen.getByTestId(SAVE_BUTTONS.always)).toHaveTextContent(t("toolApprovalDialog.allowAlways"));
    expect(screen.getByTestId(TEST_IDS.approveButton)).toHaveTextContent(t("toolApprovalDialog.allowOnce"));
    expect(screen.getByTestId(TEST_IDS.denyButton)).toHaveTextContent(t("toolApprovalDialog.denyOnce"));
  });
});
