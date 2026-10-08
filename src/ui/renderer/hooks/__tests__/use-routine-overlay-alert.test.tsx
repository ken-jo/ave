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
 * turn. A card main withdrew must leave the queue, not just the lookup. What
 * the user did with a card is reported back, so main keeps its identity
 * closed, and cards staged before the window listened are pulled on mount.
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

function pendingSnapshot() {
  let resolve!: (cards: OverlayItem[]) => void;
  const promise = new Promise<OverlayItem[]>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(staged: OverlayItem[] | Promise<OverlayItem[]> = []) {
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
    alerts: {
      cardClosed: vi.fn(async () => ({ ok: true })),
      listOpen: vi.fn(async () => staged),
    },
  };
  const ask = vi.fn();
  const insertImportedTriggerEntry = vi.fn();
  const registry = {
    read: vi.fn((id: string) => (id === TILE ? { ask, insertImportedTriggerEntry } : undefined)),
    readTiles: vi.fn(() => []),
  };
  const hook = renderHook(({ activeApi }) =>
    useRoutineOverlay({
      api: activeApi as never,
      t: ((key: string) => key) as never,
      locale: "en",
      registry: registry as never,
      onNavigateToSettings: vi.fn(),
    }), { initialProps: { activeApi: api } });
  const queueDismiss = vi.fn();
  hook.result.current.dismissRef.current = queueDismiss;
  const queueAdd = vi.fn();
  hook.result.current.addFireRef.current = queueAdd;
  return {
    hook,
    api,
    queueAdd,
    ask,
    insertImportedTriggerEntry,
    queueDismiss,
    reconnect: (snapshot: Promise<OverlayItem[]>) => hook.rerender({ activeApi: {
      ...api, alerts: { ...api.alerts, listOpen: vi.fn(async () => snapshot) },
    } }),
    show: (item: OverlayItem) => act(() => showOverlay?.(item)),
    mainDismiss: (id: string) => act(() => dismissOverlay?.(id)),
  };
}

