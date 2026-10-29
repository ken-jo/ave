// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { useMessageQueue, type UseMessageQueueParams } from "../use-message-queue.js";
import { useSideChat } from "../use-side-chat.js";
import type { ComposerHandle } from "../../components/Composer.js";
import type { Attachment } from "../../types/attachments.js";
import type { ChatStreamEvent } from "../../../../lib/chat-stream-state.js";
import type { UserKeyboardIntentSnapshot } from "../../../../shared/chat-origin.js";
import type { AveApi } from "../../types.js";
import { deferred } from "../../../../../test/renderer/helpers.js";

describe("useMessageQueue location references", () => {
  it("serializes the current reference for the guide shortcut and preserves refused draft state", async () => {
    const reply = deferred<{ ok: false; error: string }>();
    const inject = vi.fn(() => reply.promise);
    const onError = vi.fn();
    const guide = { inject, onError };
    const initial: Attachment = { id: "ref", n: 1, kind: "file", path: "src/app.ts", name: "app.ts", ext: "ts", bytes: 0,
      reference: true, location: { startLine: 3, endLine: 5, turnId: "turn-1", hunkId: "hunk-1" } };
    const replacement: Attachment = { ...initial, location: { startLine: 8, endLine: 9, turnId: "turn-2", hunkId: "hunk-2" } };
    const subscribeStream = () => () => {};
    const { result } = renderHook(() => {
      const [question, setQuestion] = useState("explain [File #1]");
      const [attachments, setAttachments] = useState<Attachment[]>([initial]);
      useMessageQueue({ surface: "main", subscribeStream,
        composerRef: useRef<ComposerHandle | null>(null), currentSessionId: "session-1", question, attachments,
        streaming: true, setQuestion, setAttachments, onAsk: vi.fn(), onAbort: vi.fn(), guide });
      return { question, attachments, setAttachments };
    });
    act(() => { result.current.setAttachments([replacement]); });
    // The shortcut captures the gesture's one-shot keyboard intent inside its key handler and hands it to the guide.
    const intent = { inputOrigin: "user-keyboard" as const, token: "gesture-token" };
    const capture = vi.fn(() => intent);
    (window as unknown as { aveApi?: unknown }).aveApi = { captureUserKeyboardIntent: capture };
    try {
      act(() => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })); });
    } finally {
      delete (window as unknown as { aveApi?: unknown }).aveApi;
    }
    expect(capture).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith('explain [File #1 — path: "src/app.ts" — lines: 8-9 — turn: "turn-2" — hunk: "hunk-2"]', intent);
    expect(result.current.question).toBe("explain [File #1]");
    expect(result.current.attachments).toEqual([replacement]);
    await act(async () => { reply.resolve({ ok: false, error: "file-reference-active-turn" }); });
    expect(onError).toHaveBeenCalledOnce();
    expect(result.current.question).toBe("explain [File #1]");
    expect(result.current.attachments).toEqual([replacement]);
  });

  it("preserves selectors through attachment clearing and refused guide delivery before queue-auto send", async () => {
    const onAsk = vi.fn();
    const inject = vi.fn(async () => ({ ok: false as const, error: "streaming-active" }));
    const onError = vi.fn();
    let emit: (event: ChatStreamEvent) => void = () => {};
    const subscribeStream = (handler: typeof emit) => { emit = handler; return () => {}; };
    const { result } = renderHook(() => {
      const [question, setQuestion] = useState("explain [File #1] and [File #2]");
      const [attachments, setAttachments] = useState<Attachment[]>([
        { id: "ref", n: 1, kind: "file", path: "src/app.ts", name: "app.ts", ext: "ts", bytes: 0,
          reference: true, location: { startLine: 3, endLine: 5, turnId: "turn-1", hunkId: "hunk-1" } },
        { id: "ordinary", n: 2, kind: "file", path: "/ws/notes.txt", name: "notes.txt", ext: "txt", bytes: 10 },
      ]);
      const queue = useMessageQueue({ surface: "main", subscribeStream,
        composerRef: useRef<ComposerHandle | null>(null), currentSessionId: "session-1", question, attachments,
        streaming: true, setQuestion, setAttachments, onAsk, onAbort: vi.fn(), guide: { inject, onError } });
      return { queue, question, attachments };
    });
    act(() => result.current.queue.handleComposerSend({ inputOrigin: "user-keyboard", token: "" }));
    const text = 'explain [File #1 — path: "src/app.ts" — lines: 3-5 — turn: "turn-1" — hunk: "hunk-1"] and [File #2]';
    expect(result.current.queue.messageQueueStore.getPending()[0]?.text).toBe(text);
    expect(result.current.attachments).toEqual([]);
    expect(result.current.question).toBe("");
    await act(async () => { emit({ type: "tool_end", name: "read_file", result: "read" }); });
    expect(inject).toHaveBeenCalledWith(expect.stringContaining(text));
    expect(result.current.queue.messageQueueStore.getPending()[0]?.text).toBe(text);
    expect(onError).toHaveBeenCalledOnce();
    await act(async () => { emit({ type: "done" }); });
    expect(onAsk).toHaveBeenCalledWith(expect.stringContaining(text), undefined,
      { injectHint: "queue", inputOrigin: "queue-auto" });
  });
});

