/** Remove queued text only after guide acceptance; a refused mid-turn handoff must preserve it. */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { clearQueueStoreHandle, deferred, getQueueStore, submitChatMessage } from "../../../../test/renderer/helpers.js";

async function queueOneWhileStreaming() {
  const pendingSend = deferred<{ ok: true }>();
  const harness = await renderApp({
    hasApiKey: true,
    aveEnv: { isDev: true, isE2E: true },
  });
  harness.api.chatSend.mockImplementationOnce(async () => pendingSend.promise);
  await submitChatMessage(harness.container, "첫 질문");
  await waitFor(() => expect(harness.api.chatSend).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(getQueueStore()).toBeDefined());

  await submitChatMessage(harness.container, "대기 중 추가 요청");
  await waitFor(() => expect(getQueueStore()!.size()).toBe(1));
  return { ...harness, pendingSend };
}

describe("message queue — mid-turn tool_end drain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearQueueStoreHandle();
  });

  it("keeps the row visible after the hand-off, until the engine delivers it", async () => {
    const { emitChatStream, api, container, pendingSend } = await queueOneWhileStreaming();

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));
    const handedText = api.chatGuide.mock.calls[0]![0] as string;

    // Accepted — but the engine holds guidance until its next round boundary, so the transcript does not have it yet. The row
    // must not vanish into that gap; it stays, marked.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="message-queue-row-handed-off"]')).not.toBeNull();
    });
    expect(getQueueStore()!.size()).toBe(1);
    expect(container.querySelector('[data-testid="message-queue-panel"]')).not.toBeNull();
    // It is no longer the user's to edit or re-inject.
    expect(container.querySelector('[data-testid="message-queue-row-edit-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="message-queue-row-send-now-button"]')).toBeNull();

    // Delivered — now it exists above, so the row goes.
    await act(async () => {
      emitChatStream({ type: "guidance_injected", text: handedText });
    });
    await waitFor(() => expect(getQueueStore()!.size()).toBe(0));

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("returns a hand-off the engine could not deliver, and sends it at turn end", async () => {
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));
    const handedText = api.chatGuide.mock.calls[0]![0] as string;

    // The turn ran out of rounds before the guidance could be applied.
    await act(async () => {
      emitChatStream({ type: "guidance_dropped", text: handedText });
      emitChatStream({ type: "done" });
    });

    // Released and re-sent as a fresh turn rather than stranded as delivered.
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    expect(api.chatSend.mock.calls[1]![0]).toContain("대기 중 추가 요청");
    expect(getQueueStore()!.size()).toBe(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("does not re-send a handed-off row when the turn ends", async () => {
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));

    // `done` arrives with the row still handed off — the engine already has this text, so sending it again would duplicate the
    // message.
    await act(async () => {
      emitChatStream({ type: "done" });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(api.chatSend).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("reserves rows until acceptance and keeps them visible until delivery", async () => {
    const guide = deferred<{ ok: true }>();
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();
    api.chatGuide.mockImplementationOnce(async () => guide.promise);

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));

    // Awaiting acceptance: visible and reserved, without claiming the engine has accepted it.
    expect(getQueueStore()!.size()).toBe(1);
    expect(getQueueStore()!.getItems()[0]!.handedOffAs).toBeUndefined();
    expect(getQueueStore()!.getItems()[0]!.handoffReservationId).toBeDefined();
    expect(getQueueStore()!.getPending()).toHaveLength(0);

    await act(async () => {
      guide.resolve({ ok: true });
      await Promise.resolve();
    });
    // Confirmed → marked, not removed. It leaves only on delivery.
    await waitFor(() => {
      expect(getQueueStore()!.getItems()[0]!.handedOffAs).toBeDefined();
    });
    expect(getQueueStore()!.getPending()).toHaveLength(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("keeps the queued text when the engine refuses the hand-off", async () => {
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();

    // The engine clears its abort controller in the turn's `finally`, so a brake point that lands in that window is answered
    // "no-active-turn".
    api.chatGuide.mockImplementationOnce(async () => ({ ok: false, error: "no-active-turn" }));

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));

    // Nothing was taken optimistically, so the text the user typed survives.
    expect(getQueueStore()!.size()).toBe(1);

    // Further brake points in the SAME turn do not retry — one toast, not one per tool.
    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t2", name: "read_file", result: "ok" });
      emitChatStream({ type: "tool_end", toolUseId: "t3", name: "read_file", result: "ok" });
    });
    expect(api.chatGuide).toHaveBeenCalledTimes(1);

    // The turn ends → the survivors go out as a fresh turn.
    await act(async () => {
      emitChatStream({ type: "done" });
    });
    await waitFor(() => expect(api.chatSend).toHaveBeenCalledTimes(2));
    expect(api.chatSend.mock.calls[1][0]).toContain("대기 중 추가 요청");
    expect(getQueueStore()!.size()).toBe(0);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("keeps the submitted wording fixed while the hand-off is in flight", async () => {
    const guide = deferred<{ ok: true }>();
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();
    api.chatGuide.mockImplementationOnce(async () => guide.promise);

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
    });
    await waitFor(() => expect(api.chatGuide).toHaveBeenCalledTimes(1));
    expect(api.chatGuide.mock.calls[0][0]).toContain("대기 중 추가 요청");

    // A reservation prevents the visible wording from diverging from the submitted batch.
    const queued = getQueueStore()!.getItems()[0]!;
    await act(async () => {
      expect(getQueueStore()!.update(queued.id, "고쳐 쓴 요청")).toBe(false);
    });

    await act(async () => {
      guide.resolve({ ok: true });
      await Promise.resolve();
    });

    // Accepted rows stay visible with exactly the wording the engine received.
    expect(getQueueStore()!.size()).toBe(1);
    expect(getQueueStore()!.getItems()[0]!.text).toBe("대기 중 추가 요청");
    expect(getQueueStore()!.getItems()[0]!.handedOffAs).toBe("대기 중 추가 요청");

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });

  it("does not send the same items twice when tool_end events burst", async () => {
    const guide = deferred<{ ok: true }>();
    const { emitChatStream, api, pendingSend } = await queueOneWhileStreaming();
    api.chatGuide.mockImplementationOnce(async () => guide.promise);

    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t1", name: "read_file", result: "ok" });
      emitChatStream({ type: "tool_end", toolUseId: "t2", name: "read_file", result: "ok" });
      emitChatStream({ type: "tool_end", toolUseId: "t3", name: "read_file", result: "ok" });
    });

    // Items now survive the first attempt, so without the in-flight guard the later brake points would hand the SAME text over
    // again.
    expect(api.chatGuide).toHaveBeenCalledTimes(1);

    await act(async () => {
      guide.resolve({ ok: true });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getQueueStore()!.getItems()[0]!.handedOffAs).toBeDefined();
    });

    // A brake point after the mark must not hand the same row over again — `getPending()` excludes it.
    await act(async () => {
      emitChatStream({ type: "tool_end", toolUseId: "t4", name: "read_file", result: "ok" });
    });
    expect(api.chatGuide).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSend.resolve({ ok: true });
      await Promise.resolve();
    });
  });
});
