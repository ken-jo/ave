// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSideChat } from "../use-side-chat.js";
import type { ChatStreamEvent, ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { AveApi } from "../../types.js";
import { deferred } from "../../../../../test/renderer/helpers.js";

/**
 * A test double for the side-chat preload surface. Exposes an `emit` so the test
 * can push arbitrary stream frames (with arbitrary streamIds) to the subscriber,
 * plus spies for the invoke channels.
 */
function makeApi() {
  const handlers = new Set<(e: ChatStreamEvent) => void>();
  const abort = vi.fn(async () => ({ ok: true as const }));
  // Typed as the real invoke is — either shape — so a test can hand back the
  // host's refusal without casting past the contract.
  const send = vi.fn(
    async (_input: string, _attachments?: unknown[], _originSessionId?: string, _sendRequestId?: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => ({
      ok: true,
      result: {},
    }),
  );
  const newSession = vi.fn(async () => ({ ok: true as const, sessionId: "side-2" }));
  const load = vi.fn(async () => ({ ok: true as const, sessionId: "side-3", messages: [] }));
  const list = vi.fn(async () => ({ current: "side-1", sessions: [] }));
  const onStream = vi.fn((h: (e: ChatStreamEvent) => void) => {
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  });
  const api = {
    sideChat: {
      send,
      new: newSession,
      load,
      list,
      abort,
      onStream,
      onFallback: () => () => {},
    },
  } as unknown as AveApi;
  return {
    api,
    dispatch: (e: ChatStreamEvent) => { for (const handler of handlers) handler(e); },
    emit: (e: ChatStreamEvent) => act(() => { for (const handler of handlers) handler(e); }),
    spies: { abort, send, newSession, load, list, onStream },
  };
}

function lastAssistant(entries: ChatEntry[]): Extract<ChatEntry, { kind: "assistant" }> | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.kind === "assistant") return e;
  }
  return undefined;
}