/** Queue drains must follow the surface's stale-frame verdict; an aborted turn's late done must not drain onto its
 * replacement turn. */

/** A side-chat preload double that supports SEVERAL subscribers on one channel — the transcript and the queue both listen,
 * and the single-slot double the transcript's own suite uses would let the second overwrite the first. */
function makeApi(options: { reverseDispatch?: boolean } = {}) {
  const handlers = new Set<(e: ChatStreamEvent) => void>();
  const dispatch = (e: ChatStreamEvent) => {
    // Each subscriber gets its OWN copy of the frame: the context bridge builds
    // a fresh object per listener, so a verdict cached by frame identity would
    // not survive the crossing.
    //
    // The ORDER is a parameter because nothing in the contract fixes it. Today
    // the transcript subscribes first because its hook is called first, and
    // that must not be what makes the drain correct.
    const ordered = [...handlers];
    if (options.reverseDispatch) ordered.reverse();
    for (const h of ordered) h({ ...e });
  };
  /** Frames the host emits while the abort round trip is still in flight. */
  let framesDuringAbort: ChatStreamEvent[] = [];
  const abort = vi.fn(async () => {
    for (const e of framesDuringAbort) dispatch(e);
    framesDuringAbort = [];
    return { ok: true as const };
  });
  const send = vi.fn(async (_input: string, _attachments?: unknown[], _originSessionId?: string, _sendRequestId?: string): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> => ({ ok: true, result: {} }));
  const api = {
    sideChat: {
      send,
      new: vi.fn(async () => ({ ok: true as const, sessionId: "side-2" })),
      load: vi.fn(async () => ({ ok: true as const, sessionId: "side-3", messages: [] })),
      list: vi.fn(async () => ({ current: "side-1", sessions: [] })),
      abort,
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
    acceptTurn: async (streamId: number) => {
      await act(async () => {
        dispatch({ type: "user_message", sessionId: "side-1", streamId, sendRequestId: send.mock.calls.at(-1)![3] });
      });
    },
    subscriberCount: () => handlers.size,
    /** One dispatch to every subscriber, as the stream channel does. */
    emit: async (e: ChatStreamEvent) => {
      await act(async () => {
        dispatch(e);
      });
    },
    /** Queue a frame for the host to publish WHILE `abort` is in flight. That is the real timing of an interrupted turn's
     * trailing `done`: the host settles the turn before the abort invoke resolves. */
    emitDuringAbort: (e: ChatStreamEvent) => {
      framesDuringAbort.push(e);
    },
    spies: { send, abort },
  };
}

/** The composition SideChatView builds: transcript hook + shared queue hook. */
function useSideSurface(api: AveApi) {
  const side = useSideChat(api);
  const composerRef = useRef<ComposerHandle | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const { send, isCurrentTurnEvent, abort } = side;

  const onAsk = useCallback(
    (
      text: string,
      _intent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      if (opts?.inputOrigin === "queue-auto") {
        return send(text, { injectHint: opts.injectHint, inputOrigin: "queue-auto" });
      }
      return send(text, opts?.injectHint ? { injectHint: opts.injectHint } : {});
    },
    [send],
  );

  const queue = useMessageQueue({
    surface: "side",
    subscribeStream: api.sideChat!.onStream,
    composerRef,
    currentSessionId: side.sessionId ?? "",
    question: draft,
    attachments,
    streaming: side.isStreaming,
    setQuestion: setDraft,
    setAttachments,
    onAsk,
    onAbort: abort,
    isCurrentTurnEvent,
  });

  return { side, queue, setDraft };
}

type Surface = ReturnType<typeof useSideSurface>;

async function typeAndSubmit(result: { current: Surface }, text: string) {
  await act(async () => {
    result.current.setDraft(text);
  });
  await act(async () => {
    result.current.queue.handleComposerSend({ inputOrigin: "user-keyboard", token: "" });
  });
}

describe("useMessageQueue end-of-turn drain (side chat)", () => {
  it("sends queued messages in the order chosen in the queue", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));
    await act(async () => { await result.current.side.send("first turn"); });
    await acceptTurn(1);
    await typeAndSubmit(result, "first queued");
    await typeAndSubmit(result, "second queued");
    act(() => {
      const store = result.current.queue.messageQueueStore;
      store.move(store.getItems()[1].id, -1);
    });

    await emit({ type: "done", streamId: 1 });

    expect(spies.send).toHaveBeenCalledTimes(2);
    expect(spies.send.mock.calls[1][0]).toContain("- second queued\n- first queued");
  });

  it.each([false, true])("keeps queued drafts when a peer's unseen turn ends, reverse dispatch: %s", async (reverseDispatch) => {
    const { api, emit, spies } = makeApi({ reverseDispatch });
    await emit({ type: "user_message", sessionId: "side-peer", streamId: 1, sendRequestId: "peer-request" });
    const reply = deferred<{ ok: false; error: string }>();
    spies.send.mockReturnValueOnce(reply.promise);
    const { result } = renderHook(() => useSideSurface(api));
    let pending = Promise.resolve();
    act(() => { pending = result.current.side.send("Local request"); });
    await typeAndSubmit(result, "Keep queued");
    const currentEntries = result.current.side.entries;
    try {
      await emit({ type: "text_delta", text: "Peer answer", streamId: 1 });
      await emit({ type: "done", streamId: 1 });
      expect(result.current.side.entries).toEqual(currentEntries);
      expect(result.current.side.isStreaming).toBe(true);
      expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);
      expect(spies.send).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        reply.resolve({ ok: false, error: "streaming-active" });
        await pending;
      });
    }
  });

  it("drains on the current turn's done", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await acceptTurn(1);
    expect(spies.send).toHaveBeenCalledTimes(1);
    // The matching user prelude establishes its stream id.
    await emit({ type: "text_delta", text: "a", streamId: 1 });

    await typeAndSubmit(result, "later");
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);

    await emit({ type: "done", streamId: 1 });

    expect(spies.send).toHaveBeenCalledTimes(2);
    const [drainedText] = spies.send.mock.calls[1] as unknown as [string];
    expect(drainedText).toContain("later");
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(0);
  });

  it("does not drain on the trailing done that arrives DURING an interrupt", async () => {
    const { api, emit, emitDuringAbort, spies, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await acceptTurn(1);
    await emit({ type: "text_delta", text: "a", streamId: 1 });

    await typeAndSubmit(result, "later");
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);

    // The host settles the aborted turn BEFORE the abort invoke resolves, so its `turn.completed` lands in the middle of the
    // interrupt — the exact timing the real app produces.
    emitDuringAbort({ type: "done", streamId: 1 });
    await act(async () => {
      await result.current.side.abort();
    });
    expect(spies.abort).toHaveBeenCalledTimes(1);

    // The row is still the user's — no `queue-auto` send went out on top of the turn that replaces the aborted one.
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);
  });

  it("does not drain on a trailing done that arrives after the interrupt", async () => {
    const { api, emit, spies, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await acceptTurn(1);
    await emit({ type: "text_delta", text: "a", streamId: 1 });
    await typeAndSubmit(result, "later");

    await act(async () => {
      await result.current.side.abort();
    });
    await emit({ type: "done", streamId: 1 });

    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);
  });

  // The drain's send re-arms the surface's stale-frame guard synchronously. If
  // it ran inside the dispatch, a subscriber that had not judged the frame yet
  // would read it as superseded — and the transcript, judging last, would drop
  // its own `done` and leave the answer streaming forever.
  it("drains and closes the answer whichever subscriber judges the frame first", async () => {
    const { api, emit, spies, acceptTurn } = makeApi({ reverseDispatch: true });
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await acceptTurn(1);
    await emit({ type: "text_delta", text: "hello", streamId: 1 });
    await typeAndSubmit(result, "later");

    await emit({ type: "done", streamId: 1 });
    // The drain is deferred by a microtask; let it run.
    await act(async () => {
      await Promise.resolve();
    });

    const stuck = result.current.side.entries.filter(
      (e) => e.kind === "assistant" && e.streaming === true,
    );
    expect(stuck).toHaveLength(0);
    expect(spies.send).toHaveBeenCalledTimes(2);
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(0);
  });

  it("gives every subscriber the same verdict for one frame", async () => {
    const { api, emit, subscriberCount, acceptTurn } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));
    // The transcript and the queue are BOTH on the channel, each holding its own copy of the frame. Whoever asks second must
    // not be told "superseded" about the very frame the first asker just accepted.
    expect(subscriberCount()).toBe(2);

    await act(async () => {
      await result.current.side.send("first");
    });
    await acceptTurn(1);
    await emit({ type: "text_delta", text: "hello", streamId: 1 });
    await emit({ type: "done", streamId: 1 });

    // The transcript accepted it — streaming ended…
    expect(result.current.side.isStreaming).toBe(false);
    // …and a later asker holding a separate copy is told the same.
    expect(result.current.side.isCurrentTurnEvent({ type: "done", streamId: 1 })).toBe(true);
  });
});

