import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { clearQueueStoreHandle, deferred, getQueueStore, submitChatMessage } from "../../../../test/renderer/helpers.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";

describe("ChatView message queue (enqueue while streaming → drains after)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearQueueStoreHandle();
  });

  it("enqueues an Enter submit during streaming (no new chatSend) and drains it as queue-auto on done", async () => {
    const pendingSend = deferred<{ ok: true }>();
    const { container, api, emitChatStream } = await renderApp({
      hasApiKey: true,
      // dev+e2e exposes the live message-queue store on window so the enqueue step can be asserted directly against store state.
      aveEnv: { isDev: true, isE2E: true },
    });

    // First turn: keep chatSend pending so streaming stays true while we type the second message.
    api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
    await submitChatMessage(container, "첫 질문");
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="work-group"]')?.textContent).toContain("생각 중...");
    });

    await waitFor(() => expect(getQueueStore()).toBeDefined());

    // Second Enter while streaming → enqueued, NOT sent.
    await submitChatMessage(container, "대기 중 추가 요청");
    await waitFor(() => expect(getQueueStore()!.size()).toBe(1));
    expect(api.chatSend).toHaveBeenCalledTimes(1);

    // Stream done → queue drains as a fresh turn with inputOrigin "queue-auto".
    await act(async () => {
      emitChatStream({ type: "done" });
    });

    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    const drainCall = api.chatSend.mock.calls[1];
    expect(drainCall[0]).toContain("대기 중 추가 요청");
    expect(drainCall[2]).toBe("queue-auto");
    // Queue emptied by the drain.
    expect(getQueueStore()!.size()).toBe(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("does not enqueue when idle — an Enter submit sends immediately", async () => {
    const { container, api } = await renderApp({
      hasApiKey: true,
      aveEnv: { isDev: true, isE2E: true },
    });
    await waitFor(() => expect(getQueueStore()).toBeDefined());

    await submitChatMessage(container, "즉시 전송");

    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(1));
    expect(api.chatSend.mock.calls[0][0]).toContain("즉시 전송");
    expect(getQueueStore()!.size()).toBe(0);
  });
});

describe("ChatView ⌘K guide", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the guide IPC with the composer text and clears it on success", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector(testIdSelector(TEST_IDS.composerTextarea)) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "다음 라운드에서 표를 만들어줘" } });
    });

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "k", code: "KeyK", metaKey: true });
    });

    await waitFor(() => {
      expect(api.chatGuide).toHaveBeenCalledWith("다음 라운드에서 표를 만들어줘");
    });
    await waitFor(() => expect(textarea.value).toBe(""));
  });

  it("is a no-op when the composer is empty (guide IPC not called)", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector(testIdSelector(TEST_IDS.composerTextarea)) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "k", code: "KeyK", ctrlKey: true });
    });

    // Give any async guide dispatch a tick to (not) happen.
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.chatGuide).not.toHaveBeenCalled();
  });

  it("does not route global guide shortcuts through an approval dock covering this composer", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    const textarea = container.querySelector(testIdSelector(TEST_IDS.composerTextarea)) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "keep this draft" } });
    const dock = document.createElement("section");
    dock.dataset.testid = "approval-dock";
    // The card that covers THIS composer lives in the composer's own surface; one in another surface is not its business (see
    // blockingSurfaceCovers).
    textarea.closest("[data-approval-scope]")!.append(dock);

    try {
      fireEvent.keyDown(textarea, { key: "k", code: "KeyK", ctrlKey: true });
      await act(async () => {
        await Promise.resolve();
      });
      expect(api.chatGuide).not.toHaveBeenCalled();
      expect(textarea.value).toBe("keep this draft");
    } finally {
      dock.remove();
    }
  });
});


describe("automatic compaction notice surface", () => {
  it("renders failure in the owning transcript while the answer continues", async () => {
    const { container, emitChatStream } = await renderApp({ hasApiKey: true });
    await act(async () => {
      emitChatStream({ type: "compact_started", streamId: 1 });
      emitChatStream({ type: "compact_failed", streamId: 1 });
      emitChatStream({ type: "text_delta", text: "Usable chat answer", streamId: 1 });
      emitChatStream({ type: "done", streamId: 1 });
    });
    const notice = [...container.querySelectorAll('[data-testid="system-entry"]')].find((element) => /압축|compaction/.test(element.textContent ?? ""));
    expect(notice).toBeDefined();
    expect(notice!.closest('[data-testid="chat-transcript-log"]')).not.toBeNull();
    expect(notice!.closest('[data-testid="composer-toast-dock"]')).toBeNull();
    expect(container.textContent).toContain("Usable chat answer");
  });
});
