// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { clearActiveSurface, showActiveSurface } from "../../preview/active-surface.js";
import { PERMISSION_REVIEWER_FRAMEWORK_VERSION } from "../../../../shared/permission-reviewer-framework.js";

/**
 * A `terminal_run` card shows the exact command and the terminal it will be
 * typed into — the target the host sealed before the card was shown — and
 * remembers the command in that directory for this app session only.
 */
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
    reviewerVerdict: { level: "medium", reason: "runs the test suite" },
    persistentAllowAllowed: true,
    persistentApprovalCwd: "/workspace/project",
    approvalMemory: {
      kind: "key",
      key: "terminal_run:command",
      scope: { kind: "terminal-command", commandSha256: "a".repeat(64), tabId: "terminal:3fa91c0e-2", cwd: "/workspace/project/app" },
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
    render(<ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest()} onDecide={vi.fn()} />);
    const target = screen.getByTestId("approval-terminal-target");
    // The exact command is on the always-visible line, not only behind the details toggle.
    expect(target).toHaveTextContent("npm test -- --watch=false");
    expect(target).toHaveTextContent("Terminal 2");
    expect(target).toHaveTextContent("/workspace/project/app");
  });

  it("names a terminal that is not the active one by its id rather than guessing a label", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    showActiveSurface({ kind: "terminal", tabId: "terminal:3fa91c0e-1", label: "Terminal 1" });
    render(<ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest()} onDecide={vi.fn()} />);
    const target = screen.getByTestId("approval-terminal-target");
    expect(target).toHaveTextContent("terminal:3fa91c0e-2");
    expect(target).not.toHaveTextContent("Terminal 1");
  });

  it("names a look-alike letter in a mixed-script word by code point, so it cannot pass as the letter it imitates", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    // A Cyrillic a in place of the Latin one.
    render(<ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest({ args: { command: "open p\u0430ypal.com" } })} onDecide={vi.fn()} />);
    const notes = screen.getAllByTestId("approval-terminal-note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("U+0430");
  });

  it("does not warn about a word written in one script, such as a Korean filename", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest({ args: { command: "cat \ubcf4\uace0\uc11c.txt" } })} onDecide={vi.fn()} />);
    expect(screen.getByTestId("approval-terminal-target")).toHaveTextContent("cat \ubcf4\uace0\uc11c.txt");
    expect(screen.queryByTestId("approval-terminal-note")).toBeNull();
  });

  it("says when the terminal's directory is outside the allowed folders, and only then", () => {
    vi.stubGlobal("ave", { userApproval: { record: vi.fn() } });
    const { unmount } = render(
      <ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest({ evaluationContext: evaluationContext(["/elsewhere"]) })} onDecide={vi.fn()} />,
    );
    expect(screen.getByTestId("approval-terminal-note")).toHaveTextContent("/workspace/project/app");
    unmount();
    render(<ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest({ evaluationContext: evaluationContext(["/workspace/project"]) })} onDecide={vi.fn()} />);
    expect(screen.queryByTestId("approval-terminal-note")).toBeNull();
  });

  it("remembers the command in that directory for this session only", async () => {
    const onDecide = vi.fn();
    const record = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("ave", { userApproval: { record } });
    render(<ToolApprovalContent conversationLabel="conversation" open request={terminalRunRequest()} onDecide={onDecide} />);
    const remember = screen.getByTestId(TEST_IDS.allowAlwaysButton);
    expect(remember).toHaveTextContent("이번 세션 동안 허용");
    expect(screen.getByTestId("allow-always-exact-scope")).toHaveTextContent("/workspace/project/app");
    fireEvent.click(remember);
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith("allow-always", undefined));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ scope: "session" }));
  });
});