function makeDeferredQueueGuide() {
  let emit!: (event: ChatStreamEvent) => void;
  type GuideResult = { ok: true } | { ok: false; error: string };
  let resolve!: (value: GuideResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<GuideResult>((accept, decline) => { resolve = accept; reject = decline; });
  const pending = { promise, resolve, reject };
  const inject = vi.fn((_text: string) => pending.promise);
  const guide = { inject, onError: vi.fn() };
  const onAsk = vi.fn<UseMessageQueueParams["onAsk"]>();
  const subscribeStream = (handler: (event: ChatStreamEvent) => void) => {
    emit = handler;
    return () => {};
  };
  const { result, rerender } = renderHook(({ sessionId, streaming = true }: { sessionId: string; streaming?: boolean }) => useMessageQueue({
    surface: "main", subscribeStream, composerRef: { current: null },
    currentSessionId: sessionId, question: "", attachments: [], streaming,
    setQuestion: () => {}, setAttachments: () => {}, onAsk, guide, onAbort: vi.fn(),
  }), { initialProps: { sessionId: "queue-session" } as { sessionId: string; streaming?: boolean } });
  act(() => {
    result.current.messageQueueStore.add("first");
    result.current.messageQueueStore.add("second");
  });
  return {
    result, inject, onAsk, guide, pending, rerender,
    emit: (event: ChatStreamEvent) => act(() => emit(event)),
    accept: () => act(async () => { pending.resolve({ ok: true }); await pending.promise; }),
  };
}

describe("queue reorder with concurrent delivery", () => {
  it("does not confirm a new order once that batch is already in flight", async () => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    const original = store.getItems().map((item) => item.text);
    f.emit({ type: "tool_end" });
    expect(f.inject.mock.calls[0][0]).toContain("- first\n- second");
    // A round-boundary flush has no gesture behind it, so it carries no keyboard intent.
    expect(f.inject.mock.calls[0]).toHaveLength(1);
    act(() => store.move(store.getItems()[1].id, -1));
    await f.accept();
    expect(store.getItems().every((item) => item.handedOffAs !== undefined)).toBe(true);
    expect(store.getItems().map((item) => item.text)).toEqual(original);
  });

  it("sends the moved item once and preserves remaining order when send-now precedes a brake point", () => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    act(() => store.move(store.getItems()[1].id, -1));
    act(() => f.result.current.handleMessageQueueSendNow(store.getItems()[0]));
    expect(f.onAsk.mock.calls[0][0]).toBe("second");
    expect(store.getItems().map((item) => item.text)).toEqual(["first"]);
    f.emit({ type: "tool_end" });
    expect(f.inject.mock.calls[0][0]).toBe("first");
  });
});

