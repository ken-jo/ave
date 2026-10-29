// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { clearActiveSurface, showActiveSurface } from "../../preview/active-surface.js";
import { PERMISSION_REVIEWER_FRAMEWORK_VERSION } from "../../../../shared/permission-reviewer-framework.js";
import { t } from "../../../../i18n/index.js";
import { shellDecisionModel } from "../permissions/approval-decision.js";

/** A `terminal_run` card shows the exact command and the terminal it will be typed into; the target the host
 * sealed before the card was shown; and remembers the command in that directory for this app session only. */
function terminalRunRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "terminal-run-1",
    category: "tool",
    kind: "tool",
    toolName: "terminal_run",
    toolCategory: "shell",
    args: { command: "npm test -- --watch=false" },
    reason: "shell command",
    source: "builtin",
    createdAt: Date.now(),
    requireExplicit: false,
    trustOrigin: "llm-tool-arg",
    sessionId: "11111111-1111-4111-8111-111111111111",
    reviewerVerdict: { level: "medium", reason: "runs the test suite" },
    persistentAllowAllowed: true,
    persistentApprovalCwd: "/workspace/project",
    approvalMemory: {
      kind: "key",
      key: "terminal_run:command",
      scope: { kind: "terminal-command", lane: "agent", terminalSessionId: "fixture-agent", sandboxGeneration: "0", commandSha256: "a".repeat(64), tabId: "terminal:3fa91c0e-2", cwd: "/workspace/project/app", cwdForMatch: "/workspace/project/app" },
    },
    ...overrides,
  };
}

function evaluationContext(allowedDirectories: string[]): NonNullable<ApprovalRequest["evaluationContext"]> {
  return {
    version: "permission-evaluation-context/v1",
    reviewerFrameworkVersion: PERMISSION_REVIEWER_FRAMEWORK_VERSION,
    policyMode: "default",
    headless: false,
    source: "builtin",
    category: "shell",
    trustOrigin: "llm-tool-arg",
    executionCwd: "/session",
    allowedDirectories,
    pathFields: [],
    targetFilePaths: [],
    sensitivePathsAdjacent: [],
  };
}

describe("ToolApprovalContent terminal_run card", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearActiveSurface();
  });

  it("shows the exact command and names the terminal by its tab label and directory", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    showActiveSurface({ kind: "terminal", tabId: "terminal:3fa91c0e-2", label: "Terminal 2", cwd: "/workspace/project/app" });
    renderApproval(terminalRunRequest(), vi.fn());
    const target = screen.getByTestId("approval-terminal-target");
    // The exact command is on the always-visible line, not only behind the details toggle.
    expect(target).toHaveTextContent("npm test -- --watch=false");
    expect(target).toHaveTextContent("Terminal 2");
    expect(target).toHaveTextContent("/workspace/project/app");
  });

  it("names a terminal that is not the active one by its id rather than guessing a label", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    showActiveSurface({ kind: "terminal", tabId: "terminal:3fa91c0e-1", label: "Terminal 1" });
    renderApproval(terminalRunRequest(), vi.fn());
    const target = screen.getByTestId("approval-terminal-target");
    expect(target).toHaveTextContent("terminal:3fa91c0e-2");
    expect(target).not.toHaveTextContent("Terminal 1");
  });

  it("names a look-alike letter in a mixed-script word by code point, so it cannot pass as the letter it imitates", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    // A Cyrillic a in place of the Latin one.
    renderApproval(terminalRunRequest({ args: { command: "open p\u0430ypal.com" } }), vi.fn());
    const notes = screen.getAllByTestId("approval-terminal-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("U+0430");
  });

  it("does not warn about a word written in one script, such as a Korean filename", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    renderApproval(terminalRunRequest({ args: { command: "cat \ubcf4\uace0\uc11c.txt" } }), vi.fn());
    expect(screen.getByTestId("approval-terminal-target")).toHaveTextContent("cat \ubcf4\uace0\uc11c.txt");
    expect(screen.queryByTestId("approval-terminal-note")).toBeNull();
  });

  it("says when the terminal's directory is outside the allowed folders, and only then", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    const { unmount } = renderApproval(terminalRunRequest({ evaluationContext: evaluationContext(["/elsewhere"]) }), vi.fn());
    expect(screen.getByTestId("approval-terminal-note")).toHaveTextContent("/workspace/project/app");
    unmount();
    renderApproval(terminalRunRequest({ evaluationContext: evaluationContext(["/workspace/project"]) }), vi.fn());
    expect(screen.queryByTestId("approval-terminal-note")).toBeNull();
  });

  it("compares the directory the host resolved, so a symlinked or differently cased $PWD inside the allowed folders gets no note", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    const request = terminalRunRequest({ evaluationContext: evaluationContext(["/private/tmp/work"]) });
    const memory = request.approvalMemory as Extract<NonNullable<ApprovalRequest["approvalMemory"]>, { kind: "key" }>;
    renderApproval({ ...request, approvalMemory: { ...memory, scope: { kind: "terminal-command", lane: "agent", terminalSessionId: "fixture-agent", sandboxGeneration: "0", commandSha256: "a".repeat(64), tabId: "terminal:3fa91c0e-2", cwd: "/tmp/Work/app", cwdForMatch: "/private/tmp/work/app" } } }, vi.fn());
    expect(screen.queryByTestId("approval-terminal-note")).toBeNull();
    expect(screen.getByTestId("approval-terminal-target")).toHaveTextContent("/tmp/Work/app");
  });

  it("remembers the command in that directory for this session only", async () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    renderApproval(terminalRunRequest(), onDecide);
    const remember = screen.getByTestId(TEST_IDS.allowSessionButton);
    expect(remember).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("/workspace/project/app");
    fireEvent.click(remember);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-session", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ scope: "session" }));
  });
});

