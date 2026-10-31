// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApproval } from "./support/render-approval.js";
import type { ApprovalRequest } from "../../types.js";
import type { UserOwnedSurface } from "../../../../shared/permissions-events.js";
import { t } from "../../../../i18n/runtime.js";
import { ToolApprovalContent } from "../ToolApprovalContent.js";
import { useApproval } from "../../hooks/use-approval.js";

afterEach(() => vi.unstubAllGlobals());

function request(surface: UserOwnedSurface = "browser", overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "surface-card", category: "tool", toolName: surface === "browser" ? "browser_click" : "terminal_run", source: "builtin", toolCategory: "write",
    sessionId: "conversation", args: { command: "printf ready" }, reason: "Continue the requested task", createdAt: Date.now(), requireExplicit: true,
    userOwnedSurface: surface, exactRecordAllowed: false, persistentAllowAllowed: false,
    allowedChoices: ["allow-once", "deny-once"], ...overrides,
  };
}

describe("shared user-owned surface approval card", () => {
  it.each(["browser", "host-terminal"] as const)("preserves the notification navigation focus target for %s", (surface) => {
    const decide = vi.fn();
    const card = request(surface);
    renderApproval(card, decide);
    const panel = [...document.querySelectorAll<HTMLElement>('[data-testid="tool-approval-panel"]')]
      .find((element) => element.dataset.approvalRequestId === card.id && !element.closest('[data-visible="false"]'));
    expect(panel).toBeDefined();
    expect(panel).toHaveAttribute("tabindex", "-1");
    expect(panel).toHaveAttribute("data-approval-tool-name", card.toolName);
    panel!.focus();
    expect(document.activeElement).toBe(panel);
    expect(decide).not.toHaveBeenCalled();
    fireEvent.keyDown(panel!, { key: "Escape" });
    expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once");
  });

  it.each(["browser", "host-terminal"] as const)("confirms every %s session choice only after explicit action consent", (surface) => {
    for (const choice of ["allow", "auto", "ask"] as const) {
      const decide = vi.fn();
      const shown = renderApproval(request(surface), decide);
      expect(screen.getByTestId("user-owned-surface-ask")).toBeChecked();
      fireEvent.click(screen.getByTestId(`user-owned-surface-${choice}`));
      expect(decide).not.toHaveBeenCalled();
      expect(screen.queryByTestId("approval-decision-bar")).toBeNull();
      fireEvent.click(screen.getByTestId("user-owned-surface-confirm"));
      expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { userOwnedSurfaceChoice: choice });
      fireEvent.click(screen.getByTestId("user-owned-surface-confirm"));
      expect(decide).toHaveBeenCalledOnce();
      shown.unmount();
    }
  });

  it("confirms ask by default without creating a remembered rule", () => {
    const record = vi.fn();
    vi.stubGlobal("ave", { userApproval: { record } });
    const decide = vi.fn();
    renderApproval(request(), decide);
    fireEvent.click(screen.getByTestId("user-owned-surface-confirm"));
    expect(decide).toHaveBeenCalledExactlyOnceWith("allow-once", undefined, { userOwnedSurfaceChoice: "ask" });
    expect(record).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.each(["cancel", "escape"] as const)("%s denies this action without selecting a session policy", (method) => {
    const decide = vi.fn();
    renderApproval(request(), decide);
    fireEvent.click(screen.getByTestId("user-owned-surface-allow"));
    if (method === "cancel") fireEvent.click(screen.getByTestId("user-owned-surface-dismiss"));
    else fireEvent.keyDown(screen.getByTestId("user-owned-surface-allow"), { key: "Escape" });
    expect(decide).toHaveBeenCalledExactlyOnceWith("deny-once");
  });

  it("locks choices and confirmation while another interaction owns the card", () => {
    const decide = vi.fn();
    renderApproval(request(), decide).rerender(<ToolApprovalContent open request={request()} conversationLabel="conversation" interactionLocked onDecide={decide} />);
    expect(screen.getByTestId("user-owned-surface-allow")).toBeDisabled();
    fireEvent.click(screen.getByTestId("user-owned-surface-confirm"));
    expect(decide).not.toHaveBeenCalled();
  });

  it("resets the default when the next surface action is shown", () => {
    const decide = vi.fn();
    const shown = renderApproval(request(), decide);
    fireEvent.click(screen.getByTestId("user-owned-surface-auto"));
    shown.rerender(<ToolApprovalContent open request={request("host-terminal", { id: "next-card" })} conversationLabel="conversation" onDecide={decide} />);
    expect(screen.getByTestId("user-owned-surface-ask")).toBeChecked();
    expect(decide).not.toHaveBeenCalled();
  });

  it("shows a normal once card after uncertain automatic review", () => {
    renderApproval(request("browser", { userOwnedSurfaceReviewFallback: true, reviewerVerdict: { level: "high", reason: "Task intent is uncertain" } }), vi.fn());
    expect(screen.queryByTestId("user-owned-surface-card")).toBeNull();
    expect(screen.getByTestId("approval-decision-bar")).toBeInTheDocument();
    expect(screen.getByTestId("approval-logical-review-fallback")).toHaveTextContent(t("toolApprovalDialog.surfaceReviewNeedsConfirmation"));
    expect(screen.queryByText("HIGH")).toBeNull();
  });

  it("labels Auto confirmation as a review of the current action", () => {
    renderApproval(request(), vi.fn());
    fireEvent.click(screen.getByTestId("user-owned-surface-auto"));
    expect(screen.getByTestId("user-owned-surface-confirm")).toHaveTextContent(t("toolApprovalDialog.surfaceReview"));
  });

  it.each(["allow", "auto", "ask"] as const)("forwards %s through the real approval queue with the original signature", async (choice) => {
    const card = request("browser", { nonce: "native-nonce", hmac: "native-hmac" });
    const respond = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("ave", { approval: { onRequest: vi.fn(() => () => {}), onSettled: vi.fn(() => () => {}), listPending: vi.fn(async () => [card]), respond } });
    const hook = renderHook(useApproval);
    await waitFor(() => expect(hook.result.current.queue).toHaveLength(1));
    await act(async () => { await hook.result.current.decide(card.id, "allow-once", undefined, { userOwnedSurfaceChoice: choice }); });
    expect(respond).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: card.id, choice: "allow-once", userOwnedSurfaceChoice: choice, nonce: card.nonce, hmac: card.hmac }));
    hook.unmount();
  });

  it("preserves the sealed browser origin", () => {
    renderApproval(request("browser", { approvalMemory: { kind: "key", key: "browser-target", scope: { kind: "browser-origin", origin: "https://service.example.test", tabOpener: "user", tabId: "tab-1", documentId: 1 } } }), vi.fn());
    fireEvent.click(screen.getByText(t("toolApprovalDialog.reviewDetails")));
    expect(screen.getByTestId("user-owned-surface-target")).toBeVisible();
    expect(screen.getByTestId("user-owned-surface-target")).toHaveTextContent("https://service.example.test");
  });

  it("keeps choices outside collapsed long action details without hiding the real-shell warning", () => {
    const command = `printf ${"long-task-value ".repeat(80)}`;
    renderApproval(request("host-terminal", { args: { command } }), vi.fn());
    const details = screen.getByTestId("user-owned-surface-review-details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByTestId("user-owned-surface-note")).toBeVisible();
    expect(screen.getByTestId("user-owned-surface-note")).toHaveTextContent(t("toolApprovalDialog.hostTerminalWarning"));
    expect(screen.getByTestId("user-owned-surface-choice-form").closest("details")).toBeNull();
    for (const name of ["allow", "auto", "ask", "confirm", "dismiss"]) expect(screen.getByTestId(`user-owned-surface-${name}`)).toBeVisible();
    expect(screen.getByTestId("user-owned-surface-ask")).toBeChecked();
    fireEvent.click(screen.getByText(t("toolApprovalDialog.reviewDetails")));
    expect(details).toHaveAttribute("open");
    expect(screen.getByTestId("user-owned-surface-full-input")).toBeVisible();
    expect(JSON.parse(screen.getByTestId("user-owned-surface-full-input").textContent ?? "{}")).toEqual({ command });
  });

  it("preserves host shell, physical directory, terminal identity and output disclosure", () => {
    renderApproval(request("host-terminal", { toolCategory: "shell", approvalMemory: { kind: "key", key: "terminal-target", scope: {
      kind: "terminal-command", lane: "manual", commandSha256: "b".repeat(64), tabId: "terminal:example", terminalSessionId: "host-incarnation", sessionId: "conversation", turnId: "turn", shell: "zsh",
      cwd: "/workspace/project", physicalCwd: "/workspace/project", cwdDevice: "1", cwdInode: "2", controlGeneration: 1, cwdForMatch: "/workspace/project",
    } } }), vi.fn());
    expect(screen.getByTestId("user-owned-surface-note")).toBeVisible();
    fireEvent.click(screen.getByText(t("toolApprovalDialog.reviewDetails")));
    expect(screen.getByTestId("user-owned-surface-target")).toBeVisible();
    expect(screen.getByTestId("user-owned-surface-target")).toHaveTextContent("terminal:example");
    expect(screen.getByTestId("user-owned-surface-target")).toHaveTextContent("/workspace/project");
    expect(screen.getByTestId("user-owned-surface-target")).toHaveTextContent("zsh");
    expect(screen.getByTestId("user-owned-surface-note")).toHaveTextContent(t("toolApprovalDialog.hostTerminalWarning"));
  });
});