describe("useRoutineOverlay — alert cards", () => {
  it("does not resurrect a withdrawn card when an older snapshot arrives afterwards", async () => {
    const snapshot = pendingSnapshot();
    const s = setup(snapshot.promise);
    s.mainDismiss(ALERT.id);
    const untouched = { ...ALERT, id: "alert:other", source: { ...ALERT.source, alertId: "other" } } as OverlayItem;
    await act(async () => { snapshot.resolve([ALERT, untouched]); await snapshot.promise; });
    expect(s.queueAdd.mock.calls).toEqual([[untouched]]);
    expect(s.queueDismiss).toHaveBeenCalledWith(ALERT.id);
    await act(async () => { await s.hook.result.current.handlePluginPrimaryAction(ALERT.id, TILE); });
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.insertImportedTriggerEntry).not.toHaveBeenCalled();
  });

  it("keeps a live refresh instead of overwriting it with an older snapshot", async () => {
    const snapshot = pendingSnapshot();
    const s = setup(snapshot.promise);
    const refreshed = { ...ALERT, summary: "Updated summary", pendingPrompt: "Updated prompt" };
    s.show(refreshed);
    await act(async () => { snapshot.resolve([ALERT]); await snapshot.promise; });
    expect(s.queueAdd.mock.calls).toEqual([[refreshed]]);
    await act(async () => { await s.hook.result.current.handlePluginPrimaryAction(ALERT.id, TILE); });
    expect(s.ask).toHaveBeenCalledWith(refreshed.pendingPrompt, "trigger-import");
  });

  it.each(["accepted", "dismissed"] as const)("does not restore a card the user %s while a new snapshot was pending", async (reason) => {
    const s = setup([ALERT]);
    await act(async () => { await Promise.resolve(); });
    s.queueAdd.mockClear();
    const snapshot = pendingSnapshot();
    s.reconnect(snapshot.promise);
    await act(async () => {
      if (reason === "accepted") await s.hook.result.current.handlePluginPrimaryAction(ALERT.id, TILE);
      else s.hook.result.current.handleAlertDismiss(ALERT.id);
    });
    expect(s.api.alerts.cardClosed).toHaveBeenCalledWith("abc", reason);
    s.ask.mockClear();
    s.insertImportedTriggerEntry.mockClear();
    await act(async () => { snapshot.resolve([ALERT]); await snapshot.promise; });
    expect(s.queueAdd).not.toHaveBeenCalled();
    await act(async () => { await s.hook.result.current.handlePluginPrimaryAction(ALERT.id, TILE); });
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.insertImportedTriggerEntry).not.toHaveBeenCalled();
  });

  it("allows a fresh show after withdrawal without reviving the withdrawn snapshot", async () => {
    const snapshot = pendingSnapshot();
    const s = setup(snapshot.promise);
    s.mainDismiss(ALERT.id);
    const reopened = { ...ALERT, pendingPrompt: "Reopened prompt" };
    s.show(reopened);
    await act(async () => { snapshot.resolve([ALERT]); await snapshot.promise; });
    expect(s.queueAdd.mock.calls).toEqual([[reopened]]);
    await act(async () => { await s.hook.result.current.handlePluginPrimaryAction(ALERT.id, TILE); });
    expect(s.ask).toHaveBeenCalledWith(reopened.pendingPrompt, "trigger-import");
  });

  it("ignores a snapshot from a disposed subscription", async () => {
    const snapshot = pendingSnapshot();
    const s = setup(snapshot.promise);
    s.hook.unmount();
    await act(async () => { snapshot.resolve([ALERT]); await snapshot.promise; });
    expect(s.queueAdd).not.toHaveBeenCalled();
  });

  it("records host provenance while retaining the staged turn and close acknowledgement", async () => {
    const s = setup();
    s.show({ ...ALERT, source: { kind: "alert", pluginId: "@host", kindId: "due-soon", alertId: "abc" } });
    await act(async () => { await s.hook.result.current.handlePluginPrimaryAction("alert:abc", TILE); });
    expect(s.insertImportedTriggerEntry).toHaveBeenCalledWith(expect.objectContaining({ source: "host:due-soon" }));
    expect(s.ask).toHaveBeenCalledWith(ALERT.pendingPrompt, "trigger-import");
    expect(s.api.alerts.cardClosed).toHaveBeenCalledWith("abc", "accepted");
  });
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

  it("reports an accepted card, so main closes its identity", async () => {
    const s = setup();
    s.show(ALERT);
    await act(async () => {
      await s.hook.result.current.handlePluginPrimaryAction("alert:abc", TILE);
    });
    expect(s.api.alerts.cardClosed).toHaveBeenCalledWith("abc", "accepted");
  });

  it("reports a card the user dismissed, and only an alert card", async () => {
    const s = setup();
    s.show(ALERT);
    s.show({ ...ALERT, id: "plugin:x", source: { kind: "plugin", pluginId: "fixturemail", eventId: "x" } });
    act(() => {
      s.hook.result.current.handleAlertDismiss("alert:abc");
      s.hook.result.current.handleAlertDismiss("plugin:x");
    });
    expect(s.api.alerts.cardClosed).toHaveBeenCalledTimes(1);
    expect(s.api.alerts.cardClosed).toHaveBeenCalledWith("abc", "dismissed");
  });

  it("pulls the cards main staged before the window listened", async () => {
    const s = setup([ALERT]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(s.api.alerts.listOpen).toHaveBeenCalledTimes(1);
    expect(s.queueAdd).toHaveBeenCalledWith(ALERT);
    await act(async () => {
      await s.hook.result.current.handlePluginPrimaryAction("alert:abc", TILE);
    });
    expect(s.ask).toHaveBeenCalledWith(ALERT.pendingPrompt, "trigger-import");
  });
});