describe("ToolApprovalContent host terminal card", () => {
  const rule = 'HostTerminal(zsh "/Users/me/repo" npm test)';
  const shellRule = {
    dialect: "bash" as const, exactRule: rule, denyRule: "Bash(npm test)", denyAllowed: true, projectCwd: "/Users/me/repo", projectRoot: "/Users/me/repo",
    sessionAllowed: false, persistentAllowed: true, hostTerminal: { shell: "zsh" as const, cwd: "/Users/me/repo" },
  };
  const hostRequest = (allowedDirectories: string[]): ApprovalRequest => terminalRunRequest({
    args: { command: "npm test" },
    persistentAllowAllowed: false,
    persistentApprovalCwd: undefined,
    requireExplicit: true,
    shellRule,
    evaluationContext: evaluationContext(allowedDirectories),
    approvalMemory: {
      kind: "key",
      key: "terminal_run:host",
      scope: {
        kind: "terminal-command", lane: "manual", commandSha256: "b".repeat(64), tabId: "terminal:0000c0de-1", terminalSessionId: "host",
        sessionId: "11111111-1111-4111-8111-111111111111", shell: "zsh", cwd: "/Users/me/repo", physicalCwd: "/Users/me/repo",
        cwdDevice: "1", cwdInode: "2", controlGeneration: 3, cwdForMatch: "/users/me/repo",
      },
    },
  });
  afterEach(() => { vi.unstubAllGlobals(); clearActiveSurface(); });

  it("names the user's own shell and warns that the output returns to the model, without a sandbox claim", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    showActiveSurface({ kind: "terminal", tabId: "terminal:0000c0de-1", label: "Terminal 4", cwd: "/Users/me/repo" });
    renderApproval(hostRequest(["/elsewhere"]), vi.fn());
    expect(screen.getByTestId("approval-terminal-target")).toHaveTextContent(
      t("toolApprovalDialog.hostTerminalTarget", { command: "npm test", terminal: "Terminal 4", shell: "zsh", cwd: "/Users/me/repo" }));
    const notes = screen.getAllByTestId("approval-terminal-note").map((note) => note.textContent);
    expect(notes).toContain(t("toolApprovalDialog.hostTerminalWarning"));
    expect(notes).toContain(t("toolApprovalDialog.hostTerminalOutsideAllowed", { cwd: "/Users/me/repo" }));
    expect(notes).not.toContain(t("toolApprovalDialog.terminalOutsideAllowed", { cwd: "/Users/me/repo" }));
    expect(screen.getByTestId("approval-decision-bar")).toHaveAttribute("data-approval-variant", "shell");
    // Its own warning replaces the generic sandbox note, and its rule names a shell and folder, not a project.
    expect(screen.queryByTestId("approval-shell-outside-sandbox")).toBeNull();
    expect(screen.queryByTestId("approval-shell-rule-scope-target")).toBeNull();
  });

  it("offers only the exact host rule as a lasting allow, not editable, with no session or project allow", () => {
    const model = shellDecisionModel(shellRule);
    expect(model.options["allow-session"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.hostTerminalRuleScope" });
    expect(model.options["allow-project"]).toMatchObject({ offered: false, reasonKey: "toolApprovalDialog.hostTerminalRuleScope" });
    expect(model.options["allow-everywhere"]).toMatchObject({ offered: true, rule, editing: null, labelKey: "toolApprovalDialog.decisionAllowHostTerminal" });
    expect(model.options["deny-always"]).toMatchObject({ offered: true, rule: "Bash(npm test)" });
    expect(model.warnsOnWildcardAllow).toBe(false);
  });
});
