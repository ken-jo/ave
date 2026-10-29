// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, act, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { SideChatView } from "../SideChatView.js";
import type { ChatStreamEvent } from "../../../../lib/chat-stream-state.js";
import type { AveApi } from "../../types.js";
import { ChatContextProvider, type ChatContextValue } from "../../context/ChatContext.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { approvalRequest, approvalSurfaceStub, deferred } from "../../../../../test/renderer/helpers.js";
import { makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { getUsableContext } from "../../../../shared/context-budget.js";
import type { ApprovalRequest, AskUserQuestionRequest } from "../../types.js";

beforeEach(() => { vi.stubGlobal("ave", makeMockAveNamespace().ns); });
afterEach(() => { vi.unstubAllGlobals(); });

function makeApi() {
  // Two subscribers share the side stream — the transcript reducer and the message queue's drain — so the seam fans every
  // frame out to all of them, in subscription order, exactly as the preload channel does.
  const handlers = new Set<(e: ChatStreamEvent) => void>();
  const spies = {
    send: vi.fn(async (_input: string, _attachments?: unknown[], _originSessionId?: string, _sendRequestId?: string) => ({ ok: true as const, result: {} })),
    new: vi.fn(async () => ({ ok: true as const, sessionId: "side-2" })),
    abort: vi.fn(async () => ({ ok: true as const })),
    listShellTasks: vi.fn(async () => []),
    controlShellTask: vi.fn(async () => ({ ok: true as const, shellId: "side-command" })),
  };
  const api = {
    sideChat: {
      ...spies,
      load: vi.fn(),
      list: vi.fn(),
      onStream: (h: (e: ChatStreamEvent) => void) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as AveApi;
  return {
    api,
    dispatch: (e: ChatStreamEvent) => { for (const h of handlers) h(e); },
    emit: (e: ChatStreamEvent) => act(() => { for (const h of handlers) h(e); }),
    acceptTurn: (streamId: number) => act(() => {
      for (const h of handlers) h({
        type: "user_message", sessionId: "side-1", streamId, sendRequestId: spies.send.mock.calls.at(-1)![3],
      });
    }),
    spies,
  };
}

function renderView(
  api: AveApi,
  chatContext?: Partial<ChatContextValue>,
  view?: Partial<React.ComponentProps<typeof SideChatView>>,
) {
  return render(
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
        {chatContext ? (
          <ChatContextProvider value={chatContext as ChatContextValue}>
            <SideChatView api={api} {...view} />
          </ChatContextProvider>
        ) : <SideChatView api={api} {...view} />}
      </ApprovalSurfaceProvider>
    </TooltipProvider>,
  );
}

/** The side chat's own composer field and turn control, scoped to its view. */
function sideComposer() {
  const view = within(screen.getByTestId("side-chat-view"));
  return {
    textarea: view.getByTestId("composer-textarea") as HTMLTextAreaElement,
    sendButton: () => view.getByTestId("composer-send-button") as HTMLButtonElement,
    view,
  };
}

async function startTurn(text = "hello") {
  const { textarea, sendButton } = sideComposer();
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.click(sendButton());
  await act(async () => {});
}

describe("SideChatView — New button gating during streaming", () => {
  it("keeps a pane send running across a surface switch and restores its continuing transcript", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    const reply = deferred<{ ok: true; result: Record<string, never> }>();
    spies.send.mockReturnValueOnce(reply.promise);
    api.sideChat!.paneHistory = vi.fn(async () => ({ ok: true as const, sessionId: null, messages: [] }));
    const boundSurface = { kind: "terminal" as const, tabId: "terminal-pane", name: "Terminal 1", detail: null, detailTitle: null };
    const first = renderView(api, { hasApiKey: true, settingsLoaded: true }, { boundSurface });
    await startTurn("continue on the terminal");
    acceptTurn(1);
    emit({ type: "text_delta", streamId: 1, text: "before " });
    first.unmount();
    expect(spies.abort).not.toHaveBeenCalled();
    emit({ type: "text_delta", streamId: 1, text: "hidden " });
    const onSessionIdChange = vi.fn();
    renderView(api, { hasApiKey: true, settingsLoaded: true }, { boundSurface, onSessionIdChange });
    await waitFor(() => expect(api.sideChat!.paneHistory).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("side-chat-transcript")).toHaveTextContent("before hidden");
    expect(onSessionIdChange).toHaveBeenCalledWith("side-1");
    emit({ type: "text_delta", streamId: 1, text: "after" });
    expect(screen.getByTestId("side-chat-transcript")).toHaveTextContent("before hidden after");
    emit({ type: "done", streamId: 1 });
    await act(async () => { reply.resolve({ ok: true, result: {} }); });
  });

  it("sends Ctrl+B command controls through the side conversation API", async () => {
    const { api, acceptTurn, spies } = makeApi();
    const mainControl = vi.fn();
    api.chatControlShellTask = mainControl;
    renderView(api);
    await startTurn();
    acceptTurn(1);
    fireEvent.keyDown(sideComposer().textarea, { key: "b", ctrlKey: true });
    await waitFor(() => expect(spies.controlShellTask).toHaveBeenCalledWith("side-1", "background", undefined));
    expect(mainControl).not.toHaveBeenCalled();
    expect(spies.listShellTasks).toHaveBeenCalledWith("side-1");
  });

  it("keeps its own context warning in its composer and compaction history in its transcript", async () => {
    const { api, emit, acceptTurn } = makeApi();
    renderView(api, { hasApiKey: true, settingsLoaded: true, llmContextWindow: 100_000, autoCompactEnabled: true, contextOverflowPct: 0.1 });
    await startTurn();
    acceptTurn(1);
    emit({ type: "compact_notice", streamId: 1, removedMessages: 3, freedTokens: 100, estimatedAfter: getUsableContext(100_000) * 1.09, summary: "Side decisions" });
    const notice = screen.getByTestId("composer-context-notice");
    expect(notice.closest('[data-testid="side-chat-composer-dock"]')).not.toBeNull();
    expect(notice).toHaveTextContent("109%");
    expect(notice).toHaveAttribute("data-severity", "warning");
    expect(screen.getByTestId("summary-toast").closest('[data-testid="side-chat-transcript"]')).not.toBeNull();
    expect(screen.getAllByTestId("checkpoint-divider")).toHaveLength(1);
    emit({ type: "compact_notice", streamId: 1, removedMessages: 1, freedTokens: 100, estimatedAfter: 0 });
    expect(screen.queryByTestId("composer-context-notice")).toBeNull();
  });

  it("disables the New button while a turn is streaming", async () => {
    const { api, emit, acceptTurn } = makeApi();
    renderView(api);

    // Idle → New is enabled.
    const newBtn = screen.getByTestId("side-chat-new") as HTMLButtonElement;
    expect(newBtn.disabled).toBe(false);

    await startTurn();
    acceptTurn(1);
    emit({ type: "text_delta", text: "streaming…", streamId: 1 });

    // Streaming → New is disabled (no mid-stream session swap).
    expect((screen.getByTestId("side-chat-new") as HTMLButtonElement).disabled).toBe(true);

    // Turn done → New is enabled again.
    emit({ type: "done", streamId: 1 });
    expect((screen.getByTestId("side-chat-new") as HTMLButtonElement).disabled).toBe(false);
  });

  it("uses the main runtime readiness gate before side-chat can send and preserves the draft", async () => {
    const { api, spies } = makeApi();
    const onOpenSettings = vi.fn();
    renderView(api, {
      hasApiKey: false,
      subscriptionUnavailableProvider: "codex",
      onOpenSettings,
    });

    const { textarea, sendButton, view } = sideComposer();
    fireEvent.change(textarea, { target: { value: "keep this draft" } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe("keep this draft");

    // The same no-credential chip the main dock shows, one click from settings.
    fireEvent.click(view.getByTestId("composer-subscription-runtime-chip"));
    const settings = await waitFor(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="composer-api-key-chip:settings"]');
      expect(button).not.toBeNull();
      return button!;
    });
    fireEvent.click(settings);
    expect(onOpenSettings).toHaveBeenCalledWith("llm");
  });

  it("does not render token or cost estimates for a subscription side-chat runtime", async () => {
    const { api, emit, acceptTurn } = makeApi();
    renderView(api, { hasApiKey: true, usageAvailable: false });

    await startTurn();
    acceptTurn(1);
    emit({ type: "assistant_round", text: "answer", stopReason: "end_turn", hasToolCalls: false, streamId: 1 } as ChatStreamEvent);
    emit({
      type: "turn_summary",
      turnDurationMs: 20,
      toolCount: 0,
      cumulativeToolMs: 0,
      tokensIn: 100,
      freshInputTokens: 90,
      tokensOut: 10,
      streamId: 1,
    } as ChatStreamEvent);
    emit({ type: "done", streamId: 1 });

    expect(screen.queryByTestId(TEST_IDS.tokenCostBadge)).toBeNull();
  });
});

describe("SideChatView — processing detail parity", () => {
  it("uses the shared tools-only policy without hiding the final answer", async () => {
    const { api, emit, acceptTurn } = makeApi();
    renderView(api, { processingDisplayLevel: "tools" });
    await startTurn("inspect");
    acceptTurn(1);

    emit({ type: "reasoning_delta", text: "side reasoning", streamId: 1 });
    emit({ type: "text_delta", text: "side intermediate", streamId: 1 });
    emit({ type: "assistant_round", text: "side intermediate", stopReason: "tool_use", hasToolCalls: true, streamId: 1 });
    emit({ type: "tool_start", groupId: "side-group", toolUseId: "side-tool", name: "inspect", displayOrder: 0, streamId: 1 });
    emit({ type: "tool_end", groupId: "side-group", toolUseId: "side-tool", name: "inspect", displayOrder: 0, result: "ok", streamId: 1 });
    emit({ type: "text_delta", text: "side final", streamId: 1 });
    emit({ type: "assistant_round", text: "side final", stopReason: "end_turn", hasToolCalls: false, streamId: 1 });
    emit({ type: "done", streamId: 1 });

    const view = within(screen.getByTestId("side-chat-view"));
    expect(view.getByTestId("work-group")).toBeTruthy();
    expect(view.queryByText("side reasoning")).toBeNull();
    expect(view.queryByText("side intermediate")).toBeNull();
    expect(view.getByText("side final")).toBeTruthy();
  });
});

describe("SideChatView — the main composer's input system", () => {
  it("recalls the side conversation's earlier prompt with ArrowUp", async () => {
    const { api } = makeApi();
    renderView(api);
    await startTurn("side prompt one");
    const { textarea } = sideComposer();
    expect(textarea.value).toBe("");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("side prompt one");
  });

  it("renders the shared composer at the side surface, inside the shared frame", () => {
    const { api } = makeApi();
    renderView(api);
    const { textarea, view } = sideComposer();
    expect(textarea.getAttribute("data-composer-surface")).toBe("side");
    expect(textarea.className).toContain("max-h-[112px]");
    expect(textarea.className).toContain("text-body-sm");
    expect(textarea.className).toContain("text-input-bar-foreground");
    // One line at rest on both surfaces — the shared field, not a per-surface copy.
    expect(textarea.getAttribute("rows")).toBe("1");
    expect(textarea.hasAttribute("data-tour-anchor")).toBe(false);
    expect(view.getByTestId("composer-frame")).toBeTruthy();
    expect(view.getByTestId("iab-attach-button")).toBeTruthy();
  });

  it("queues a plain Enter while a turn runs and drains it as the next turn on done", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    renderView(api);
    const { textarea, view } = sideComposer();

    await startTurn("first");
    acceptTurn(1);
    emit({ type: "text_delta", text: "working…", streamId: 1 });
    expect(spies.send).toHaveBeenCalledTimes(1);

    fireEvent.change(textarea, { target: { value: "second" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");
    expect(within(view.getByTestId("message-queue-panel")).getByText("second")).toBeTruthy();
    expect(spies.abort).not.toHaveBeenCalled();

    // The turn closes → the queue goes out as a fresh turn, without an abort.
    emit({ type: "done", streamId: 1 });
    await waitFor(() => expect(spies.send).toHaveBeenCalledTimes(2));
    expect(spies.send.mock.calls[1][0]).toBe("second");
    expect(spies.abort).not.toHaveBeenCalled();
    await waitFor(() => expect(view.queryByTestId("message-queue-panel")).toBeNull());
  });

  it("interrupts the running turn on ⌘⏎: abort settles first, then the new send goes out", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    renderView(api);
    const { textarea } = sideComposer();

    await startTurn("first");
    acceptTurn(1);
    emit({ type: "text_delta", text: "working…", streamId: 1 });

    fireEvent.change(textarea, { target: { value: "now instead" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    await waitFor(() => expect(spies.send).toHaveBeenCalledTimes(2));
    expect(spies.abort).toHaveBeenCalledTimes(1);
    expect(spies.abort.mock.invocationCallOrder[0]).toBeLessThan(spies.send.mock.invocationCallOrder[1]);
    expect(spies.send.mock.calls[1][0]).toBe("now instead");
    expect(textarea.value).toBe("");
  });

  it("aborts the running turn on Esc inside the field when nothing is queued", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    renderView(api);
    const { textarea } = sideComposer();

    await startTurn("first");
    acceptTurn(1);
    emit({ type: "text_delta", text: "working…", streamId: 1 });

    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() => expect(spies.abort).toHaveBeenCalledTimes(1));
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it("does not send an Enter that commits an IME composition", () => {
    const { api, spies } = makeApi();
    renderView(api);
    const { textarea } = sideComposer();

    fireEvent.change(textarea, { target: { value: "한글" } });
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(spies.send).not.toHaveBeenCalled();
    expect(textarea.value).toBe("한글");
  });

  it("flips the turn control to stop while a turn runs with an empty draft", async () => {
    const { api, emit, acceptTurn } = makeApi();
    renderView(api);
    const { view } = sideComposer();

    await startTurn("first");
    acceptTurn(1);
    emit({ type: "text_delta", text: "working…", streamId: 1 });
    expect(view.getByTestId("composer-cancel-button")).toBeTruthy();

    emit({ type: "done", streamId: 1 });
    expect(view.getByTestId("composer-send-button")).toBeTruthy();
  });
});

describe("SideChatView — the conversation a side chat belongs to", () => {
  it("sends the tile's conversation with the turn, so the host can record the parentage", async () => {
    const { api, spies } = makeApi();
    renderView(api, { currentSessionId: "parent-session", hasApiKey: true });
    await startTurn("hello");
    // A rail side chat is bound to no pane, so its turn names no tab.
    expect(spies.send).toHaveBeenCalledWith("hello", expect.anything(), "parent-session", expect.any(String), undefined, undefined, {
      inputOrigin: "user-keyboard", userIntent: expect.objectContaining({ inputOrigin: "user-keyboard" }),
    });
  });

  it("tells the window its conversation list is stale once the turn settles", async () => {
    const { api } = makeApi();
    const onSessionsChanged = vi.fn();
    renderView(api, { currentSessionId: "parent-session", hasApiKey: true }, { onSessionsChanged });
    await startTurn("hello");
    await waitFor(() => expect(onSessionsChanged).toHaveBeenCalled());
  });

  it("loads the side chat a sidebar row asked for, once per request", async () => {
    const { api } = makeApi();
    const load = api.sideChat!.load as ReturnType<typeof vi.fn>;
    load.mockResolvedValue({ ok: true, sessionId: "side-9", messages: [] });
    const request = { chatGroupId: "main", sessionId: "side-9", nonce: 1 };
    const { rerender } = renderView(api, undefined, { openRequest: request });
    await waitFor(() => expect(load).toHaveBeenCalledWith("side-9"));

    // The same request re-delivered is the same ask, not a second one.
    await act(async () => {
      rerender(
        <TooltipProvider>
          <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
            <SideChatView api={api} openRequest={request} />
          </ApprovalSurfaceProvider>
        </TooltipProvider>,
      );
    });
    expect(load).toHaveBeenCalledTimes(1);

    // A fresh nonce is a fresh ask, even for the side chat already shown.
    await act(async () => {
      rerender(
        <TooltipProvider>
          <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
            <SideChatView api={api} openRequest={{ ...request, nonce: 2 }} />
          </ApprovalSurfaceProvider>
        </TooltipProvider>,
      );
    });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });
});

describe("SideChatView — the cards its own turn parks", () => {
  /** The side channel plus the window-wide question channel, as the panel subscribes to it. */
  function makeAskApi() {
    const base = makeApi();
    const askHandlers = new Set<(req: AskUserQuestionRequest) => void>();
    const load = base.api.sideChat!.load as ReturnType<typeof vi.fn>;
    load.mockResolvedValue({ ok: true, sessionId: "side-9", messages: [] });
    const api = {
      ...base.api,
      onAskUserQuestion: (h: (req: AskUserQuestionRequest) => void) => {
        askHandlers.add(h);
        return () => { askHandlers.delete(h); };
      },
      onAskUserQuestionTimeout: () => () => {},
      respondAskUserQuestion: vi.fn(async () => ({ ok: true })),
    } as unknown as AveApi;
    return {
      ...base,
      api,
      dispatchAsk: (req: AskUserQuestionRequest) => { for (const h of askHandlers) h(req); },
      ask: (req: AskUserQuestionRequest) => act(() => { for (const h of askHandlers) h(req); }),
    };
  }
  const question = (sessionId: string): AskUserQuestionRequest => ({
    id: `ask-${sessionId}`,
    sessionId,
    questions: [{ question: "어느 형식으로 정리할까요?", choices: ["표", "목록"] }],
    createdAt: Date.now(),
  });
  const openRequest = { chatGroupId: "main", sessionId: "side-9", nonce: 1 };

  function renderSurface(
    api: AveApi,
    surface = approvalSurfaceStub(),
    shown = true,
    view: Partial<React.ComponentProps<typeof SideChatView>> = {},
  ) {
    const publishSideChatSurface = vi.fn();
    const chatContext = { hasApiKey: true, publishSideChatSurface } as unknown as ChatContextValue;
    const tree = (visible: boolean, props = view) => (
      <TooltipProvider>
        <ApprovalSurfaceProvider value={surface}>
          <ChatContextProvider value={chatContext}>
            <SideChatView api={api} openRequest={openRequest} shown={visible} {...props} />
          </ChatContextProvider>
        </ApprovalSurfaceProvider>
      </TooltipProvider>
    );
    const result = render(tree(shown));
    return {
      ...result,
      publishSideChatSurface,
      show: (visible: boolean) => act(() => { result.rerender(tree(visible)); }),
      update: (props: Partial<React.ComponentProps<typeof SideChatView>>) =>
        act(() => { result.rerender(tree(shown, { ...view, ...props })); }),
    };
  }

  it("binds a default first pending send and captures its question and approval before React commits", async () => {
    const { api, dispatch, dispatchAsk, spies } = makeAskApi();
    const turn = deferred<{ ok: true; result: {} }>();
    spies.send.mockReturnValueOnce(turn.promise);
    let settled = false;
    void turn.promise.then(() => { settled = true; });
    const surface = approvalSurfaceStub();
    const onSessionIdChange = vi.fn((id: string) => {
      expect(surface.claims.ownerOf(id)).toBe(`side-chat:${id}`);
      // A question raised inside the panel notification is in the same stack as the prelude, before the hook's session state has
      // committed.
      dispatchAsk(question(id));
    });
    const { publishSideChatSurface } = renderSurface(api, surface, true, {
      openRequest: undefined,
      onSessionIdChange,
    });
    await startTurn("hello");
    expect(api.sideChat!.load).not.toHaveBeenCalled();
    expect(surface.claims.ownerOf("side-live")).toBeNull();
    expect(onSessionIdChange).not.toHaveBeenCalled();

    await act(async () => {
      dispatch({ type: "user_message", text: "hello", messageId: "row-live", sessionId: "side-live", streamId: 1, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      expect(onSessionIdChange).toHaveBeenCalledExactlyOnceWith("side-live");
      expect(surface.claims.ownerOf("side-live")).toBe("side-chat:side-live");
      expect(surface.claims.ownerOf("parent-session")).toBeNull();
      expect(surface.claims.ownerOf("child-session")).toBeNull();
      expect(publishSideChatSurface).not.toHaveBeenCalledWith(expect.objectContaining({ sessionId: "side-live" }));
      expect(screen.queryByTestId(TEST_IDS.questionOverlay)).toBeNull();
      expect(screen.queryByTestId(TEST_IDS.approvalDock)).toBeNull();
      surface.queue = [
        approvalRequest({ id: "own-approval", sessionId: "side-live" }) as unknown as ApprovalRequest,
        approvalRequest({ id: "parent-approval", sessionId: "parent-session" }) as unknown as ApprovalRequest,
        approvalRequest({ id: "child-approval", sessionId: "child-session" }) as unknown as ApprovalRequest,
      ];
      dispatchAsk(question("parent-session"));
      dispatchAsk(question("child-session"));
      const version = surface.claims.readVersion();
      dispatch({ type: "user_message", text: "hello", sessionId: "side-live", streamId: 1, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      expect(surface.claims.readVersion()).toBe(version);
      expect(onSessionIdChange).toHaveBeenCalledTimes(1);
    });
    const view = within(screen.getByTestId("side-chat-view"));
    expect(view.getAllByTestId(TEST_IDS.questionOverlay)).toHaveLength(1);
    expect(view.getAllByTestId(TEST_IDS.approvalDock)).toHaveLength(1);
    expect(view.getByTestId(TEST_IDS.approvalDock).getAttribute("data-approval-request-id")).toBe("own-approval");
    expect(view.queryByTestId(TEST_IDS.approvalDockQueueDepth)).toBeNull();
    expect(view.getAllByText("hello")).toHaveLength(1);
    const published = publishSideChatSurface.mock.calls.at(-1)![0] as { askQuestions: AskUserQuestionRequest[] };
    expect(published.askQuestions.map((request) => request.id)).toEqual(["ask-side-live"]);
    expect(settled).toBe(false);

    await act(async () => {
      dispatch({ type: "done", streamId: 1 });
      turn.resolve({ ok: true, result: {} });
      await turn.promise;
    });
    expect(settled).toBe(true);
    expect(onSessionIdChange).toHaveBeenCalledTimes(1);
  });

  it("releases the previous claim before reporting a new or loaded session and releases the last claim on unmount", async () => {
    const { api, spies } = makeAskApi();
    const surface = approvalSurfaceStub();
    const bindings: Array<{ sessionId: string; owner: string | null; previousOwner: string | null }> = [];
    let previousSessionId = "unbound";
    const onSessionIdChange = vi.fn((sessionId: string) => {
      bindings.push({
        sessionId,
        owner: surface.claims.ownerOf(sessionId),
        previousOwner: surface.claims.ownerOf(previousSessionId),
      });
      previousSessionId = sessionId;
    });
    const view = renderSurface(api, surface, true, { onSessionIdChange });
    await act(async () => {});
    expect(bindings).toEqual([{ sessionId: "side-9", owner: "side-chat:side-9", previousOwner: null }]);

    await act(async () => { fireEvent.click(screen.getByTestId("side-chat-new")); });
    expect(spies.new).toHaveBeenCalledTimes(1);
    expect(surface.claims.ownerOf("side-9")).toBeNull();
    expect(surface.claims.ownerOf("side-2")).toBe("side-chat:side-2");
    (api.sideChat!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, sessionId: "side-loaded", messages: [] });
    await view.update({ openRequest: { chatGroupId: "main", sessionId: "side-loaded", nonce: 2 } });
    await act(async () => {});
    expect(bindings).toEqual([
      { sessionId: "side-9", owner: "side-chat:side-9", previousOwner: null },
      { sessionId: "side-2", owner: "side-chat:side-2", previousOwner: null },
      { sessionId: "side-loaded", owner: "side-chat:side-loaded", previousOwner: null },
    ]);
    expect(surface.claims.ownerOf("side-2")).toBeNull();
    const calls = onSessionIdChange.mock.calls.length;
    view.unmount();
    expect(surface.claims.ownerOf("side-loaded")).toBeNull();
    expect(onSessionIdChange).toHaveBeenCalledTimes(calls);
    expect(onSessionIdChange).toHaveBeenLastCalledWith("side-loaded");
  });

  it.each(["new", "load"] as const)("keeps pending questions scoped to the current session after %s", async (transition) => {
    const { api, emit, ask, spies } = makeAskApi();
    const surface = approvalSurfaceStub();
    const view = renderSurface(api, surface, true, { openRequest: undefined });
    await startTurn();
    emit({ type: "user_message", sessionId: "side-live", streamId: 1, sendRequestId: spies.send.mock.calls.at(-1)![3] });
    ask(question("side-live"));
    emit({ type: "done", streamId: 1 });
    expect(screen.getAllByTestId(TEST_IDS.questionOverlay)).toHaveLength(1);

    const nextSessionId = transition === "new" ? "side-2" : "side-loaded";
    if (transition === "new") {
      await act(async () => { fireEvent.click(screen.getByTestId("side-chat-new")); });
    } else {
      (api.sideChat!.load as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, sessionId: nextSessionId, messages: [] });
      await view.update({ openRequest: { chatGroupId: "main", sessionId: nextSessionId, nonce: 1 } });
    }
    expect(surface.claims.ownerOf("side-live")).toBeNull();
    expect(surface.claims.ownerOf(nextSessionId)).toBe(`side-chat:${nextSessionId}`);
    expect(screen.queryByTestId(TEST_IDS.questionOverlay)).toBeNull();
    expect(view.publishSideChatSurface).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: nextSessionId, askQuestions: [],
    }));

    const nextQuestion = question(nextSessionId);
    ask(nextQuestion);
    expect(screen.getAllByTestId(TEST_IDS.questionOverlay)).toHaveLength(1);
    expect(view.publishSideChatSurface).toHaveBeenLastCalledWith(expect.objectContaining({
      askQuestions: [nextQuestion],
    }));
  });

  it.each(["new", "load"] as const)("does not reclaim ownership when a deferred %s response arrives after unmount", async (transition) => {
    const { api, emit, spies } = makeAskApi();
    const surface = approvalSurfaceStub();
    const onSessionIdChange = vi.fn();
    const view = renderSurface(api, surface, true, { openRequest: undefined, onSessionIdChange });
    await startTurn();
    emit({ type: "user_message", text: "hello", sessionId: "side-live", streamId: 1, sendRequestId: spies.send.mock.calls.at(-1)![3] });
    emit({ type: "done", streamId: 1 });
    expect(surface.claims.ownerOf("side-live")).toBe("side-chat:side-live");
    expect(onSessionIdChange).toHaveBeenCalledExactlyOnceWith("side-live");

    const response = deferred<{ ok: true; sessionId: string; messages: [] }>();
    if (transition === "new") {
      spies.new.mockReturnValueOnce(response.promise);
      await act(async () => { fireEvent.click(screen.getByTestId("side-chat-new")); });
      expect(spies.new).toHaveBeenCalledTimes(1);
    } else {
      (api.sideChat!.load as ReturnType<typeof vi.fn>).mockReturnValueOnce(response.promise);
      await view.update({ openRequest: { chatGroupId: "main", sessionId: "side-late", nonce: 1 } });
      expect(api.sideChat!.load).toHaveBeenCalledExactlyOnceWith("side-late");
    }
    view.unmount();
    expect(surface.claims.ownerOf("side-live")).toBeNull();
    const version = surface.claims.readVersion();

    await act(async () => {
      response.resolve({ ok: true, sessionId: "side-late", messages: [] });
      await response.promise;
    });
    expect(surface.claims.ownerOf("side-late")).toBeNull();
    expect(surface.claims.readVersion()).toBe(version);
    expect(onSessionIdChange).toHaveBeenCalledExactlyOnceWith("side-live");
    expect(view.publishSideChatSurface).toHaveBeenLastCalledWith(null);
  });

  it("draws a question its own session asked over its own composer, and tells the tile so", async () => {
    const { api, ask } = makeAskApi();
    const { publishSideChatSurface } = renderSurface(api);
    await waitFor(() => expect(publishSideChatSurface).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "side-9", shown: true }),
    ));

    ask(question("side-9"));
    const view = within(screen.getByTestId("side-chat-view"));
    expect(view.getByTestId(TEST_IDS.questionOverlay)).toBeTruthy();
    expect(view.getByTestId(TEST_IDS.questionOverlay).textContent).toContain("어느 형식으로 정리할까요?");
    const published = publishSideChatSurface.mock.calls.at(-1)![0] as { askQuestions: AskUserQuestionRequest[] };
    expect(published.askQuestions.map((each) => each.id)).toEqual(["ask-side-9"]);

    // A question for another session is somebody else's — a tile's, the window's — never drawn here.
    ask(question("elsewhere"));
    expect(view.getAllByTestId(TEST_IDS.questionOverlay)).toHaveLength(1);
  });

  it("keeps its claim and its cards while it is not shown — the card waits here for the user to come to it", async () => {
    const { api } = makeAskApi();
    const surface = approvalSurfaceStub();
    surface.queue = [approvalRequest({ id: "req-side", sessionId: "side-9" }) as unknown as ApprovalRequest];
    const { publishSideChatSurface, show } = renderSurface(api, surface);
    await waitFor(() => expect(surface.claims.ownerOf("side-9")).toBe("side-chat:side-9"));
    const view = () => within(screen.getByTestId("side-chat-view"));
    expect(view().getByTestId(TEST_IDS.approvalDock)).toBeTruthy();

    // Another tab took the panel: the panel's view is hidden, not unmounted.
    await show(false);
    expect(surface.claims.ownerOf("side-9")).toBe("side-chat:side-9");
    expect(view().getByTestId(TEST_IDS.approvalDock)).toBeTruthy();
    expect(publishSideChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "side-9", shown: false }),
    );

    await show(true);
    expect(publishSideChatSurface).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "side-9", shown: true }),
    );
  });

  it("stacks its approval over its question — the approval stays the topmost decision", async () => {
    const { api, ask } = makeAskApi();
    const surface = approvalSurfaceStub();
    surface.queue = [approvalRequest({ id: "req-side-stack", sessionId: "side-9" }) as unknown as ApprovalRequest];
    renderSurface(api, surface);
    await waitFor(() => expect(surface.claims.ownerOf("side-9")).toBe("side-chat:side-9"));
    ask(question("side-9"));
    const view = within(screen.getByTestId("side-chat-view"));
    const dock = view.getByTestId(TEST_IDS.approvalDock);
    const overlay = view.getByTestId(TEST_IDS.questionOverlay);
    // Same z-index for both, so the later one in the document paints on top.
    expect(overlay.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("withdraws its surface from the tile only when it unmounts", async () => {
    const { api } = makeAskApi();
    const { publishSideChatSurface, unmount } = renderSurface(api);
    await waitFor(() => expect(publishSideChatSurface).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "side-9" }),
    ));
    // Before the loop had a session there was nothing to publish; from the moment it has one, the surface stays published
    // until the view goes.
    publishSideChatSurface.mockClear();
    unmount();
    expect(publishSideChatSurface).toHaveBeenCalledTimes(1);
    expect(publishSideChatSurface).toHaveBeenLastCalledWith(null);
  });
});

describe("SideChatView — the session its agents belong to (#2345)", () => {
  it("names its session to the panel on load and on a new chat, and leaves the agents to the panel", async () => {
    const { api, spies } = makeApi();
    (api.sideChat!.load as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, sessionId: "side-9", messages: [] });
    const onSessionIdChange = vi.fn();
    const view = renderView(api, { hasApiKey: true }, {
      openRequest: { chatGroupId: "main", sessionId: "side-9", nonce: 1 },
      onSessionIdChange,
    });
    await waitFor(() => expect(onSessionIdChange).toHaveBeenLastCalledWith("side-9"));

    fireEvent.click(screen.getByTestId("side-chat-new"));
    await waitFor(() => expect(spies.new).toHaveBeenCalled());
    await waitFor(() => expect(onSessionIdChange).toHaveBeenLastCalledWith("side-2"));

    // Unmounting (the side-chat tab closed) says nothing: the loop and the agents it started live on in main, and the panel
    // keeps listening for them.
    const calls = onSessionIdChange.mock.calls.length;
    view.unmount();
    expect(onSessionIdChange).toHaveBeenCalledTimes(calls);
  });
});