describe("useSideChat session identity", () => {
  it.each(["idle", "pending"] as const)("binds the announced session only to its sending view when a peer is %s", async (peerState) => {
    const { api, dispatch, spies } = makeApi();
    const accepted = deferred<{ ok: true; result: unknown }>();
    const refused = deferred<{ ok: false; error: string }>();
    spies.send.mockReturnValueOnce(accepted.promise).mockReturnValueOnce(refused.promise);
    const onSenderSession = vi.fn();
    const onPeerSession = vi.fn();
    const sender = renderHook(() => useSideChat(api, { onSessionBound: onSenderSession }));
    const peer = renderHook(() => useSideChat(api, { onSessionBound: onPeerSession }));
    let senderTurn = Promise.resolve();
    let peerTurn = Promise.resolve();
    act(() => {
      senderTurn = sender.result.current.send("sender turn");
      if (peerState === "pending") peerTurn = peer.result.current.send("peer turn");
    });
    try {
      const prelude = {
        type: "user_message", sessionId: "side-accepted", streamId: 1,
        sendRequestId: spies.send.mock.calls[0]?.[3],
      };
      await act(async () => { dispatch(prelude); });
      expect(sender.result.current.sessionId).toBe("side-accepted");
      expect(peer.result.current.sessionId).toBeNull();
      expect(onSenderSession).toHaveBeenCalledExactlyOnceWith("side-accepted");
      expect(onPeerSession).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        dispatch({ type: "done", streamId: 1 });
        accepted.resolve({ ok: true, result: {} });
        refused.resolve({ ok: false, error: "streaming-active" });
        await Promise.all([senderTurn, peerTurn]);
      });
    }
  });

  it("records the first pending send's prelude before rendering without duplicating its user bubble", async () => {
    const { api, dispatch, spies } = makeApi();
    const turn = deferred<{ ok: true; result: unknown }>();
    spies.send.mockReturnValueOnce(turn.promise);
    const beforeCommit: Array<string | null> = [];
    const onSessionBound = vi.fn(() => {
      beforeCommit.push(result.current.sessionId);
    });
    const { result } = renderHook(() => useSideChat(api, { onSessionBound }));
    let settled = false;
    let pendingSend = Promise.resolve();
    act(() => {
      pendingSend = result.current.send("hello").then(() => { settled = true; });
    });
    expect(result.current.sessionId).toBeNull();
    expect(spies.newSession).not.toHaveBeenCalled();
    expect(spies.load).not.toHaveBeenCalled();
    expect(spies.list).not.toHaveBeenCalled();

    await act(async () => {
      dispatch({ type: "user_message", text: "hello", streamId: 7 });
      expect(onSessionBound).not.toHaveBeenCalled();
      dispatch({ type: "user_message", text: "hello", messageId: "row-1", sessionId: "side-live", streamId: 7, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      expect(onSessionBound).toHaveBeenCalledExactlyOnceWith("side-live");
      expect(beforeCommit).toEqual([null]);
      dispatch({ type: "user_message", text: "hello", messageId: "row-1", sessionId: "side-live", streamId: 7, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      expect(onSessionBound).toHaveBeenCalledTimes(1);
    });
    expect(result.current.sessionId).toBe("side-live");
    expect(result.current.entries.filter((entry) => entry.kind === "user")).toEqual([
      expect.objectContaining({ kind: "user", text: "hello" }),
    ]);
    expect(result.current.isStreaming).toBe(true);
    expect(settled).toBe(false);

    await act(async () => {
      dispatch({ type: "done", streamId: 7 });
      turn.resolve({ ok: true, result: {} });
      await pendingSend;
    });
    expect(settled).toBe(true);
    expect(onSessionBound).toHaveBeenCalledTimes(1);
  });

  it("keeps its recorded identity when a prelude omits or malforms the session id", async () => {
    const { api, emit, spies } = makeApi();
    const onSessionBound = vi.fn();
    const { result } = renderHook(() => useSideChat(api, { onSessionBound }));
    await act(async () => { await result.current.send("hello"); });
    const sendRequestId = spies.send.mock.calls.at(-1)![3];
    emit({ type: "user_message", text: "hello", sessionId: "side-live", streamId: 1, sendRequestId });
    expect(result.current.sessionId).toBe("side-live");
    onSessionBound.mockClear();

    for (const identity of [undefined, null, 17, {}, "", " \t\n"]) {
      emit({ type: "user_message", text: "hello", sessionId: identity, streamId: 1, sendRequestId } as unknown as ChatStreamEvent);
      expect(result.current.sessionId).toBe("side-live");
    }
    for (const correlation of [undefined, null, 42, {}, "", "foreign-request"]) {
      emit({ type: "user_message", sessionId: "side-foreign", streamId: 1, sendRequestId: correlation } as unknown as ChatStreamEvent);
      expect(result.current.sessionId).toBe("side-live");
    }
    emit({ type: "text_delta", text: "answer", sessionId: "side-other", streamId: 1 });
    expect(result.current.sessionId).toBe("side-live");
    expect(onSessionBound).not.toHaveBeenCalled();
    expect(result.current.entries.filter((entry) => entry.kind === "user")).toHaveLength(1);
  });

  it("drops superseded and aborted preludes before they can change session ownership", async () => {
    const { api, emit, spies } = makeApi();
    const onSessionBound = vi.fn();
    const { result } = renderHook(() => useSideChat(api, { onSessionBound }));
    await act(async () => { await result.current.send("one"); });
    const firstRequestId = spies.send.mock.calls.at(-1)![3];
    emit({ type: "user_message", sessionId: "side-first", streamId: 1, sendRequestId: firstRequestId });
    emit({ type: "user_message", sessionId: "side-foreign", streamId: 2, sendRequestId: firstRequestId });
    expect(result.current.sessionId).toBe("side-first");
    expect(onSessionBound).toHaveBeenCalledExactlyOnceWith("side-first");

    await act(async () => { await result.current.abort(); });
    emit({ type: "user_message", sessionId: "side-stale", streamId: 1, sendRequestId: firstRequestId });
    expect(result.current.sessionId).toBe("side-first");
    await act(async () => { await result.current.send("two"); });
    const secondRequestId = spies.send.mock.calls.at(-1)![3];
    expect(secondRequestId).not.toBe(firstRequestId);
    emit({ type: "user_message", sessionId: "side-stale", streamId: 1, sendRequestId: firstRequestId });
    emit({ type: "user_message", sessionId: "side-second", streamId: 2, sendRequestId: secondRequestId });
    emit({ type: "user_message", sessionId: "side-first", streamId: 1, sendRequestId: firstRequestId });
    expect(result.current.sessionId).toBe("side-second");
    expect(onSessionBound.mock.calls).toEqual([["side-first"], ["side-second"]]);
  });

  it("shares session binding across new, load and preludes without resubscribing for callback changes", async () => {
    const { api, emit, spies } = makeApi();
    const firstCallback = vi.fn();
    const nextCallback = vi.fn();
    const { result, rerender } = renderHook(
      ({ onSessionBound }) => useSideChat(api, { onSessionBound }),
      { initialProps: { onSessionBound: firstCallback } },
    );
    await act(async () => { await result.current.newSession(); });
    expect(firstCallback).toHaveBeenCalledExactlyOnceWith("side-2");
    await act(async () => { await result.current.loadSession("side-3"); });
    await act(async () => { await result.current.loadSession("side-3"); });
    expect(result.current.sessionId).toBe("side-3");
    expect(firstCallback.mock.calls).toEqual([["side-2"], ["side-3"], ["side-3"]]);
    const subscriptions = spies.onStream.mock.calls.length;

    rerender({ onSessionBound: nextCallback });
    expect(nextCallback).not.toHaveBeenCalled();
    expect(spies.onStream).toHaveBeenCalledTimes(subscriptions);
    await act(async () => { await result.current.send("hello"); });
    const sendRequestId = spies.send.mock.calls.at(-1)![3];
    emit({ type: "user_message", sessionId: "side-3", streamId: 8, sendRequestId });
    expect(nextCallback).toHaveBeenCalledExactlyOnceWith("side-3");
    emit({ type: "user_message", sessionId: "side-current", streamId: 8, sendRequestId });
    expect(result.current.sessionId).toBe("side-current");
    expect(nextCallback.mock.calls).toEqual([["side-3"], ["side-current"]]);
    expect(firstCallback).toHaveBeenCalledTimes(3);
    expect(spies.onStream).toHaveBeenCalledTimes(subscriptions);
  });
});

describe("useSideChat stale-frame guard", () => {
  it("adopts the first frame's streamId and applies its deltas", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    // First frame of the turn establishes the active streamId.
    emit({ type: "text_delta", text: "wor", streamId: 7 });
    emit({ type: "text_delta", text: "ld", streamId: 7 });

    expect(lastAssistant(result.current.entries)).toMatchObject({
      kind: "assistant",
      text: "world",
      streaming: true,
    });
  });

  it("keeps a max-token assistant round as work instead of a final answer", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("continue");
    });
    emit({ type: "text_delta", text: "truncated", streamId: 1 });
    emit({
      type: "assistant_round",
      text: "truncated",
      stopReason: "max_tokens",
      hasToolCalls: false,
      streamId: 1,
    });

    expect(lastAssistant(result.current.entries)).toMatchObject({
      kind: "assistant",
      phase: "work",
      streaming: false,
    });
  });

  it("drops frames from a superseded turn (different streamId)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    // Turn A adopts streamId 1.
    emit({ type: "text_delta", text: "A", streamId: 1 });
    // A late frame from a SUPERSEDED turn (streamId 2) must be dropped, not
    // appended to the live transcript.
    emit({ type: "text_delta", text: "STALE", streamId: 2 });
    emit({ type: "text_delta", text: "A", streamId: 1 });

    const last = lastAssistant(result.current.entries);
    expect(last).toMatchObject({ text: "AA" });
    expect(last?.text).not.toContain("STALE");
  });

  it("re-arms on the next send so a new turn adopts its own streamId", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    // Turn 1 (streamId 1), completes.
    await act(async () => {
      await result.current.send("one");
    });
    emit({ type: "text_delta", text: "first", streamId: 1 });
    emit({ type: "done", streamId: 1 });
    expect(result.current.isStreaming).toBe(false);

    // Turn 2 (streamId 2): a stale frame from turn 1 must NOT bleed in.
    await act(async () => {
      await result.current.send("two");
    });
    emit({ type: "text_delta", text: "STALE", streamId: 1 });
    emit({ type: "text_delta", text: "second", streamId: 2 });

    expect(lastAssistant(result.current.entries)?.text).toBe("second");
  });

  it("aborts the in-flight turn on unmount (tab switch teardown, no orphan)", async () => {
    const { api, emit, spies } = makeApi();
    const { result, unmount } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    emit({ type: "text_delta", text: "streaming…", streamId: 1 });
    expect(result.current.isStreaming).toBe(true);

    unmount();
    expect(spies.abort).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort on unmount when idle", async () => {
    const { api, spies } = makeApi();
    const { unmount } = renderHook(() => useSideChat(api));
    unmount();
    expect(spies.abort).not.toHaveBeenCalled();
  });
});

