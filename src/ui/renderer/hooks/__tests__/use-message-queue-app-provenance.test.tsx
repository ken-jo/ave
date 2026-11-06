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
  const hook = renderHook(() => {
    const [draft, setDraft] = useState<{ text: string; appSource?: string }>({ text: "App draft", appSource: SOURCE });
    const setQuestion = useCallback<UseMessageQueueParams["setQuestion"]>((change) => setDraft((previous) => {
      const text = typeof change === "function" ? change(previous.text) : change;
      return { text, ...(text && previous.appSource ? { appSource: previous.appSource } : {}) };
    }), []);
    const composerRef = useRef({ textarea: () => textarea } as ComposerHandle);
    const queue = useMessageQueue({ surface: "main", subscribeStream, composerRef,
      currentSessionId: "chat", question: draft.text, appSource: draft.appSource, draftIdentity: draft, attachments: [], streaming,
      setQuestion, setAttachments: vi.fn(), onAsk, onAbort: vi.fn(), interceptSubmit,
      guide: { inject, onError: vi.fn() },
    });
    return { queue, draft, setQuestion, setDraft };
  });
  return { ...hook, onAsk, inject, interceptSubmit, textarea,
    emit: async (event: ChatStreamEvent) => { await act(async () => emit(event)); },
    send: () => act(() => hook.result.current.queue.handleComposerSend(INTENT)),
  };
}

afterEach(() => { document.querySelectorAll("textarea").forEach((node) => node.remove()); });

describe("queued app provenance", () => {
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
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })));
    expect(s.inject).toHaveBeenCalledWith("App draft", undefined, SOURCE);
    expect(s.result.current.draft).toEqual({ text: "" });
  });

  it("does not clear a newer same-text draft from another app after guide acceptance", async () => {
    const reply = deferred<{ ok: true }>();
    const s = setup({ streaming: true });
    s.inject.mockImplementationOnce(() => reply.promise);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })));
    act(() => s.result.current.setDraft({ text: "App draft", appSource: "app:other" }));
    await act(async () => { reply.resolve({ ok: true }); await reply.promise; });
    expect(s.result.current.draft).toEqual({ text: "App draft", appSource: "app:other" });
  });

  it("does not clear a replacement with identical text and source after guide acceptance", async () => {
    const reply = deferred<{ ok: true }>();
    const s = setup({ streaming: true });
    s.inject.mockImplementationOnce(() => reply.promise);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true })));
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
    act(() => s.textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
    expect(s.onAsk).toHaveBeenCalledWith("App draft\nAdditional text", expect.anything(), { injectHint: "interrupt", appSource: SOURCE });
    expect(s.interceptSubmit).not.toHaveBeenCalled();
  });
});