describe("queue guide reservation ownership", () => {
  it("blocks stale send-now and automatic drains until acceptance without claiming later additions", async () => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    const stale = store.getItems()[0];
    f.emit({ type: "tool_end" });
    expect(store.getItems().every((item) => item.handedOffAs === undefined && item.handoffReservationId !== undefined)).toBe(true);
    act(() => f.result.current.handleMessageQueueSendNow(stale));
    f.emit({ type: "done" });
    expect(f.onAsk).not.toHaveBeenCalled();
    act(() => store.add("later"));
    await f.accept();
    expect(store.getPending().map((item) => item.text)).toEqual(["later"]);
    expect(store.getItems().slice(0, 2).every((item) => item.handedOffAs !== undefined && item.handoffReservationId === undefined)).toBe(true);
    f.emit({ type: "guidance_injected", text: f.inject.mock.calls[0][0] });
    expect(store.getItems().map((item) => item.text)).toEqual(["later"]);
    act(() => f.result.current.handleMessageQueueSendNow(stale));
    expect(f.onAsk).not.toHaveBeenCalled();
  });

  it.each(["denied", "error"])("releases a %s request and preserves remaining queue order for turn-end drain", async (outcome) => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    f.emit({ type: "tool_end" });
    await act(async () => {
      if (outcome === "denied") f.pending.resolve({ ok: false, error: "queue-full" });
      else f.pending.reject(new Error("unavailable"));
      await f.pending.promise.catch(() => {});
    });
    expect(store.getPending().map((item) => item.text)).toEqual(["first", "second"]);
    expect(f.guide.onError).toHaveBeenCalledTimes(1);
    f.emit({ type: "tool_end" });
    expect(f.inject).toHaveBeenCalledTimes(1);
    await act(async () => { f.emit({ type: "done" }); });
    expect(f.onAsk.mock.calls[0][0]).toContain("- first\n- second");
    expect(store.getItems()).toEqual([]);
  });

  it.each(["accepted", "denied", "error"])("ignores a late %s reply after another session starts a handoff", async (outcome) => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    f.emit({ type: "tool_end" });
    const replacement = deferred<{ ok: true } | { ok: false; error: string }>();
    f.inject.mockImplementationOnce(() => replacement.promise);
    act(() => f.rerender({ sessionId: "replacement-session" }));
    act(() => store.add("replacement"));
    f.emit({ type: "tool_end" });
    const replacementId = store.getItems()[0].handoffReservationId;
    await act(async () => {
      if (outcome === "accepted") f.pending.resolve({ ok: true });
      else if (outcome === "denied") f.pending.resolve({ ok: false, error: "queue-full" });
      else f.pending.reject(new Error("unavailable"));
      await f.pending.promise.catch(() => {});
    });
    expect(store.getItems()[0]).toMatchObject({ text: "replacement", handoffReservationId: replacementId });
    expect(store.getItems()[0].handedOffAs).toBeUndefined();
    expect(f.guide.onError).not.toHaveBeenCalled();
    f.emit({ type: "tool_end" });
    expect(f.inject).toHaveBeenCalledTimes(2);
    await act(async () => { replacement.resolve({ ok: true }); await replacement.promise; });
    expect(store.getItems()[0].handedOffAs).toBe("replacement");
    act(() => store.add("next"));
    f.emit({ type: "tool_end" });
    expect(f.inject).toHaveBeenCalledTimes(3);
  });
});