describe("useSideChat unified-transcript rendering (tool / thinking / permission)", () => {
  it("renders retry and fallback status frames, then replaces them with real reasoning", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover the answer");
    });
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "llm_status", streamId: 1, phase: "fallback", to: "backup" });

    const statusEntries = result.current.entries.filter(
      (entry): entry is Extract<ChatEntry, { kind: "assistant" }> =>
        entry.kind === "assistant" && entry.phase === "status",
    );
    expect(statusEntries).toHaveLength(1);
    expect(statusEntries[0]?.text).toContain("backup");

    emit({ type: "reasoning_delta", streamId: 1, text: "checking the new route" });

    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
    expect(result.current.entries).toContainEqual(expect.objectContaining({
      kind: "reasoning",
      text: "checking the new route",
      streaming: true,
    }));
  });

  it("drops a stale retry-status frame before it reaches the side transcript", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("first");
    });
    emit({ type: "text_delta", streamId: 1, text: "first answer" });
    emit({ type: "done", streamId: 1 });

    await act(async () => {
      await result.current.send("second");
    });
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "text_delta", streamId: 2, text: "second answer" });

    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
    expect(lastAssistant(result.current.entries)?.text).toBe("second answer");
  });

  it("removes a status-only placeholder when the side turn closes", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover without output");
    });
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "done", streamId: 1 });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
  });

  it("drops a late retry-status frame after the side turn has closed", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover then close");
    });
    emit({ type: "text_delta", streamId: 1, text: "completed answer" });
    emit({ type: "done", streamId: 1 });
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });

    expect(lastAssistant(result.current.entries)?.text).toBe("completed answer");
    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
  });

  it("keeps real partial text visibly interrupted after a retry status", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover then stop");
    });
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "text_delta", streamId: 1, text: "partial answer" });

    await act(async () => {
      await result.current.abort();
    });

    expect(lastAssistant(result.current.entries)).toMatchObject({
      text: "partial answer",
      interrupted: true,
    });
    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
  });

  it("renders a tool_start/tool_end pair as a tool_group entry (parity with main)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("run a tool");
    });
    emit({
      type: "tool_start",
      streamId: 1,
      name: "index_scan",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
    });
    emit({
      type: "tool_end",
      streamId: 1,
      name: "index_scan",
      groupId: "g1",
      toolUseId: "t1",
      result: "42 files",
    });

    const toolGroup = result.current.entries.find((e) => e.kind === "tool_group");
    expect(toolGroup).toBeDefined();
    expect(toolGroup).toMatchObject({ kind: "tool_group" });
  });

  it("renders reasoning_delta as a reasoning entry (thinking parity)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("think");
    });
    emit({ type: "reasoning_delta", text: "let me consider…", streamId: 1 });

    const reasoning = result.current.entries.find((e) => e.kind === "reasoning");
    expect(reasoning).toMatchObject({ kind: "reasoning", text: "let me consider…" });
  });

  it("upserts a permission_review status card (informational, not the modal)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("do something risky");
    });
    emit({
      type: "permission_review",
      streamId: 1,
      reviewStatus: "reviewing",
      name: "bash",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
    });

    const review = result.current.entries.find((e) => e.kind === "permission_review");
    expect(review).toMatchObject({ kind: "permission_review", status: "reviewing", toolName: "bash" });
  });

  it("keeps the permission_review verdict once its tool runs (parity with main)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("do something risky");
    });
    emit({
      type: "permission_review",
      streamId: 1,
      reviewStatus: "auto_approved",
      name: "bash",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
      verdictLevel: "low",
    });
    emit({ type: "tool_start", streamId: 1, name: "bash", groupId: "g1", toolUseId: "t1", displayOrder: 0 });
    emit({ type: "tool_end", streamId: 1, name: "bash", groupId: "g1", toolUseId: "t1", result: "ok" });
    emit({ type: "done", streamId: 1 });

    expect(result.current.entries.find((e) => e.kind === "permission_review")).toMatchObject({
      status: "auto_approved",
      toolUseId: "t1",
    });
  });

  it("appends a turn_summary entry and derives turnSummaryByTurnStart", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hi");
    });
    emit({ type: "text_delta", text: "answer", streamId: 1 });
    emit({
      type: "turn_summary",
      streamId: 1,
      turnDurationMs: 1200,
      toolCount: 1,
      cumulativeToolMs: 300,
      tokensIn: 100,
      freshInputTokens: 90,
      tokensOut: 40,
    });
    emit({ type: "done", streamId: 1 });

    const summaryEntry = result.current.entries.find((e) => e.kind === "turn_summary");
    expect(summaryEntry).toMatchObject({ kind: "turn_summary", toolCount: 1, tokensIn: 100 });
    // The turn starts at the user entry (index 0); the derived map keys by it.
    expect(result.current.turnSummaryByTurnStart.get(0)).toMatchObject({ toolCount: 1, turnDurationMs: 1200 });
  });

  it("renders a checkpoint divider on a side-chat compact_notice (not silently dropped)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("long conversation");
    });
    emit({
      type: "compact_notice",
      streamId: 1,
      removedMessages: 5,
      freedTokens: 2000,
      estimatedAfter: 800,
      trigger: "context-tokens",
    });

    const checkpoint = result.current.entries.find((e) => e.kind === "checkpoint");
    expect(checkpoint).toMatchObject({ kind: "checkpoint", removedMessages: 5 });
    const ctxUsage = result.current.entries.find((e) => e.kind === "context_usage");
    expect(ctxUsage).toMatchObject({ kind: "context_usage", tokensIn: 800 });
  });

  // A refused send starts no turn, so re-arming the guard for it is wrong: the
  // turn that IS running keeps emitting, and once its id is no longer above the
  // high-water mark those frames can never be adopted again — the answer would
  // freeze on screen while the host streamed on.
  it("keeps rendering the running turn when the host refuses the next send", async () => {
    const { api, emit, spies } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("first");
    });
    emit({ type: "text_delta", text: "hello", streamId: 1 });

    // The end-of-turn drain raced a turn that had not finished: the host still
    // has one in flight and refuses.
    spies.send.mockResolvedValueOnce({ ok: false, error: "streaming-active" });
    await act(async () => {
      await result.current.send("drained row", { inputOrigin: "queue-auto" });
    });

    emit({ type: "text_delta", text: " world", streamId: 1 });

    const streaming = result.current.entries.find(
      (e): e is Extract<ChatEntry, { kind: "assistant" }> =>
        e.kind === "assistant" && e.streaming === true,
    );
    expect(streaming?.text).toBe("hello world");
  });

  // The abort is awaited AFTER the transcript and the composer have already
  // committed the interrupt, so a transport failure that escaped would destroy
  // the text the user typed.
  it("reports a failed abort instead of throwing", async () => {
    const { api, spies } = makeApi();
    spies.abort.mockRejectedValueOnce(new Error("render frame disposed"));
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("first");
    });

    await act(async () => {
      await expect(result.current.abort()).resolves.toBeUndefined();
    });
    expect(lastAssistant(result.current.entries)).toMatchObject({
      text: "render frame disposed",
      systemNotice: "stream-error",
    });
  });
});
