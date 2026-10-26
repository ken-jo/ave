// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useSideChat } from "../use-side-chat.js";
import type { ChatStreamEvent, ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { AveApi } from "../../types.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import { sessionUuid } from "../../../../__tests__/support/session-uuid.js";

/** A test double for the side-chat preload surface. Exposes an `emit` so the test can push arbitrary stream frames (with
 * arbitrary streamIds) to the subscriber, plus spies for the invoke channels. */
function makeApi() {
  const handlers = new Set<(e: ChatStreamEvent) => void>();
  const abort = vi.fn<NonNullable<AveApi["sideChat"]>["abort"]>(async () => ({ ok: true }));
  // Typed as the real invoke is — either shape — so a test can hand back the host's refusal without casting past the
  // contract.
  const send = vi.fn(
    async (_input: string, _attachments?: unknown[], _originSessionId?: string, _sendRequestId?: string, _surface?: unknown, _sessionId?: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => ({
      ok: true,
      result: {},
    }),
  );
  const newSession = vi.fn<NonNullable<AveApi["sideChat"]>["new"]>(async () => ({ ok: true, sessionId: "side-2" }));
  const load = vi.fn<NonNullable<AveApi["sideChat"]>["load"]>(async () => ({ ok: true, sessionId: "side-3", messages: [] }));
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
    acceptTurn: (streamId: number) => act(() => {
      for (const handler of handlers) handler({
        type: "user_message", sessionId: "side-1", streamId, sendRequestId: send.mock.calls.at(-1)![3],
      });
    }),
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

const REFUSAL_RESPONSE_ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const;
const REFUSAL_INTENT_CASES = Object.freeze((["new", "load"] as const).flatMap((first) =>
  (["new", "load", "send"] as const).flatMap((second) =>
    (["new", "load", "send"] as const).flatMap((third) =>
      REFUSAL_RESPONSE_ORDERS.map((order) => ({ first, second, third, order })),
    ),
  ),
));

describe("useSideChat session identity", () => {
  it.each(REFUSAL_INTENT_CASES)("keeps the accepted $first across refused $second/$third in reply order $order", async ({ first, second, third, order }) => {
    const { api, spies } = makeApi();
    const initialSessionId = sessionUuid("sidechat-response-initial");
    const acceptedSessionId = sessionUuid("sidechat-response-accepted");
    spies.load.mockResolvedValueOnce({ ok: true, sessionId: initialSessionId, messages: [] });
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.loadSession(initialSessionId); });
    type Reply = { ok: true; sessionId: string; messages: [] } | { ok: false; error: string; messages: [] };
    const replies: Array<ReturnType<typeof deferred<Reply>>> = [];
    const invoke = () => {
      const reply = deferred<Reply>();
      replies.push(reply);
      return reply.promise;
    };
    spies.load.mockImplementation(invoke);
    spies.newSession.mockImplementation(async () => {
      const reply = await invoke();
      return reply.ok ? { ok: true, sessionId: reply.sessionId } : { ok: false, error: reply.error };
    });
    spies.send.mockImplementation(async () => {
      const reply = await invoke();
      return reply.ok ? { ok: true, result: {} } : { ok: false, error: reply.error };
    });
    const pending: Array<Promise<void>> = [];
    for (const intent of [first, second, third]) {
      act(() => {
        pending.push(intent === "new" ? result.current.newSession()
          : intent === "load" ? result.current.loadSession(acceptedSessionId)
          : result.current.send(`Draft ${pending.length}`));
      });
    }
    await waitFor(() => expect(replies).toHaveLength(3));
    let hostSessionId = initialSessionId;
    // The first transition holds the host lease while the other two requests are handled, so both receive refusal without
    // changing the host session.
    for (const index of order) {
      await act(async () => {
        if (index === 0) {
          hostSessionId = acceptedSessionId;
          replies[index]!.resolve({ ok: true, sessionId: hostSessionId, messages: [] });
        } else replies[index]!.resolve({ ok: false, error: "streaming-active", messages: [] });
        await pending[index];
      });
    }
    expect(result.current.sessionId).toBe(hostSessionId);
    expect(result.current.isStreaming).toBe(false);
    if (third === "send") {
      expect(result.current.entries).toContainEqual(expect.objectContaining({ kind: "user", text: "Draft 2" }));
    }
  });

  it.each(["refusal", "transport failure"] as const)("ignores an old send %s after restoring a session and accepting a fresh turn", async (outcome) => {
    const { api, spies, emit } = makeApi();
    const acceptedSessionId = sessionUuid("sidechat-restored-generation");
    const acceptedLoad = deferred<{ ok: true; sessionId: string; messages: [] }>();
    const refusedLoad = deferred<{ ok: false; error: string; messages: [] }>();
    const oldSend = deferred<{ ok: false; error: string }>();
    const freshSend = deferred<{ ok: true; result: unknown }>();
    spies.load.mockReturnValueOnce(acceptedLoad.promise).mockReturnValueOnce(refusedLoad.promise);
    spies.send.mockImplementationOnce(async () => {
      const reply = await oldSend.promise;
      if (outcome === "transport failure") throw new Error("Old transport failure");
      return reply;
    }).mockReturnValueOnce(freshSend.promise);
    const { result } = renderHook(() => useSideChat(api));
    let first = Promise.resolve();
    let second = Promise.resolve();
    let third = Promise.resolve();
    act(() => { first = result.current.loadSession(acceptedSessionId); });
    act(() => { second = result.current.send("Refused draft"); });
    act(() => { third = result.current.loadSession("side-busy"); });
    await act(async () => {
      refusedLoad.resolve({ ok: false, error: "streaming-active", messages: [] });
      await third;
      acceptedLoad.resolve({ ok: true, sessionId: acceptedSessionId, messages: [] });
      await first;
    });
    let fresh = Promise.resolve();
    act(() => { fresh = result.current.send("Fresh request"); });
    emit({ type: "user_message", streamId: 1, sessionId: acceptedSessionId, sendRequestId: spies.send.mock.calls.at(-1)![3] });
    emit({ type: "text_delta", streamId: 1, text: "Fresh answer" });
    const entriesBeforeReply = result.current.entries;
    try {
      await act(async () => {
        oldSend.resolve({ ok: false, error: "streaming-active" });
        await second;
      });
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.entries).toEqual(entriesBeforeReply);
      expect(lastAssistant(result.current.entries)).toMatchObject({ text: "Fresh answer", streaming: true });
    } finally {
      await act(async () => {
        emit({ type: "done", streamId: 1 });
        freshSend.resolve({ ok: true, result: {} });
        await fresh;
      });
    }
  });

  it("retains batched text when an interrupt arrives before render", async () => {
    const { api, dispatch, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    await act(async () => {
      dispatch({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
      dispatch({ type: "text_delta", streamId: 1, text: "Partial answer" });
      await result.current.abort();
    });
    expect(lastAssistant(result.current.entries)).toMatchObject({
      text: "Partial answer", interrupted: true, streaming: false,
    });
  });

  it("keeps batched round text separate from the following round", async () => {
    const { api, dispatch, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    act(() => {
      dispatch({ type: "text_delta", streamId: 1, text: "First " });
      dispatch({ type: "text_delta", streamId: 1, text: "round" });
      dispatch({ type: "assistant_round", streamId: 1, stopReason: "tool_use", hasToolCalls: true });
      dispatch({ type: "text_delta", streamId: 1, text: "Second round" });
    });
    const answers = result.current.entries.filter((entry) => entry.kind === "assistant");
    expect(answers).toMatchObject([
      { text: "First round", phase: "work", streaming: false },
      { text: "Second round", streaming: true },
    ]);
  });

  it.each(((["new", "load"] as const).flatMap((originalTransition) =>
    (["new", "load"] as const).flatMap((replacementTransition) =>
      (["before", "after"] as const).map((replyOrder) => ({ originalTransition, replacementTransition, replyOrder })),
    ),
  )))("keeps an accepted $originalTransition when its busy $replacementTransition replacement replies $replyOrder completion", async ({ originalTransition, replacementTransition, replyOrder }) => {
    const { api, spies } = makeApi();
    const original = deferred<{ ok: true; sessionId: string; messages: [] }>();
    const replacement = deferred<{ ok: false; error: string; messages: [] }>();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.loadSession("side-3"); });
    if (originalTransition === "new") spies.newSession.mockReturnValueOnce(original.promise.then(({ sessionId }) => ({ ok: true, sessionId })));
    else spies.load.mockReturnValueOnce(original.promise);
    if (replacementTransition === "new") spies.newSession.mockReturnValueOnce(replacement.promise.then(({ error }) => ({ ok: false, error })));
    else spies.load.mockReturnValueOnce(replacement.promise);
    let first = Promise.resolve();
    let second = Promise.resolve();
    act(() => { first = originalTransition === "new" ? result.current.newSession() : result.current.loadSession("side-next"); });
    act(() => { second = replacementTransition === "new" ? result.current.newSession() : result.current.loadSession("side-refused"); });
    const finishOriginal = async () => {
      original.resolve({ ok: true, sessionId: "side-next", messages: [] });
      await first;
    };
    const finishReplacement = async () => {
      replacement.resolve({ ok: false, error: "streaming-active", messages: [] });
      await second;
    };
    await act(async () => {
      if (replyOrder === "before") { await finishReplacement(); await finishOriginal(); }
      else { await finishOriginal(); await finishReplacement(); }
    });
    expect(result.current.sessionId).toBe("side-next");
    expect(lastAssistant(result.current.entries)).toMatchObject({
      text: "아직 응답을 생성하는 중입니다. 중지하거나 끝날 때까지 기다린 뒤 다시 보내 주세요.",
      terminalError: true,
    });
    expect(result.current.entries.filter((entry) => entry.kind === "assistant" && entry.terminalError)).toHaveLength(1);
  });

  it("discards retained history when an accepted send binds a different host session", async () => {
    const { api, spies, emit } = makeApi();
    spies.load.mockResolvedValueOnce({
      ok: true, sessionId: "side-old", messages: [{ index: 0, role: "user", content: "Old session prompt" }],
    });
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.loadSession("side-old"); });
    expect(result.current.entries.some((entry) => entry.kind === "user" && entry.text === "Old session prompt")).toBe(true);
    await act(async () => { await result.current.send("New session prompt"); });
    emit({ type: "user_message", streamId: 1, sessionId: "side-new", sendRequestId: spies.send.mock.calls.at(-1)![3] });
    emit({ type: "text_delta", streamId: 1, text: "New session answer" });
    expect(result.current.entries.some((entry) => entry.kind === "user" && entry.text === "Old session prompt")).toBe(false);
    expect(result.current.entries.filter((entry) => entry.kind === "user")).toMatchObject([{ text: "New session prompt" }]);
    expect(result.current.sessionId).toBe("side-new");
  });

  it.each(["before", "after"] as const)("preserves the accepted session through refused replacements resolved %s the latest refusal", async (earlierOrder) => {
    const { api, spies } = makeApi();
    const accepted = deferred<{ ok: true; sessionId: string; messages: [] }>();
    const busy = deferred<{ ok: false; error: string; messages: [] }>();
    const missing = deferred<{ ok: false; error: string; messages: [] }>();
    spies.load.mockReturnValueOnce(accepted.promise).mockReturnValueOnce(busy.promise).mockReturnValueOnce(missing.promise);
    const { result } = renderHook(() => useSideChat(api));
    let first = Promise.resolve();
    let second = Promise.resolve();
    let third = Promise.resolve();
    act(() => { first = result.current.loadSession("side-next"); });
    act(() => { second = result.current.loadSession("side-busy"); });
    act(() => { third = result.current.loadSession("side-missing"); });
    const finishEarlier = async () => { busy.resolve({ ok: false, error: "streaming-active", messages: [] }); await second; };
    const finishLatest = async () => { missing.resolve({ ok: false, error: "session-not-found", messages: [] }); await third; };
    await act(async () => {
      if (earlierOrder === "before") { await finishEarlier(); await finishLatest(); }
      else { await finishLatest(); await finishEarlier(); }
      accepted.resolve({ ok: true, sessionId: "side-next", messages: [] });
      await first;
    });
    expect(result.current.sessionId).toBe("side-next");
    expect(lastAssistant(result.current.entries)?.text).toBe("세션을 찾을 수 없습니다.");
  });

  it.each(["before", "after"] as const)("retains a refused send and its accepted load when the refusal replies %s the load", async (replyOrder) => {
    const { api, spies } = makeApi();
    const loaded = deferred<{ ok: true; sessionId: string; messages: [] }>();
    const refused = deferred<{ ok: false; error: string }>();
    spies.load.mockReturnValueOnce(loaded.promise);
    spies.send.mockReturnValueOnce(refused.promise);
    const { result } = renderHook(() => useSideChat(api));
    let load = Promise.resolve();
    let send = Promise.resolve();
    act(() => { load = result.current.loadSession("side-next"); });
    act(() => { send = result.current.send("Recoverable draft"); });
    const finishLoad = async () => { loaded.resolve({ ok: true, sessionId: "side-next", messages: [] }); await load; };
    const finishSend = async () => { refused.resolve({ ok: false, error: "streaming-active" }); await send; };
    await act(async () => {
      if (replyOrder === "before") { await finishSend(); await finishLoad(); }
      else { await finishLoad(); await finishSend(); }
    });
    expect(result.current.sessionId).toBe("side-next");
    expect(result.current.entries.filter((entry) => entry.kind === "user")).toMatchObject([{ text: "Recoverable draft" }]);
    expect(lastAssistant(result.current.entries)).toMatchObject({
      terminalError: true,
      text: "아직 응답을 생성하는 중입니다. 중지하거나 끝날 때까지 기다린 뒤 다시 보내 주세요.",
    });
  });

  it.each(["before", "after"] as const)("recovers a load through an intervening send refused %s the replacement load", async (replyOrder) => {
    const { api, spies } = makeApi();
    const accepted = deferred<{ ok: true; sessionId: string; messages: [] }>();
    const refusedSend = deferred<{ ok: false; error: string }>();
    const refusedLoad = deferred<{ ok: false; error: string; messages: [] }>();
    spies.load.mockReturnValueOnce(accepted.promise).mockReturnValueOnce(refusedLoad.promise);
    spies.send.mockReturnValueOnce(refusedSend.promise);
    const { result } = renderHook(() => useSideChat(api));
    let first = Promise.resolve();
    let second = Promise.resolve();
    let third = Promise.resolve();
    act(() => { first = result.current.loadSession("side-next"); });
    act(() => { second = result.current.send("Intervening draft"); });
    act(() => { third = result.current.loadSession("side-refused"); });
    const finishSend = async () => { refusedSend.resolve({ ok: false, error: "streaming-active" }); await second; };
    const finishLoad = async () => { refusedLoad.resolve({ ok: false, error: "streaming-active", messages: [] }); await third; };
    await act(async () => {
      if (replyOrder === "before") { await finishSend(); await finishLoad(); }
      else { await finishLoad(); await finishSend(); }
      accepted.resolve({ ok: true, sessionId: "side-next", messages: [] });
      await first;
    });
    expect(result.current.sessionId).toBe("side-next");
    expect(lastAssistant(result.current.entries)?.terminalError).toBe(true);
  });

  it("retains every current refusal draft across delayed load hydration", async () => {
    const { api, spies } = makeApi();
    const accepted = deferred<{ ok: true; sessionId: string; messages: [] }>();
    spies.load.mockReturnValueOnce(accepted.promise);
    const { result } = renderHook(() => useSideChat(api));
    let loading = Promise.resolve();
    act(() => { loading = result.current.loadSession("side-next"); });
    for (const draft of ["First draft", "Second draft"]) {
      spies.send.mockResolvedValueOnce({ ok: false, error: "streaming-active" });
      await act(async () => { await result.current.send(draft); });
    }
    await act(async () => { accepted.resolve({ ok: true, sessionId: "side-next", messages: [] }); await loading; });
    expect(result.current.entries.filter((entry) => entry.kind === "user")).toMatchObject([
      { text: "First draft" }, { text: "Second draft" },
    ]);
    expect(result.current.entries.filter((entry) => entry.kind === "assistant" && entry.terminalError)).toHaveLength(2);
  });

  it("does not dispatch an interrupted draft after its view unmounts", async () => {
    const { api, spies, acceptTurn } = makeApi();
    const firstReply = deferred<{ ok: true; result: unknown }>();
    const abortReply = deferred<{ ok: true }>();
    spies.send.mockReturnValueOnce(firstReply.promise);
    spies.abort.mockReturnValueOnce(abortReply.promise);
    const { result, unmount } = renderHook(() => useSideChat(api));
    let first = Promise.resolve();
    let replacement = Promise.resolve();
    act(() => { first = result.current.send("First request"); });
    acceptTurn(1);
    act(() => { replacement = result.current.send("Interrupted draft"); });
    expect(spies.abort).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      firstReply.resolve({ ok: true, result: {} });
      abortReply.resolve({ ok: true });
      await Promise.all([first, replacement]);
    });
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a queued replacement after its view unmounts", async () => {
    const { api, spies, acceptTurn } = makeApi();
    const reply = deferred<{ ok: true; result: unknown }>();
    spies.send.mockReturnValueOnce(reply.promise);
    const { result, unmount } = renderHook(() => useSideChat(api));
    let first = Promise.resolve();
    let queued = Promise.resolve();
    act(() => { first = result.current.send("First request"); });
    acceptTurn(1);
    act(() => { queued = result.current.send("Queued draft", { inputOrigin: "queue-auto" }); });
    unmount();
    await act(async () => {
      reply.resolve({ ok: true, result: {} });
      await Promise.all([first, queued]);
    });
    expect(spies.send).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch queued work first invoked after view disposal", async () => {
    const { api, spies } = makeApi();
    const { result, unmount } = renderHook(() => useSideChat(api));
    const send = result.current.send;
    unmount();
    await act(async () => { await send("Queued draft", { inputOrigin: "queue-auto" }); });
    expect(spies.send).not.toHaveBeenCalled();
  });

  it("rejects an owned stream verdict after view disposal", async () => {
    const { api, acceptTurn } = makeApi();
    const { result, unmount } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    const verdict = result.current.isCurrentTurnEvent;
    unmount();
    expect(verdict({ type: "done", streamId: 1 })).toBe(false);
  });

  it.each(["new", "load"] as const)("does not publish a late %s binding after view disposal", async (transition) => {
    const { api, spies } = makeApi();
    const reply = deferred<{ ok: true; sessionId: string; messages: [] }>();
    if (transition === "new") spies.newSession.mockReturnValueOnce(reply.promise);
    else spies.load.mockReturnValueOnce(reply.promise);
    const onSessionBound = vi.fn();
    const { result, unmount } = renderHook(() => useSideChat(api, { onSessionBound }));
    let pending = Promise.resolve();
    act(() => { pending = transition === "new" ? result.current.newSession() : result.current.loadSession("side-later"); });
    unmount();
    await act(async () => {
      reply.resolve({ ok: true, sessionId: "side-later", messages: [] });
      await pending;
    });
    expect(onSessionBound).not.toHaveBeenCalled();
  });

  it.each(["done", "error"] as const)("keeps a %s transcript unchanged after a late invoke rejection", async (terminal) => {
    const { api, spies, acceptTurn, emit } = makeApi();
    const reply = deferred<void>();
    spies.send.mockImplementationOnce(async () => {
      await reply.promise;
      throw new Error("Late transport failure");
    });
    const { result } = renderHook(() => useSideChat(api));
    let pending = Promise.resolve();
    act(() => { pending = result.current.send("Own request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Confirmed answer", streamId: 1 });
    emit({ type: terminal, error: "Confirmed failure", streamId: 1 });
    const closed = result.current.entries;
    await act(async () => { reply.resolve(undefined); await pending; });
    expect(result.current.entries).toEqual(closed);
    expect(result.current.isStreaming).toBe(false);
  });

  it("settles retained text and reports a refused session load", async () => {
    const { api, spies, acceptTurn, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Partial answer", streamId: 1 });
    spies.load.mockResolvedValueOnce({ ok: false, error: "session-not-found", messages: [] });
    await act(async () => { await result.current.loadSession("side-missing"); });
    expect(result.current.entries).toContainEqual(expect.objectContaining({
      kind: "assistant", text: "Partial answer", streaming: false, interrupted: true,
    }));
    expect(lastAssistant(result.current.entries)).toMatchObject({
      text: "세션을 찾을 수 없습니다.", terminalError: true, streaming: false,
    });
    expect(result.current.sessionId).toBe("side-1");
    expect(result.current.isStreaming).toBe(false);
  });

  it.each(["new", "load"] as const)("reports a refused %s session change", async (transition) => {
    const { api, spies } = makeApi();
    if (transition === "new") spies.newSession.mockResolvedValueOnce({ ok: false, error: "session-not-found" });
    else spies.load.mockResolvedValueOnce({ ok: false, error: "session-not-found", messages: [] });
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => {
      if (transition === "new") await result.current.newSession();
      else await result.current.loadSession("side-missing");
    });
    expect(lastAssistant(result.current.entries)).toMatchObject({ text: "세션을 찾을 수 없습니다.", terminalError: true });
  });

  it("preserves a completed answer when a later session load is refused", async () => {
    const { api, spies, acceptTurn, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Completed answer", streamId: 1 });
    emit({ type: "done", streamId: 1 });
    spies.load.mockResolvedValueOnce({ ok: false, error: "session-not-found", messages: [] });
    await act(async () => { await result.current.loadSession("side-missing"); });
    expect(result.current.entries.find((entry) => entry.kind === "assistant" && entry.text === "Completed answer"))
      .toMatchObject({ text: "Completed answer", streaming: false });
    expect(result.current.entries.find((entry) => entry.kind === "assistant" && entry.text === "Completed answer"))
      .not.toHaveProperty("interrupted");
    expect(lastAssistant(result.current.entries)?.terminalError).toBe(true);
  });

  it("localizes a refused interruption after settling retained text", async () => {
    const { api, spies, acceptTurn, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Partial answer", streamId: 1 });
    spies.abort.mockResolvedValueOnce({ ok: false, error: "invalid-send-request-id" });
    await act(async () => { await result.current.abort(); });
    expect(result.current.entries).toContainEqual(expect.objectContaining({
      kind: "assistant", text: "Partial answer", interrupted: true, streaming: false,
    }));
    expect(lastAssistant(result.current.entries)?.text).toBe("잘못된 입력입니다.");
  });

  it.each(["new", "load"] as const)("reports a %s session transport rejection without propagating it", async (transition) => {
    const { api, spies } = makeApi();
    if (transition === "new") spies.newSession.mockRejectedValueOnce(new Error("Session transfer failed"));
    else spies.load.mockRejectedValueOnce(new Error("Session transfer failed"));
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => {
      const pending = transition === "new" ? result.current.newSession() : result.current.loadSession("side-missing");
      await expect(pending).resolves.toBeUndefined();
    });
    expect(lastAssistant(result.current.entries)).toMatchObject({ text: "Session transfer failed", terminalError: true });
  });

  it.each(["new", "load"] as const)("drops a late %s session rejection after a newer send", async (transition) => {
    const { api, spies, acceptTurn, emit } = makeApi();
    const reply = deferred<void>();
    const rejectLater = async () => { await reply.promise; throw new Error("Earlier session transfer failed"); };
    if (transition === "new") spies.newSession.mockImplementationOnce(rejectLater);
    else spies.load.mockImplementationOnce(rejectLater);
    const { result } = renderHook(() => useSideChat(api));
    let earlier = Promise.resolve();
    act(() => { earlier = transition === "new" ? result.current.newSession() : result.current.loadSession("side-earlier"); });
    await act(async () => { await result.current.send("Current request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Current answer", streamId: 1 });
    const current = result.current.entries;
    await act(async () => { reply.resolve(undefined); await expect(earlier).resolves.toBeUndefined(); });
    expect(result.current.entries).toEqual(current);
    expect(result.current.isStreaming).toBe(true);
  });

  it.each((["new", "load"] as const).flatMap((replyMode) =>
    (["send", "new", "load"] as const).map((transition) => ({ replyMode, transition })),
  ))("ignores an earlier $replyMode reply after a newer $transition binds its session", async ({ replyMode, transition }) => {
    const { api, emit, spies } = makeApi();
    const reply = deferred<{ ok: true; sessionId: string; messages: [] }>();
    if (replyMode === "new") spies.newSession.mockReturnValueOnce(reply.promise);
    else spies.load.mockReturnValueOnce(reply.promise);
    const onSessionBound = vi.fn();
    const { result } = renderHook(() => useSideChat(api, { onSessionBound }));
    let earlier = Promise.resolve();
    act(() => { earlier = replyMode === "new" ? result.current.newSession() : result.current.loadSession("side-earlier"); });
    await act(async () => {
      if (transition === "send") await result.current.send("Current request");
      else if (transition === "new") await result.current.newSession();
      else await result.current.loadSession("side-3");
    });
    if (transition === "send") {
      emit({ type: "user_message", sessionId: "side-current", streamId: 1, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      emit({ type: "text_delta", text: "Current answer", streamId: 1 });
    }
    const currentEntries = result.current.entries;
    const currentSession = result.current.sessionId;
    onSessionBound.mockClear();
    await act(async () => {
      reply.resolve({ ok: true, sessionId: "side-earlier", messages: [] });
      await earlier;
    });
    expect(result.current.sessionId).toBe(currentSession);
    expect(result.current.entries).toEqual(currentEntries);
    expect(result.current.isStreaming).toBe(transition === "send");
    expect(onSessionBound).not.toHaveBeenCalled();
  });

  it.each(["new", "load"] as const)("ignores an earlier abort rejection after %s changes the session", async (transition) => {
    const { api, spies, acceptTurn } = makeApi();
    const reply = deferred<void>();
    spies.abort.mockImplementationOnce(async () => {
      await reply.promise;
      throw new Error("Earlier abort failed");
    });
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("First request"); });
    acceptTurn(1);
    let earlier = Promise.resolve();
    act(() => { earlier = result.current.abort(); });
    await act(async () => {
      if (transition === "new") await result.current.newSession();
      else await result.current.loadSession("side-3");
    });
    const currentEntries = result.current.entries;
    await act(async () => {
      reply.resolve(undefined);
      await earlier;
    });
    expect(result.current.entries).toEqual(currentEntries);
    expect(result.current.sessionId).toBe(transition === "new" ? "side-2" : "side-3");
  });

  it("rejects a peer's remaining frames when the view mounted after its prelude", async () => {
    const { api, dispatch, spies } = makeApi();
    dispatch({ type: "user_message", sessionId: "side-peer", streamId: 1, sendRequestId: "peer-request" });
    const refused = deferred<{ ok: false; error: string }>();
    spies.send.mockReturnValueOnce(refused.promise);
    const { result } = renderHook(() => useSideChat(api));
    let pending = Promise.resolve();
    act(() => { pending = result.current.send("Local request"); });
    const currentEntries = result.current.entries;
    try {
      await act(async () => {
        dispatch({ type: "text_delta", text: "Peer answer", streamId: 1 });
        dispatch({ type: "done", streamId: 1 });
      });
      expect(result.current.entries).toEqual(currentEntries);
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.sessionId).toBeNull();
      expect(result.current.isCurrentTurnEvent({ type: "done", streamId: 1 })).toBe(false);
    } finally {
      await act(async () => {
        refused.resolve({ ok: false, error: "streaming-active" });
        await pending;
      });
    }
  });

  it.each(["refusal", "rejection"] as const)("does not revive an unaccepted send when its %s overlaps a queued send", async (replyMode) => {
    const { api, spies } = makeApi();
    const firstReply = deferred<void>();
    const queuedReply = deferred<{ ok: false; error: string }>();
    spies.send.mockImplementationOnce(async () => {
      await firstReply.promise;
      if (replyMode === "rejection") throw new Error("First transport failed");
      return { ok: false, error: "streaming-active" };
    }).mockReturnValueOnce(queuedReply.promise);
    const { result } = renderHook(() => useSideChat(api));
    let firstSend = Promise.resolve();
    let queuedSend = Promise.resolve();
    act(() => {
      firstSend = result.current.send("First request");
      queuedSend = result.current.send("Queued request", { inputOrigin: "queue-auto" });
    });
    try {
      await act(async () => {
        firstReply.resolve(undefined);
        await firstSend;
        queuedReply.resolve({ ok: false, error: "streaming-active" });
        await queuedSend;
      });
      expect(result.current.isStreaming).toBe(false);
      expect(spies.send).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        firstReply.resolve(undefined);
        queuedReply.resolve({ ok: false, error: "streaming-active" });
        await Promise.all([firstSend, queuedSend]);
      });
    }
  });

  it.each(["new", "load"] as const)("does not submit an interrupted draft after %s finishes during abort", async (transition) => {
    const { api, emit, spies } = makeApi();
    const abortReady = deferred<{ ok: true }>();
    spies.abort.mockReturnValueOnce(abortReady.promise);
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("First request"); });
    emit({ type: "user_message", sessionId: "side-first", streamId: 1, sendRequestId: spies.send.mock.calls[0]![3] });
    let interruptedSend = Promise.resolve();
    act(() => { interruptedSend = result.current.send("Interrupted draft"); });
    expect(spies.abort).toHaveBeenCalledOnce();
    try {
      await act(async () => {
        if (transition === "new") await result.current.newSession();
        else await result.current.loadSession("side-3");
      });
      const currentEntries = result.current.entries;
      await act(async () => {
        abortReady.resolve({ ok: true });
        await interruptedSend;
      });
      expect(spies.send).toHaveBeenCalledTimes(1);
      expect(result.current.entries).toEqual(currentEntries);
      expect(result.current.sessionId).toBe(transition === "new" ? "side-2" : "side-3");
    } finally {
      await act(async () => {
        abortReady.resolve({ ok: true });
        await interruptedSend;
      });
    }
  });

  it.each((["refusal", "rejection"] as const).flatMap((replyMode) =>
    (["send", "new", "load"] as const).map((transition) => ({ replyMode, transition })),
  ))("keeps a $transition transition intact when an earlier $replyMode arrives after its error frame", async ({ replyMode, transition }) => {
    const { api, dispatch, spies } = makeApi();
    const firstReply = deferred<void>();
    const nextReply = deferred<{ ok: true; result: unknown }>();
    spies.send.mockImplementationOnce(async () => {
      await firstReply.promise;
      if (replyMode === "rejection") throw new Error("Earlier transport failed");
      return { ok: false, error: "streaming-active" };
    }).mockReturnValueOnce(nextReply.promise);
    const { result } = renderHook(() => useSideChat(api));
    let firstSend = Promise.resolve();
    let nextSend = Promise.resolve();
    act(() => { firstSend = result.current.send("First request"); });
    try {
      await act(async () => {
        dispatch({ type: "user_message", sessionId: "side-current", streamId: 1, sendRequestId: spies.send.mock.calls[0]![3] });
        dispatch({ type: "error", error: "First turn failed", streamId: 1 });
      });
      expect(result.current.isStreaming).toBe(false);
      if (transition === "send") {
        act(() => { nextSend = result.current.send("Next request"); });
        await act(async () => {
          dispatch({ type: "user_message", sessionId: "side-current", streamId: 2, sendRequestId: spies.send.mock.calls[1]![3] });
          dispatch({ type: "text_delta", text: "New", streamId: 2 });
        });
      } else {
        await act(async () => {
          if (transition === "new") await result.current.newSession();
          else await result.current.loadSession("side-3");
        });
        expect(result.current.sessionId).toBe(transition === "new" ? "side-2" : "side-3");
      }
      const currentEntries = result.current.entries;
      await act(async () => {
        firstReply.resolve(undefined);
        await firstSend;
      });
      expect(result.current.entries).toEqual(currentEntries);
      expect(result.current.isStreaming).toBe(transition === "send");
      if (transition === "send") {
        await act(async () => { dispatch({ type: "text_delta", text: " answer", streamId: 2 }); });
        expect(lastAssistant(result.current.entries)).toMatchObject({ text: "New answer", streaming: true });
      }
    } finally {
      await act(async () => {
        firstReply.resolve(undefined);
        dispatch({ type: "done", streamId: 2 });
        nextReply.resolve({ ok: true, result: {} });
        await Promise.all([firstSend, nextSend]);
      });
    }
  });

  it.each(["idle", "pending"] as const)("keeps a retained transcript separate when a peer send is %s", async (peerState) => {
    const { api, dispatch, spies } = makeApi();
    spies.load.mockResolvedValueOnce({
      ok: true, sessionId: "side-retained", messages: [
        { index: 0, role: "assistant", content: "Retained answer" },
      ],
    });
    const accepted = deferred<{ ok: true; result: unknown }>();
    const refused = deferred<{ ok: false; error: string }>();
    spies.send.mockReturnValueOnce(accepted.promise).mockReturnValueOnce(refused.promise);
    const sender = renderHook(() => useSideChat(api));
    const peer = renderHook(() => useSideChat(api));
    await act(async () => { await peer.result.current.loadSession("side-retained"); });
    let senderTurn = Promise.resolve();
    let peerTurn = Promise.resolve();
    act(() => {
      senderTurn = sender.result.current.send("Sender request");
      if (peerState === "pending") peerTurn = peer.result.current.send("Peer request");
    });
    const retainedEntries = peer.result.current.entries;
    try {
      await act(async () => {
        dispatch({ type: "user_message", sessionId: "side-current", streamId: 1, sendRequestId: spies.send.mock.calls[0]![3] });
        dispatch({ type: "text_delta", text: "Foreign answer", streamId: 1 });
        dispatch({ type: "done", streamId: 1 });
      });
      expect(sender.result.current.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "Foreign answer" }),
      ]));
      expect(peer.result.current.entries).toEqual(retainedEntries);
      expect(peer.result.current.sessionId).toBe("side-retained");
      expect(peer.result.current.isStreaming).toBe(peerState === "pending");
    } finally {
      await act(async () => {
        accepted.resolve({ ok: true, result: {} });
        refused.resolve({ ok: false, error: "streaming-active" });
        await Promise.all([senderTurn, peerTurn]);
      });
    }
  });

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
      dispatch({ type: "user_message", text: "hello", messageId: "row-1", sessionId: "side-live", streamId: 8, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      expect(onSessionBound).toHaveBeenCalledExactlyOnceWith("side-live");
      expect(beforeCommit).toEqual([null]);
      dispatch({ type: "user_message", text: "hello", messageId: "row-1", sessionId: "side-live", streamId: 8, sendRequestId: spies.send.mock.calls.at(-1)![3] });
      expect(onSessionBound).toHaveBeenCalledTimes(1);
    });
    expect(result.current.sessionId).toBe("side-live");
    expect(result.current.entries.filter((entry) => entry.kind === "user")).toEqual([
      expect.objectContaining({ kind: "user", text: "hello" }),
    ]);
    expect(result.current.isStreaming).toBe(true);
    expect(settled).toBe(false);

    await act(async () => {
      dispatch({ type: "done", streamId: 8 });
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
    const currentEntries = result.current.entries;
    emit({ type: "text_delta", text: "answer", sessionId: "side-other", streamId: 1 });
    expect(result.current.entries).toEqual(currentEntries);
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
    expect(result.current.sessionId).toBe("side-3");
    expect(nextCallback.mock.calls).toEqual([["side-3"]]);
    expect(firstCallback).toHaveBeenCalledTimes(3);
    expect(spies.onStream).toHaveBeenCalledTimes(subscriptions);
  });
});