describe("queue selection while awaiting guide acceptance", () => {
  it("Escape clears later pending selection without changing reserved selection", async () => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    act(() => store.toggleSelect(store.getItems()[0].id));
    f.emit({ type: "tool_end" });
    act(() => {
      const pending = store.add("later");
      store.toggleSelect(pending.id);
    });
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(store.getItems().map((item) => item.selected)).toEqual([true, false, false]);
    expect(f.onAsk).not.toHaveBeenCalled();
    await act(async () => {
      f.pending.resolve({ ok: false, error: "queue-full" });
      await f.pending.promise;
    });
    expect(store.selectedCount()).toBe(1);
    expect(store.getItems()[0].selected).toBe(true);
  });
});

describe("queue guide reply after turn completion", () => {
  it.each(["denied", "error"])("auto-drains once when a %s guide reply releases rows after done", async (outcome) => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    f.emit({ type: "tool_end" });
    await act(async () => { f.emit({ type: "done" }); });
    expect(f.onAsk).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "denied") f.pending.resolve({ ok: false, error: "no-active-turn" });
      else f.pending.reject(new Error("unavailable"));
      await f.pending.promise.catch(() => {});
    });
    expect(f.onAsk).toHaveBeenCalledTimes(1);
    expect(f.onAsk.mock.calls[0][0]).toContain("- first\n- second");
    expect(f.onAsk.mock.calls[0][2]).toEqual({ injectHint: "queue", inputOrigin: "queue-auto" });
    expect(store.getItems()).toEqual([]);
    await act(async () => { f.emit({ type: "done" }); });
    expect(f.onAsk).toHaveBeenCalledTimes(1);
  });

  it("does not auto-drain an accepted handoff after done", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "done" });
    await f.accept();
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getItems().every((item) => item.handedOffAs !== undefined)).toBe(true);
  });

  it("does not drain over a new turn when the previous guide reply arrives late", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end", streamId: 1 });
    f.emit({ type: "done", streamId: 1 });
    f.emit({ type: "user_message", streamId: 2 });
    await act(async () => {
      f.pending.resolve({ ok: false, error: "no-active-turn" });
      await f.pending.promise;
    });
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getPending()).toHaveLength(2);
    await act(async () => { f.emit({ type: "done", streamId: 2 }); });
    expect(f.onAsk).toHaveBeenCalledTimes(1);
  });

  it("does not drain a replacement session after an old turn completes", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "done" });
    act(() => f.rerender({ sessionId: "replacement-session" }));
    act(() => f.result.current.messageQueueStore.add("replacement"));
    await act(async () => {
      f.pending.resolve({ ok: false, error: "no-active-turn" });
      await f.pending.promise;
    });
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getPending().map((item) => item.text)).toEqual(["replacement"]);
  });
});

