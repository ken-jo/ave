// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoutineOverlay } from "../use-routine-overlay.js";
import type { OverlayItem } from "../../context/OverlayContext.js";

function setup(sessionId: string, newChatAccepted = true) {
  let show!: (item: OverlayItem) => void;
  const stageAppMessage = vi.fn();
  const ask = vi.fn();
  const startNewChat = vi.fn(async () => newChatAccepted);
  const addFire = vi.fn();
  const api = {
    onRoutineRunningStarted: () => () => {}, onRoutineRunningFinished: () => () => {},
    onRoutineFailed: () => () => {}, onRoutineFired: () => () => {},
    listPendingRoutineResults: async () => [],
    onOverlayShow: (handler: typeof show) => { show = handler; return () => {}; },
    onOverlayDismiss: () => () => {},
  };
  const registry = {
    read: vi.fn((id: string) => id === "focused" ? { currentSessionId: sessionId, stageAppMessage, startNewChat, ask } : undefined),
  };
  const hook = renderHook(() => useRoutineOverlay({ api: api as never, registry: registry as never,
    t: ((key: string) => key) as never, locale: "en", onNavigateToSettings: vi.fn(), onSuggestionStaged: vi.fn(),
    getFocusedChatGroupId: () => "focused",
  }));
  hook.result.current.addFireRef.current = addFire;
  const item: OverlayItem = { id: "app:fixture:1", source: { kind: "app", serverId: "fixture", eventId: "1" },
    title: "fixture", summary: "Review this", running: false, createdAt: "2026-11-06T00:00:00Z", composerDraft: true,
    pendingPrompt: '<app-message source="app:fixture">\nReview this\n</app-message>',
  };
  return { show: async () => { await act(async () => show(item)); }, stageAppMessage, startNewChat, ask, addFire };
}

describe("panel app drafts", () => {
  it("fills the focused conversation composer without sending or adding an overlay card", async () => {
    const s = setup("current");
    await s.show();
    expect(s.stageAppMessage).toHaveBeenCalledWith("Review this", "app:fixture");
    expect(s.startNewChat).not.toHaveBeenCalled();
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.addFire).not.toHaveBeenCalled();
  });
  it("opens a new conversation before staging when no conversation is open", async () => {
    const s = setup("");
    await s.show();
    expect(s.startNewChat).toHaveBeenCalledWith(undefined, { draft: "Review this", appSource: "app:fixture" });
    expect(s.stageAppMessage).not.toHaveBeenCalled();
    expect(s.ask).not.toHaveBeenCalled();
  });
  it("does not stage into a conversation when opening it was refused", async () => {
    const s = setup("", false);
    await s.show();
    expect(s.stageAppMessage).not.toHaveBeenCalled();
    expect(s.ask).not.toHaveBeenCalled();
  });
});