describe("useSideChat stale-frame guard", () => {
  it.each(["abort", "unmount"] as const)("scopes %s to the local request while acceptance is pending", async (transition) => {
    const { api, spies } = makeApi();
    const reply = deferred<{ ok: false; error: string }>();
    spies.send.mockReturnValueOnce(reply.promise);
    const { result, unmount } = renderHook(() => useSideChat(api));
    let pending = Promise.resolve();
    act(() => { pending = result.current.send("Local request"); });
    try {
      if (transition === "abort") await act(async () => { await result.current.abort(); });
      else unmount();
      expect(spies.abort).toHaveBeenCalledExactlyOnceWith(spies.send.mock.calls[0]![3]);
    } finally {
      await act(async () => {
        reply.resolve({ ok: false, error: "streaming-active" });
        await pending;
      });
    }
  });

  it.each(["done", "error"] as const)("keeps the transcript closed after %s while sharing the terminal verdict", async (terminal) => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Own request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Own answer", streamId: 1 });
    emit({ type: terminal, error: "Turn failed", streamId: 1 });
    const closedEntries = result.current.entries;
    emit({ type: "text_delta", text: "Late answer", streamId: 1 });
    emit({ type: "reasoning_delta", text: "Late thought", streamId: 1 });
    emit({ type: "assistant_round", text: "Late final", stopReason: "end_turn", streamId: 1 });
    emit({ type: "tool_start", name: "late_tool", groupId: "late-group", toolUseId: "late-tool", streamId: 1 });
    expect(result.current.entries).toEqual(closedEntries);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isCurrentTurnEvent({ type: terminal, streamId: 1 })).toBe(true);
  });

  it("adopts the matching prelude's streamId and applies its deltas", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    acceptTurn(7);
    // The matching user prelude establishes the active streamId.
    emit({ type: "text_delta", text: "wor", streamId: 7 });
    emit({ type: "text_delta", text: "ld", streamId: 7 });

    expect(lastAssistant(result.current.entries)).toMatchObject({
      kind: "assistant",
      text: "world",
      streaming: true,
    });
  });

  it("keeps a max-token assistant round as work instead of a final answer", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("continue");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    acceptTurn(1);
    // Turn A adopts streamId 1.
    emit({ type: "text_delta", text: "A", streamId: 1 });
    // A late frame from a SUPERSEDED turn (streamId 2) must be dropped, not appended to the live transcript.
    emit({ type: "text_delta", text: "STALE", streamId: 2 });
    emit({ type: "text_delta", text: "A", streamId: 1 });

    const last = lastAssistant(result.current.entries);
    expect(last).toMatchObject({ text: "AA" });
    expect(last?.text).not.toContain("STALE");
  });

  it("re-arms on the next send so a new turn adopts its own streamId", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    // Turn 1 (streamId 1), completes.
    await act(async () => {
      await result.current.send("one");
    });
    acceptTurn(1);
    emit({ type: "text_delta", text: "first", streamId: 1 });
    emit({ type: "done", streamId: 1 });
    expect(result.current.isStreaming).toBe(false);

    // Turn 2 (streamId 2): a stale frame from turn 1 must NOT bleed in.
    await act(async () => {
      await result.current.send("two");
    });
    acceptTurn(2);
    emit({ type: "text_delta", text: "STALE", streamId: 1 });
    emit({ type: "text_delta", text: "second", streamId: 2 });

    expect(lastAssistant(result.current.entries)?.text).toBe("second");
  });

  it("aborts the in-flight turn on unmount (tab switch teardown, no orphan)", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    const { result, unmount } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover the answer");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("first");
    });
    acceptTurn(1);
    emit({ type: "text_delta", streamId: 1, text: "first answer" });
    emit({ type: "done", streamId: 1 });

    await act(async () => {
      await result.current.send("second");
    });
    acceptTurn(2);
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "text_delta", streamId: 2, text: "second answer" });

    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
    expect(lastAssistant(result.current.entries)?.text).toBe("second answer");
  });

  it("removes a status-only placeholder when the side turn closes", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover without output");
    });
    acceptTurn(1);
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "done", streamId: 1 });

    expect(result.current.isStreaming).toBe(false);
    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
  });

  it("drops a late retry-status frame after the side turn has closed", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover then close");
    });
    acceptTurn(1);
    emit({ type: "text_delta", streamId: 1, text: "completed answer" });
    emit({ type: "done", streamId: 1 });
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });

    expect(lastAssistant(result.current.entries)?.text).toBe("completed answer");
    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
  });

  it("keeps real partial text visibly interrupted after a retry status", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("recover then stop");
    });
    acceptTurn(1);
    emit({ type: "llm_status", streamId: 1, phase: "retry", attempt: 2, maxAttempts: 5 });
    emit({ type: "text_delta", streamId: 1, text: "partial answer" });

    await act(async () => {
      await result.current.abort();
    });

    expect(lastAssistant(result.current.entries)).toMatchObject({
      text: "partial answer",
      interrupted: true,
      streaming: false,
    });
    expect(result.current.entries.some(
      (entry) => entry.kind === "assistant" && entry.phase === "status",
    )).toBe(false);
  });

  it("renders a tool_start/tool_end pair as a tool_group entry (parity with main)", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("run a tool");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("think");
    });
    acceptTurn(1);
    emit({ type: "reasoning_delta", text: "let me consider…", streamId: 1 });

    const reasoning = result.current.entries.find((e) => e.kind === "reasoning");
    expect(reasoning).toMatchObject({ kind: "reasoning", text: "let me consider…" });
  });

  it("upserts a permission_review status card (informational, not the modal)", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("do something risky");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("do something risky");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hi");
    });
    acceptTurn(1);
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
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("long conversation");
    });
    acceptTurn(1);
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
    const { api, emit, spies, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("first");
    });
    acceptTurn(1);
    emit({ type: "text_delta", text: "hello", streamId: 1 });

    // The end-of-turn drain raced a turn that had not finished: the host still has one in flight and refuses.
    spies.send.mockResolvedValueOnce({ ok: false, error: "streaming-active" });
    await act(async () => {
      await result.current.send("drained row", { inputOrigin: "queue-auto" });
    });
    expect(result.current.isStreaming).toBe(true);

    emit({ type: "text_delta", text: " world", streamId: 1 });

    const streaming = result.current.entries.find(
      (e): e is Extract<ChatEntry, { kind: "assistant" }> =>
        e.kind === "assistant" && e.streaming === true,
    );
    expect(streaming?.text).toBe("hello world");
  });

  it("does not restore an earlier running state after an accepted replacement fails", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    const reply = deferred<{ ok: false; error: string }>();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("Earlier request"); });
    acceptTurn(1);
    emit({ type: "text_delta", text: "Earlier answer", streamId: 1 });
    spies.send.mockReturnValueOnce(reply.promise);
    let pending = Promise.resolve();
    act(() => { pending = result.current.send("Replacement request", { inputOrigin: "queue-auto" }); });
    acceptTurn(2);
    emit({ type: "error", error: "Replacement failed", streamId: 2 });
    await act(async () => {
      reply.resolve({ ok: false, error: "Replacement failed" });
      await pending;
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.isCurrentTurnEvent({ type: "text_delta", text: "Old tail", streamId: 1 })).toBe(false);
  });

  // The abort is awaited AFTER the transcript and the composer have already committed the interrupt, so a transport failure
  // that escaped would destroy the text the user typed.
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

