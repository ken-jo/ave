// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, renderHook } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "../../../../lib/chat-stream-state.js";
import type { ComposerHandle } from "../../components/Composer.js";
import { deferred } from "../../../../../test/renderer/helpers.js";
import { useMessageQueue, type UseMessageQueueParams } from "../use-message-queue.js";

const SOURCE = "app:fixture";
const INTENT = { inputOrigin: "user-keyboard" as const, token: "gesture" };

function setup({ streaming = false, guideAccepted = true } = {}) {
  let emit!: (event: ChatStreamEvent) => void;
  const onAsk = vi.fn<UseMessageQueueParams["onAsk"]>();
  const inject = vi.fn(async (_text: string, _intent?: unknown, _source?: string) => guideAccepted
    ? { ok: true as const } : { ok: false as const, error: "no-active-turn" });
  const interceptSubmit = vi.fn(() => true);
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);
  const subscribeStream = (handler: typeof emit) => { emit = handler; return () => {}; };
  const hook = renderHook(({ sessionId }) => {
    const [draft, setDraft] = useState<{ text: string; appSource?: string }>({ text: "App draft", appSource: SOURCE });
    const setQuestion = useCallback<UseMessageQueueParams["setQuestion"]>((change) => setDraft((previous) => {
      const text = typeof change === "function" ? change(previous.text) : change;
      return { text, ...(text && previous.appSource ? { appSource: previous.appSource } : {}) };
    }), []);
    const composerRef = useRef({ textarea: () => textarea } as ComposerHandle);
    const queue = useMessageQueue({ surface: "main", subscribeStream, composerRef,
      currentSessionId: sessionId, question: draft.text, appSource: draft.appSource, draftIdentity: draft, attachments: [], streaming,
      setQuestion, setAttachments: vi.fn(), onAsk, onAbort: vi.fn(), interceptSubmit,
      guide: { inject, onError: vi.fn() },
    });
    return { queue, draft, setQuestion, setDraft };
  }, { initialProps: { sessionId: "chat" } });
  return { ...hook, onAsk, inject, interceptSubmit, textarea,
    emit: async (event: ChatStreamEvent) => { await act(async () => emit(event)); },
    send: () => act(() => hook.result.current.queue.handleComposerSend(INTENT)),
  };
}

afterEach(() => { document.querySelectorAll("textarea").forEach((node) => node.remove()); });