describe("queue completed-turn replay cancellation", () => {
  it("keeps released rows queued when streaming restarts before the old guide reply", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "done" });
    act(() => f.rerender({ sessionId: "queue-session", streaming: false }));
    act(() => f.rerender({ sessionId: "queue-session", streaming: true }));
    await act(async () => {
      f.pending.resolve({ ok: false, error: "no-active-turn" });
      await f.pending.promise;
    });
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getPending()).toHaveLength(2);
    expect(f.guide.onError).not.toHaveBeenCalled();
  });

  it("does not replay over a new explicit send before its first stream frame", async () => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    f.emit({ type: "tool_end" });
    f.emit({ type: "done" });
    act(() => {
      const immediate = store.add("send now");
      f.result.current.handleMessageQueueSendNow(immediate);
    });
    await act(async () => {
      f.pending.reject(new Error("unavailable"));
      await f.pending.promise.catch(() => {});
    });
    expect(f.onAsk).toHaveBeenCalledTimes(1);
    expect(f.onAsk.mock.calls[0][0]).toBe("send now");
    expect(store.getPending().map((item) => item.text)).toEqual(["first", "second"]);
    expect(f.guide.onError).not.toHaveBeenCalled();
  });

  it("rechecks turn ownership if a replacement frame precedes the scheduled replay microtask", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "done" });
    await act(async () => {
      f.pending.resolve({ ok: false, error: "no-active-turn" });
      queueMicrotask(() => f.emit({ type: "user_message", streamId: 2 }));
      await f.pending.promise;
    });
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getPending()).toHaveLength(2);
  });
});


