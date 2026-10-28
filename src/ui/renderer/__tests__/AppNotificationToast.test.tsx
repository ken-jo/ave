import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { approvalRequest, clickSidebarNavRow, endAnimation } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-ave-api.js";

describe("App notification toasts", () => {
  const originalGlobalResizeObserver = globalThis.ResizeObserver;
  const originalWindowResizeObserver = window.ResizeObserver;

  beforeEach(() => {
    class TestResizeObserver {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalGlobalResizeObserver,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: originalWindowResizeObserver,
    });
    vi.restoreAllMocks();
  });

  it("routes the Learn more action through notifyClick and dismisses the toast", async () => {
    const user = userEvent.setup();
    const { api, emitNotificationToast } = await renderApp();

    emitNotificationToast({
      kind: "ask-user",
      title: "질문",
      body: "진행해도 될까요?",
      contextRef: { questionId: "q-1" },
    });

    await user.click(await screen.findByRole("button", { name: /자세히 알아보기|Learn more/ }));

    expect(api.notifyClick).toHaveBeenCalledWith({
      kind: "ask-user",
      contextRef: { questionId: "q-1" },
    });
    // Dismissed: the bar draws the toast once more on its way out, then leaves.
    await waitFor(() => {
      expect(screen.getByTestId("status-bar-presence").dataset.leaving).toBe("true");
    });
    endAnimation(screen.getByTestId("status-bar-presence"));
    expect(screen.queryByTestId("status-toast-message")).toBeNull();
  });

  it("handles clicked session notifications by loading the referenced chat", async () => {
    const { api, emitNotificationClicked } = await renderApp({
      historyBySession: {
        "sess-target": {
          sessionId: "sess-target",
          sessionTitle: "알림 대상 세션",
          sessionKind: "main",
          messages: [],
        },
      },
    });

    emitNotificationClicked({
      kind: "turn-end",
      contextRef: { sessionId: "sess-target" },
    });

    await waitFor(() => {
      expect(api.chatSessionResume).toHaveBeenCalledWith("sess-target");
    });
  });

  it("returns from a covering surface and focuses the requesting conversation card when its toast is clicked", async () => {
    const user = userEvent.setup();
    const title = "그래 두개 진행해보자";
    const { api, container, emitApproval, emitNotificationToast, emitNotificationClicked } = await renderApp({
      hasApiKey: true,
      sessions: [{ id: MOCK_DEFAULT_SESSION_ID, title, modifiedAt: "2026-01-01T00:00:00Z" }],
      history: { sessionId: MOCK_DEFAULT_SESSION_ID, messages: [
        { index: 0, role: "user", content: title },
        { index: 1, role: "user", content: "Continue" },
      ] },
    });
    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => expect(container.querySelector('[data-testid="main-pane-shell"][data-view="work-board"]')).not.toBeNull());
    await act(async () => {
      emitApproval(approvalRequest({ id: "notice-write", sessionId: MOCK_DEFAULT_SESSION_ID }));
    });
    await screen.findByTestId("tool-approval-panel");
    expect(screen.getByTestId("approval-conversation").textContent).toContain(
      screen.getByTestId(`sidebar-session-${MOCK_DEFAULT_SESSION_ID}`).textContent,
    );
    api.notifyClick.mockImplementation(async (payload) => {
      emitNotificationClicked(payload);
      return { ok: true };
    });
    await act(async () => {
      emitNotificationToast({
        kind: "approval",
        title: "승인이 필요합니다",
        body: "views.c4 파일 쓰기 · 대화: 그래 두개 진행해보자",
        contextRef: { approvalId: "notice-write", sessionId: MOCK_DEFAULT_SESSION_ID },
      });
    });
    await user.click(await screen.findByRole("button", { name: /자세히 알아보기|Learn more/ }));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="main-pane-shell"][data-view="work-board"]')).toBeNull();
      const panel = screen.getByTestId("tool-approval-panel");
      expect(panel.getAttribute("data-approval-request-id")).toBe("notice-write");
      expect(document.activeElement).toBe(panel);
    });
  });
});
