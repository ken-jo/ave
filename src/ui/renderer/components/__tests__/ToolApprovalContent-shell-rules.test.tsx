// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

function shellRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "shell-rule-request", category: "tool", kind: "tool", toolCategory: "shell",
    toolName: "bash", args: { command: "git status --short" }, source: "builtin",
    reason: "Review shell command", createdAt: Date.now(), requireExplicit: false,
    reviewerVerdict: { level: "medium", reason: "Review shell command" },
    persistentAllowAllowed: true, persistentApprovalCwd: "/workspace/project",
    shellRule: { suggestedPattern: "Bash(git status *)", projectCwd: "/workspace/project", sessionAllowed: true, persistentAllowed: true },
    ...overrides,
  };
}

const originalLocale = getLocale();
afterEach(() => { vi.unstubAllGlobals(); setLocale(originalLocale); });

describe("shell approval rule controls", () => {
  it("saves an edited project rule before answering once and never records an exact persistent grant", async () => {
    let finishSave: ((result: { ok: boolean }) => void) | undefined;
    const record = vi.fn(() => new Promise((resolve) => { finishSave = resolve; }));
    const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    expect(screen.getByTestId("approval-shell-rule-pattern")).toHaveValue("Bash(git status *)");
    expect(screen.getByTestId("approval-shell-rule-scope")).toHaveValue("project");
    fireEvent.change(screen.getByTestId("approval-shell-rule-pattern"), { target: { value: "Bash( git status )" } });
    expect(screen.getByTestId("approval-shell-rule-preview")).toHaveTextContent(t("toolApprovalDialog.shellRulePreview", { pattern: "Bash(git status)" }));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowAlwaysButton));
    expect(onDecide).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { pattern: "Bash(git status)", scope: "project" }, decision: "allow" }));
    finishSave?.({ ok: true });
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
  });

  it.each([
    { name: "tabs", typed: "Bash(\tgit\tstatus\t*)", saved: "Bash(git status *)" },
    { name: "internal runs of spaces", typed: "  Bash(git   status    *)  ", saved: "Bash(git status *)" },
    { name: "mixed tabs and spaces", typed: "Bash( \t git \t status )", saved: "Bash(git status)" },
  ])("normalizes $name before saving and previews the saved rule", async ({ typed, saved }) => {
    const record = vi.fn().mockResolvedValue({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    fireEvent.change(screen.getByTestId("approval-shell-rule-pattern"), { target: { value: typed } });
    expect(screen.getByTestId("approval-shell-rule-preview")).toHaveTextContent(t("toolApprovalDialog.shellRulePreview", { pattern: saved }));
    fireEvent.click(screen.getByTestId(TEST_IDS.allowAlwaysButton));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ rule: { pattern: saved, scope: "project" } }));
  });

  it("shows no preview for an already canonical rule", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    expect(screen.queryByTestId("approval-shell-rule-preview")).toBeNull();
  });

  it.each([
    { name: "empty after trimming", typed: "Bash( \t )" },
    { name: "still invalid after normalization", typed: "Bash( git | status )" },
  ])("keeps a rule that is $name flagged invalid", ({ typed }) => {
    const record = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    fireEvent.change(screen.getByTestId("approval-shell-rule-pattern"), { target: { value: typed } });
    expect(screen.getAllByText(t("toolApprovalDialog.shellRuleInvalid")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("approval-shell-rule-preview")).toBeNull();
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    expect(screen.getByTestId("approval-deny-always")).toBeDisabled();
    expect(record).not.toHaveBeenCalled();
  });

  it("saves a user deny rule before answering deny-once", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    fireEvent.change(screen.getByTestId("approval-shell-rule-scope"), { target: { value: "user" } });
    fireEvent.click(screen.getByTestId("approval-deny-always"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("deny-once", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ decision: "deny", rule: { pattern: "Bash(git status *)", scope: "user" } }));
  });

  it("uses exact session memory and responds only once", async () => {
    const record = vi.fn().mockResolvedValue({ ok: true }); const onDecide = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={onDecide} />);
    fireEvent.click(screen.getByTestId("approval-allow-session"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-once", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ scope: "session", decision: "allow" }));
    expect(record.mock.calls[0][0]).not.toHaveProperty("rule");
  });

  it("keeps a refused prefix session-eligible without offering always allow", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest({ shellRule: { suggestedPattern: null, projectCwd: "/workspace/project", sessionAllowed: true, persistentAllowed: false } })} onDecide={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    expect(screen.getByTestId("approval-allow-session")).toBeEnabled();
  });

  it.each(["Bash(node *)", "Bash(sudo *)", "Bash(env *)", "Bash(bash *)"])("blocks edited refused allow prefix %s while retaining deny", (pattern) => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    fireEvent.change(screen.getByTestId("approval-shell-rule-pattern"), { target: { value: pattern } });
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    expect(screen.getByTestId("approval-deny-always")).toBeEnabled();
    expect(screen.getByTestId("approval-allow-session")).toBeEnabled();
  });

  it("never widens a one-shot floor into session or persistent allow", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest({ persistentAllowAllowed: false, allowedChoices: ["allow-once", "deny-once"], shellRule: { suggestedPattern: null, projectCwd: "/workspace/project", sessionAllowed: false, persistentAllowed: false } })} onDecide={vi.fn()} />);
    expect(screen.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
    expect(screen.queryByTestId("approval-allow-session")).toBeNull();
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

  it.each(["en", "ko"] as const)("localizes the editable rule controls in %s", (locale) => {
    setLocale(locale); vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={shellRequest()} onDecide={vi.fn()} />);
    expect(screen.getByLabelText(t("toolApprovalDialog.shellRulePattern"))).toBeVisible();
    expect(screen.getByTestId("approval-deny-always")).toHaveTextContent(t("toolApprovalDialog.shellDenyAlways"));
  });
});
