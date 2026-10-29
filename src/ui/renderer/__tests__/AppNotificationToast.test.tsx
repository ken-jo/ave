import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { approvalRequest, clickSidebarNavRow, endAnimation, splitIntoTwoTiles } from "../../../../test/renderer/helpers.js";
import { MOCK_DEFAULT_SESSION_ID } from "../../../../test/renderer/mock-ave-api.js";
import { A2ATaskState } from "../../../shared/a2a.js";

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

  it.each(["work-board", "web"])("returns from the covering %s surface and focuses the requesting conversation card", async (surface) => {
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
    const surfaceSelector = surface === "web" ? '[data-surface-kind="browser"]' : '[data-testid="main-pane-shell"][data-view="work-board"]';
    await clickSidebarNavRow("features", surface === "web" ? "sidebar-web" : "toolbar-work-board");
    await waitFor(() => expect(container.querySelector(surfaceSelector)).not.toBeNull());
    await act(async () => {
      emitApproval(approvalRequest({ id: "notice-write", sessionId: MOCK_DEFAULT_SESSION_ID }));
    });
    await screen.findByTestId("tool-approval-panel");
    expect(screen.getByTestId("approval-conversation").textContent).toContain(
      screen.getByTestId(`sidebar-session-${MOCK_DEFAULT_SESSION_ID}`).textContent,
    );
    expect(screen.getAllByText(`현재 화면 뒤에 있는 대화의 요청: ${title}`)).toHaveLength(1);
    expect(api.onNotificationClicked).toHaveBeenCalledTimes(1);
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
      expect(container.querySelector(surfaceSelector)).toBeNull();
      const panel = screen.getByTestId("tool-approval-panel");
      expect(panel.getAttribute("data-approval-request-id")).toBe("notice-write");
      expect(document.activeElement).toBe(panel);
      expect(screen.getByTestId("approval-conversation").textContent).toBe(title);
    });
    expect(api.onNotificationClicked).toHaveBeenCalledTimes(1);
  });

  it("reveals the parent tile for an inherited child approval without loading the child session", async () => {
    const { api, container, emitAgentSpawnEvent, emitApproval, emitNotificationClicked } = await renderApp();
    await waitFor(() => expect(api.chatGetHistory).toHaveBeenCalled());
    await act(async () => {
      emitAgentSpawnEvent({ type: "start", spawnId: "notice-child", parentSessionId: MOCK_DEFAULT_SESSION_ID,
        childSessionId: "session-child", title: "Internal child task", taskState: A2ATaskState.SUBMITTED });
    });
    await clickSidebarNavRow("features", "sidebar-web");
    await waitFor(() => expect(container.querySelector('[data-surface-kind="browser"]')).not.toBeNull());
    await act(async () => emitApproval(approvalRequest({ id: "child-approval", sessionId: "session-child" })));
    await screen.findByTestId("tool-approval-panel");
    const resumeCount = api.chatSessionResume.mock.calls.length;
    await act(async () => emitNotificationClicked({ kind: "approval", contextRef: { approvalId: "child-approval", sessionId: "session-child" } }));
    await waitFor(() => {
      expect(container.querySelector('[data-surface-kind="browser"]')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId("tool-approval-panel"));
    });
    expect(api.chatSessionResume).toHaveBeenCalledTimes(resumeCount);
    expect(api.chatSessionResume).not.toHaveBeenCalledWith("session-child");
    expect(api.onNotificationClicked).toHaveBeenCalledTimes(1);
  });

  it("keeps one notification click subscription while approval queues and tiles change", async () => {
    const { api, container, emitApproval, emitApprovalSettled } = await renderApp();
    await waitFor(() => expect(api.onNotificationClicked).toHaveBeenCalledTimes(1));
    await act(async () => emitApproval(approvalRequest({ sessionId: MOCK_DEFAULT_SESSION_ID })));
    await screen.findByTestId("tool-approval-panel");
    expect(api.onNotificationClicked).toHaveBeenCalledTimes(1);
    await act(async () => emitApprovalSettled("req-approval"));
    await splitIntoTwoTiles(container);
    expect(api.onNotificationClicked).toHaveBeenCalledTimes(1);
  });

  it("names an untitled in-panel approval from its first user message", async () => {
    const { emitApproval } = await renderApp({ history: { sessionId: MOCK_DEFAULT_SESSION_ID,
      messages: [{ index: 0, role: "user", content: "Set up diagram views" }] } });
    await screen.findByText("Set up diagram views");
    await act(async () => emitApproval(approvalRequest({ sessionId: MOCK_DEFAULT_SESSION_ID })));
    expect(await screen.findByTestId("approval-conversation")).toHaveTextContent("Set up diagram views");
  });

  it("opens the deferred queue when its notification belongs to a claimed conversation", async () => {
    const { api, emitNotificationClicked } = await renderApp();
    await waitFor(() => expect(api.chatGetHistory).toHaveBeenCalled());
    await act(async () => emitNotificationClicked({ kind: "approval",
      contextRef: { approvalId: "deferred-request", sessionId: MOCK_DEFAULT_SESSION_ID } }));
    expect(await screen.findByRole("dialog")).toBeVisible();
    expect(api.chatSessionResume).not.toHaveBeenCalledWith(MOCK_DEFAULT_SESSION_ID);
  });
});
