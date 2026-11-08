import "../../../../test/renderer/setup.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "../../../../test/renderer/render-app.js";
import { TEST_IDS, testIdSelector } from "../../../shared/test-ids.js";
import { AccessibilitySignalEngine, setAccessibilitySignalEngineForTest } from "../accessibility-signal-engine.js";
import type { AccessibilitySignalId } from "../../../shared/accessibility-signals.js";

afterEach(() => {
  setAccessibilitySignalEngineForTest(null);
  vi.restoreAllMocks();
});

/** The window is in the background, so the default "when unfocused" turn-finished signal plays for an agent's turn. */
async function renderBackgroundApp() {
  const play = vi.fn(async (_id: AccessibilitySignalId) => {});
  setAccessibilitySignalEngineForTest(new AccessibilitySignalEngine({ isWindowFocused: () => false, play }));
  const app = await renderApp({ hasApiKey: true });
  const textarea = await waitFor(() => {
    const field = app.container.querySelector<HTMLTextAreaElement>(testIdSelector(TEST_IDS.composerTextarea));
    if (!field) throw new Error("composer textarea not rendered");
    return field;
  });
  // A send that stays in flight keeps the turn running, as a real turn does until its stream closes.
  app.api.chatSend.mockImplementation(() => new Promise(() => {}));
  const send = async (text: string) => {
    fireEvent.change(textarea, { target: { value: text } });
    const button = await waitFor(() => {
      const element = app.container.querySelector<HTMLButtonElement>('[data-testid="composer-send-button"]');
      if (!element) throw new Error("send button not rendered");
      return element;
    });
    await act(async () => { fireEvent.click(button); });
  };
  const startTurn = async () => {
    await send("first");
    await act(async () => { app.emitChatStream({ type: "text_delta", streamId: 1, text: "partial answer" }); });
    return waitFor(() => {
      const stop = app.container.querySelector<HTMLButtonElement>('[data-testid="composer-cancel-button"]');
      if (!stop) throw new Error("stop button not rendered");
      return stop;
    });
  };
  return { ...app, play, send, startTurn };
}

describe("ChatGroupSession accessibility signals", () => {
  it("still hears a turn whose stop never reached the host", async () => {
    const app = await renderBackgroundApp();
    (app.api as unknown as { chatAbort: () => Promise<unknown> }).chatAbort = vi.fn(async () => { throw new Error("ipc channel closed"); });
    const stop = await app.startTurn();
    await act(async () => { fireEvent.click(stop); });
    await act(async () => { app.emitChatStream({ type: "done", streamId: 1 }); });
    expect(app.play.mock.calls).toEqual([["turnFinished"]]);
  });
});
