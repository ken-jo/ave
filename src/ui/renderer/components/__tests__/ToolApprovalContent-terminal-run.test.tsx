// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import type { ApprovalRequest } from "../../types.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { clearActiveSurface, showActiveSurface } from "../../preview/active-surface.js";

/**
 * A `terminal_run` card shows the exact command and the terminal it will be
 * typed into — the target the host sealed before the card was shown — and
 * remembers the command in that directory for this app session only.
 */
function terminalRunRequest(): ApprovalRequest {
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
    expect(screen.getAllByText(/npm test -- --watch=false/).length).toBeGreaterThan(0);
    const target = screen.getByTestId("approval-terminal-target");
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