describe("useSideChat — the session a view shows", () => {
  it("names the session it shows on every turn, so main runs the turn there and nowhere else", async () => {
    const { api, spies, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { void result.current.send("first"); });
    expect(spies.send.mock.calls.at(-1)![5]).toBeUndefined();
    await acceptTurn(1);
    await act(async () => { void result.current.send("second"); });
    expect(spies.send.mock.calls.at(-1)![5]).toBe("side-1");
  });

  it("restores a stored conversation without asking main to move its loop, and clears to none", async () => {
    const { api, spies } = makeApi();
    const onSessionBound = vi.fn();
    const { result } = renderHook(() => useSideChat(api, { onSessionBound }));
    act(() => {
      result.current.restore("pane-session", [{ index: 0, role: "user", content: "what is on this page?" }]);
    });
    expect(result.current.sessionId).toBe("pane-session");
    expect(result.current.entries).toMatchObject([{ kind: "user", text: "what is on this page?" }]);
    expect(onSessionBound).toHaveBeenCalledWith("pane-session");
    expect(spies.load).not.toHaveBeenCalled();
    expect(spies.newSession).not.toHaveBeenCalled();

    act(() => result.current.clear());
    expect(result.current.sessionId).toBeNull();
    expect(result.current.entries).toEqual([]);
    await act(async () => { void result.current.send("afresh"); });
    expect(spies.send.mock.calls.at(-1)![5]).toBeUndefined();
  });
});


describe("side conversation compaction failure", () => {
  it("keeps its transcript notice local and continues the same chat turn", async () => {
    const { api, emit, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.send("hello"); });
    acceptTurn(1);
    emit({ type: "text_delta", streamId: 1, text: "Before " });
    emit({ type: "compact_failed", streamId: 1 });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.entries.some((entry) => entry.kind === "system" && /압축|compaction/.test(entry.text))).toBe(true);
    emit({ type: "text_delta", streamId: 1, text: "after" });
    emit({ type: "done", streamId: 1 });
    expect(lastAssistant(result.current.entries)).toMatchObject({ text: "Before after", streaming: false });
    expect(result.current.isStreaming).toBe(false);
  });
});