describe("queue disposition before guide acceptance", () => {
  it.each(["drop-before-done", "done-before-drop"])("drains a dropped reserved batch exactly once after a late acceptance: %s", async (order) => {
    const f = makeDeferredQueueGuide();
    const store = f.result.current.messageQueueStore;
    f.emit({ type: "tool_end" });
    const text = f.inject.mock.calls[0][0];
    if (order === "done-before-drop") f.emit({ type: "done" });
    f.emit({ type: "guidance_dropped", text });
    if (order === "drop-before-done") f.emit({ type: "done" });
    await f.accept();
    await act(async () => { await Promise.resolve(); });
    expect(f.onAsk).toHaveBeenCalledTimes(1);
    expect(f.onAsk.mock.calls[0][0]).toBe(text);
    expect(store.getItems()).toEqual([]);
    expect(f.guide.onError).not.toHaveBeenCalled();
    f.emit({ type: "done" });
    expect(f.onAsk).toHaveBeenCalledTimes(1);
  });

  it("clears a delivered reserved batch before a late acceptance without retrying", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "guidance_injected", text: f.inject.mock.calls[0][0] });
    f.emit({ type: "done" });
    await f.accept();
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getItems()).toEqual([]);
  });

  it("does not attach an unrelated dropped message to the active reservation", async () => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "guidance_dropped", text: "unrelated guidance" });
    f.emit({ type: "done" });
    await f.accept();
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getItems().every((item) => item.handedOffAs !== undefined)).toBe(true);
  });
});


describe("delivered guidance before invoke failure", () => {
  it.each(["denied", "error"])("keeps delivery authoritative after a late %s reply", async (outcome) => {
    const f = makeDeferredQueueGuide();
    f.emit({ type: "tool_end" });
    f.emit({ type: "guidance_injected", text: f.inject.mock.calls[0][0] });
    f.emit({ type: "done" });
    await act(async () => {
      if (outcome === "denied") f.pending.resolve({ ok: false, error: "no-active-turn" });
      else f.pending.reject(new Error("transport closed"));
      await f.pending.promise.catch(() => {});
    });
    expect(f.onAsk).not.toHaveBeenCalled();
    expect(f.guide.onError).not.toHaveBeenCalled();
    expect(f.result.current.messageQueueStore.getItems()).toEqual([]);
  });
});
