// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoutineOverlay } from "../use-routine-overlay.js";
import type { OverlayItem } from "../../context/OverlayContext.js";

/**
 * Confirming an alert card from the renderer.
 *
 * An alert carries a host-rendered prompt inside the same staged envelope a
 * plugin's overlay trigger uses, so confirming it must travel the same
 * `imported_trigger` path with the plugin's provenance — never a plain user
 * turn. A card main withdrew must leave the queue, not just the lookup.
 */
const TILE = "group-1";

const ALERT: OverlayItem = {
  id: "alert:abc",
  source: { kind: "alert", pluginId: "fixturemail", kindId: "reply", alertId: "abc" },
  title: "Mail needing a reply",
  summary: "Someone wrote: a subject",
  running: false,
  pendingPrompt: "<imported-from-proactive>Help me answer.</imported-from-proactive>",
  priority: "high",
  createdAt: "2026-09-26T00:00:00.000Z",
};

function setup() {
  let showOverlay: ((item: OverlayItem) => void) | undefined;
  let dismissOverlay: ((id: string) => void) | undefined;
  const api = {
    onRoutineRunningStarted: vi.fn(() => () => {}),
    onRoutineRunningFinished: vi.fn(() => () => {}),
    onRoutineFailed: vi.fn(() => () => {}),
    onRoutineFired: vi.fn(() => () => {}),
    listPendingRoutineResults: vi.fn(async () => []),
    acknowledgeRoutineResult: vi.fn(async () => undefined),
    onOverlayShow: vi.fn((handler: (item: OverlayItem) => void) => {
      showOverlay = handler;
      return () => {};
    }),
    onOverlayDismiss: vi.fn((handler: (id: string) => void) => {
      dismissOverlay = handler;
      return () => {};
    }),
  };
  const ask = vi.fn();
  const insertImportedTriggerEntry = vi.fn();
  const registry = {
    read: vi.fn((id: string) => (id === TILE ? { ask, insertImportedTriggerEntry } : undefined)),
    readTiles: vi.fn(() => []),
  };
  const hook = renderHook(() =>
    useRoutineOverlay({
      api: api as never,
      t: ((key: string) => key) as never,
      locale: "en",
      registry: registry as never,
      onNavigateToSettings: vi.fn(),
    }));
  const queueDismiss = vi.fn();
  hook.result.current.dismissRef.current = queueDismiss;
  return {
    hook,
    ask,
    insertImportedTriggerEntry,
    queueDismiss,
    show: (item: OverlayItem) => act(() => showOverlay?.(item)),
    mainDismiss: (id: string) => act(() => dismissOverlay?.(id)),
  };
}

describe("useRoutineOverlay — alert cards", () => {
  it("inserts a confirmed alert as the plugin's imported trigger and starts the tile's turn", async () => {
    const s = setup();
    s.show(ALERT);
    await act(async () => {
      await s.hook.result.current.handlePluginPrimaryAction("alert:abc", TILE);
    });
    expect(s.insertImportedTriggerEntry).toHaveBeenCalledWith({
      sessionId: "abc",
      source: "plugin:fixturemail",
      prompt: ALERT.pendingPrompt,
      summary: ALERT.summary,
    });
    expect(s.ask).toHaveBeenCalledWith(ALERT.pendingPrompt, "trigger-import");
  });

  it("removes a card main withdrew from the queue, and a later confirm does nothing", async () => {
    const s = setup();
    s.show(ALERT);
    s.mainDismiss("alert:abc");
    expect(s.queueDismiss).toHaveBeenCalledWith("alert:abc");
    await act(async () => {
      await s.hook.result.current.handlePluginPrimaryAction("alert:abc", TILE);
    });
    expect(s.insertImportedTriggerEntry).not.toHaveBeenCalled();
    expect(s.ask).not.toHaveBeenCalled();
  });
});