describe("queued app provenance", () => {
  it("interrupts with multiple app sources while an older guide handoff is unresolved", async () => {
    const s = setup({ streaming: true });
    const guideReply = deferred<{ ok: true }>();
    s.inject.mockImplementationOnce(() => guideReply.promise);
    const store = s.result.current.queue.messageQueueStore;
    act(() => { store.add("Older guidance", "app:older"); });
    await s.emit({ type: "tool_end", name: "read_file", result: "done" });
    act(() => { store.toggleSelect(store.add("Selected app text", "app:other").id); });
    await act(async () => s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(s.onAsk.mock.calls).toEqual([
      ["Selected app text", expect.anything(), { injectHint: "interrupt", appSource: "app:other" }],
      ["App draft", undefined, { injectHint: "queue", inputOrigin: "queue-auto", appSource: SOURCE }],
    ]);
    await act(async () => { guideReply.resolve({ ok: true }); await guideReply.promise; });
    expect(s.inject).toHaveBeenCalledExactlyOnceWith("Older guidance", undefined, "app:older");
    expect(store.getItems()).toMatchObject([{ text: "Older guidance", appSource: "app:older", handedOffAs: "Older guidance" }]);
  });

  it("sends an immediate single-source draft beyond queue capacity without truncating or retaining it", async () => {
    const s = setup({ streaming: true });
    const text = "a".repeat(8_001);
    act(() => s.result.current.setDraft({ text, appSource: SOURCE }));
    await act(async () => s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(s.onAsk).toHaveBeenCalledExactlyOnceWith(text, expect.anything(), { injectHint: "interrupt", appSource: SOURCE });
    expect(s.result.current.draft).toEqual({ text: "" });
    expect(s.result.current.queue.messageQueueStore.getPending()).toEqual([]);
  });

  it("retains a deferred oversized app draft and selected queue rows when queue staging is refused", async () => {
    const s = setup({ streaming: true });
    const text = "a".repeat(8_001);
    act(() => {
      const store = s.result.current.queue.messageQueueStore;
      const item = store.add("Other source", "app:other");
      store.toggleSelect(item.id);
      s.result.current.setDraft({ text, appSource: SOURCE });
    });
    await act(async () => s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(s.onAsk).not.toHaveBeenCalled();
    expect(s.result.current.draft).toEqual({ text, appSource: SOURCE });
    expect(s.result.current.queue.messageQueueStore.getPending()).toMatchObject([{ text: "Other source", appSource: "app:other", selected: true }]);
  });

  it("keeps a different-source composer draft queued until the selected app turn finishes", async () => {
    const s = setup({ streaming: true });
    const firstTurn = deferred<void>();
    s.onAsk.mockImplementationOnce(() => firstTurn.promise);
    act(() => {
      const store = s.result.current.queue.messageQueueStore;
      store.toggleSelect(store.add("Selected app text", "app:other").id);
    });
    await act(async () => s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(s.onAsk).toHaveBeenCalledExactlyOnceWith("Selected app text", expect.anything(), { injectHint: "interrupt", appSource: "app:other" });
    expect(s.result.current.queue.messageQueueStore.getPending()).toMatchObject([{ text: "App draft", appSource: SOURCE }]);
    await act(async () => { firstTurn.resolve(); await firstTurn.promise; });
    expect(s.onAsk.mock.calls[1]).toEqual(["App draft", undefined,
      { injectHint: "queue", inputOrigin: "queue-auto", appSource: SOURCE }]);
  });

  for (const delivery of ["auto", "selected", "interrupt"] as const) {
    it(`keeps later source groups queued while ${delivery} delivery awaits the first turn`, async () => {
      const s = setup({ streaming: true });
      const firstTurn = deferred<void>();
      s.onAsk.mockImplementationOnce(() => firstTurn.promise);
      const store = s.result.current.queue.messageQueueStore;
      act(() => {
        s.result.current.setQuestion("");
        const a = store.add("A", "app:first");
        const b = store.add("B", "app:second");
        if (delivery === "selected") { store.toggleSelect(a.id); store.toggleSelect(b.id); }
      });
      if (delivery === "auto") await s.emit({ type: "done" });
      else await act(async () => {
        if (delivery === "interrupt") s.result.current.queue.flushQueueAsUserMessage();
        else s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      });
      expect(store.getPending().map((item) => item.text)).toEqual(["B"]);
      act(() => { store.add("C", "app:third"); });
      await s.emit({ type: "tool_end", name: "read_file", result: "done" });
      expect(s.inject).not.toHaveBeenCalled();
      expect(s.onAsk.mock.calls.map((call) => call[0])).toEqual(["A"]);
      await act(async () => { firstTurn.resolve(); await firstTurn.promise; });
      if (delivery === "selected") await s.emit({ type: "done" });
      expect(s.onAsk.mock.calls.map((call) => call[0])).toEqual(["A", "B", "C"]);
    });
  }

  it("does not send a retained source group into a different conversation after an awaited turn", async () => {
    const s = setup({ streaming: true });
    const firstTurn = deferred<void>();
    s.onAsk.mockImplementationOnce(() => firstTurn.promise);
    act(() => {
      const store = s.result.current.queue.messageQueueStore;
      store.add("A", "app:first");
      store.add("B", "app:second");
    });
    await s.emit({ type: "done" });
    expect(s.result.current.queue.messageQueueStore.getPending().map((item) => item.text)).toEqual(["B"]);
    act(() => s.rerender({ sessionId: "other-chat" }));
    await act(async () => { firstTurn.resolve(); await firstTurn.promise; });
    expect(s.onAsk.mock.calls.map((call) => call[0])).toEqual(["A"]);
  });

  it("drains later source groups after turn completion waits for the first guide handoff", async () => {
    const s = setup({ streaming: true });
    const reply = deferred<{ ok: true }>();
    s.inject.mockImplementationOnce(() => reply.promise);
    act(() => {
      const store = s.result.current.queue.messageQueueStore;
      store.add("First", "app:first");
      store.add("Second", "app:second");
    });
    await s.emit({ type: "tool_end", name: "read_file", result: "done" });
    await s.emit({ type: "done" });
    expect(s.onAsk).not.toHaveBeenCalled();
    await act(async () => { reply.resolve({ ok: true }); await reply.promise; });
    expect(s.inject).toHaveBeenCalledExactlyOnceWith("First", undefined, "app:first");
    expect(s.onAsk).toHaveBeenCalledExactlyOnceWith("Second", undefined,
      { injectHint: "queue", inputOrigin: "queue-auto", appSource: "app:second" });
  });

  for (const delivery of ["auto", "guide", "interrupt", "selected"] as const) {
    it(`keeps different app source groups in queue order for ${delivery} delivery`, async () => {
      const s = setup({ streaming: true });
      act(() => {
        s.result.current.setQuestion("");
        const store = s.result.current.queue.messageQueueStore;
        store.add("A first", "app:first");
        store.add("User middle");
        store.add("B second", "app:second");
        store.add("A last", "app:first");
        if (delivery === "selected") for (const item of store.getPending()) store.toggleSelect(item.id);
      });
      if (delivery === "auto") await s.emit({ type: "done" });
      else if (delivery === "guide") await s.emit({ type: "tool_end", name: "read_file", result: "done" });
      else await act(async () => {
        if (delivery === "interrupt") s.result.current.queue.flushQueueAsUserMessage();
        else s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
      });
      const calls = delivery === "guide" ? s.inject.mock.calls : s.onAsk.mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls.map((call) => delivery === "guide" ? call[2] : (call[2] as { appSource?: string })?.appSource))
        .toEqual(["app:first", "app:second", "app:first"]);
      expect(calls[0][0]).toContain("A first");
      expect(calls[0][0]).toContain("User middle");
      expect(calls[1][0]).toBe("B second");
      expect(calls[2][0]).toBe("A last");
      if (delivery === "interrupt" || delivery === "selected") {
        expect(s.onAsk.mock.calls[0][2]?.injectHint).toBe("interrupt");
        expect(s.onAsk.mock.calls[1][2]?.inputOrigin).toBe("queue-auto");
      }
    });
  }

  it("carries the idle composer source and never runs approval shortcuts for app text", () => {
    const s = setup();
    s.send();
    expect(s.onAsk).toHaveBeenCalledWith("App draft", undefined, { appSource: SOURCE });
    expect(s.interceptSubmit).not.toHaveBeenCalled();
  });

  it("captures the source before clearing a streaming composer and retains it on auto drain", async () => {
    const s = setup({ streaming: true });
    s.send();
    expect(s.result.current.draft).toEqual({ text: "" });
    expect(s.result.current.queue.messageQueueStore.getPending()[0]).toMatchObject({ text: "App draft", appSource: SOURCE });
    await s.emit({ type: "done" });
    expect(s.onAsk).toHaveBeenCalledWith("App draft", undefined,
      { injectHint: "queue", inputOrigin: "queue-auto", appSource: SOURCE });
  });

  it("passes an edited queued app item to guide flush with its source and no keyboard intent", async () => {
    const s = setup({ streaming: true });
    s.send();
    const store = s.result.current.queue.messageQueueStore;
    act(() => { store.update(store.getPending()[0].id, "Edited app draft"); });
    await s.emit({ type: "tool_end", name: "read_file", result: "done" });
    expect(s.inject).toHaveBeenCalledWith("Edited app draft", undefined, SOURCE);
    expect(store.getItems()[0]).toMatchObject({ appSource: SOURCE, handedOffAs: "Edited app draft" });
    expect(s.onAsk).not.toHaveBeenCalled();
  });

  it("retains app provenance when refused guidance drains after turn completion", async () => {
    const s = setup({ streaming: true, guideAccepted: false });
    s.send();
    await s.emit({ type: "tool_end", name: "read_file", result: "done" });
    await s.emit({ type: "done" });
    expect(s.onAsk).toHaveBeenCalledWith("App draft", undefined,
      { injectHint: "queue", inputOrigin: "queue-auto", appSource: SOURCE });
  });

  it("marks a mixed user and app batch as app-authored on auto drain", async () => {
    const s = setup({ streaming: true });
    act(() => { s.result.current.queue.messageQueueStore.add("User text"); });
    s.send();
    await s.emit({ type: "done" });
    expect(s.onAsk).toHaveBeenCalledWith(expect.stringContaining("App draft"), undefined,
      { injectHint: "queue", inputOrigin: "queue-auto", appSource: SOURCE });
    expect(s.onAsk.mock.calls[0][0]).toContain("User text");
  });

  it("carries app provenance when a queued item is sent immediately", () => {
    const s = setup({ streaming: true });
    s.send();
    act(() => s.result.current.queue.handleMessageQueueSendNow(s.result.current.queue.messageQueueStore.getPending()[0]));
    expect(s.onAsk).toHaveBeenCalledWith("App draft", expect.anything(), { injectHint: "interrupt", appSource: SOURCE });
  });

  it("carries the composer snapshot through the guide shortcut", async () => {
    const s = setup({ streaming: true });
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })));
    expect(s.inject).toHaveBeenCalledWith("App draft", undefined, SOURCE);
    expect(s.result.current.draft).toEqual({ text: "" });
  });

  it("does not clear a newer same-text draft from another app after guide acceptance", async () => {
    const reply = deferred<{ ok: true }>();
    const s = setup({ streaming: true });
    s.inject.mockImplementationOnce(() => reply.promise);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })));
    act(() => s.result.current.setDraft({ text: "App draft", appSource: "app:other" }));
    await act(async () => { reply.resolve({ ok: true }); await reply.promise; });
    expect(s.result.current.draft).toEqual({ text: "App draft", appSource: "app:other" });
  });

  it("does not clear a replacement with identical text and source after guide acceptance", async () => {
    const reply = deferred<{ ok: true }>();
    const s = setup({ streaming: true });
    s.inject.mockImplementationOnce(() => reply.promise);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, cancelable: true })));
    act(() => s.result.current.setDraft({ ...s.result.current.draft }));
    const replacement = s.result.current.draft;
    await act(async () => { reply.resolve({ ok: true }); await reply.promise; });
    expect(s.result.current.draft).toBe(replacement);
    expect(s.result.current.draft).toEqual({ text: "App draft", appSource: SOURCE });
  });

  it("carries selected app provenance when interrupting with later user text", () => {
    const s = setup({ streaming: true });
    s.send();
    const store = s.result.current.queue.messageQueueStore;
    act(() => { store.toggleSelect(store.getPending()[0].id); s.result.current.setQuestion("Additional text"); });
    act(() => s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(s.onAsk).toHaveBeenCalledWith("App draft\nAdditional text", expect.anything(), { injectHint: "interrupt", appSource: SOURCE });
    expect(s.interceptSubmit).not.toHaveBeenCalled();
  });
});
