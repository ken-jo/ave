import { describe, expect, it, vi, afterEach } from "vitest";
import { createNotificationHistory, notificationCounts } from "../notification-history.js";

afterEach(() => vi.useRealTimers());

describe("notification history", () => {
  it("adds newest first, reads and clears independently of approval counts", () => {
    const history = createNotificationHistory();
    const listener = vi.fn();
    const unsubscribe = history.subscribe(listener);
    const first = history.push({ severity: "info", message: "Installed" });
    history.push({ severity: "error", message: "Failed" });
    expect(history.getSnapshot().map((item) => item.message)).toEqual(["Failed", "Installed"]);
    expect(notificationCounts(history.getSnapshot(), 3)).toEqual({ unread: 2, total: 5, error: true });
    history.markRead();
    expect(notificationCounts(history.getSnapshot(), 3)).toEqual({ unread: 0, total: 3, error: false });
    history.clear(first);
    expect(history.getSnapshot()).toHaveLength(1);
    history.clearAll();
    expect(history.getSnapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
    history.push({ severity: "info", message: "Later" });
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("caps at the latest fifty records, including error bursts", () => {
    const history = createNotificationHistory();
    for (let index = 0; index < 75; index++) history.push({ severity: "error", message: String(index) });
    expect(history.getSnapshot()).toHaveLength(50);
    expect(history.getSnapshot()[0]?.message).toBe("74");
    expect(history.getSnapshot()[49]?.message).toBe("25");
    expect(notificationCounts(history.getSnapshot(), 0).unread).toBe(50);
  });

  it("reads arrivals while open and counts new errors after closing", () => {
    const history = createNotificationHistory();
    history.setOpen(true);
    history.push({ severity: "error", message: "Read immediately" });
    expect(notificationCounts(history.getSnapshot(), 0)).toEqual({ unread: 0, total: 0, error: false });
    history.setOpen(false);
    const id = history.push({ severity: "error", message: "Unread" });
    expect(notificationCounts(history.getSnapshot(), 0).error).toBe(true);
    history.clear(id);
    expect(notificationCounts(history.getSnapshot(), 0).error).toBe(false);
  });

  it("upserts a subject as a new arrival with its latest action", () => {
    vi.useFakeTimers();
    const history = createNotificationHistory();
    history.upsert("install:plugin:sample", { severity: "error", message: "Failed" });
    history.markRead();
    vi.advanceTimersByTime(10_000);
    const run = vi.fn();
    history.upsert("install:plugin:sample", { severity: "success", message: "Installed", action: { label: "Details", run } });
    expect(history.getSnapshot()).toHaveLength(1);
    expect(history.getSnapshot()[0]).toMatchObject({ message: "Installed", read: false });
    history.getSnapshot()[0]?.action?.run();
    expect(run).toHaveBeenCalledOnce();
    expect(createNotificationHistory().getSnapshot()).toEqual([]);
  });

  it("deduplicates restored identities without changing read state, arrival or announcement", () => {
    const history = createNotificationHistory();
    history.receive("notification:main:1", { severity: "info", message: "Boot", createdAt: 1000 });
    const announcement = history.getLatestPolite();
    history.markRead();
    const snapshot = history.getSnapshot();
    history.receive("notification:main:1", { severity: "info", message: "Boot", createdAt: 1000 });
    expect(history.getSnapshot()).toBe(snapshot);
    expect(history.getSnapshot()[0]).toMatchObject({ read: true, createdAt: 1000 });
    expect(history.getLatestPolite()).toBe(announcement);
    history.clearAll();
    history.receive("notification:main:1", { severity: "info", message: "Boot", createdAt: 1000 });
    expect(history.getSnapshot()).toHaveLength(0);
  });

  it.each(["approval", "ask-user"] as const)("refuses card requests of kind %s", (kind) => {
    const history = createNotificationHistory();
    history.push({ severity: "info", message: "Card", notification: { kind } });
    expect(history.getSnapshot()).toEqual([]);
    expect(history.getLatest()).toBeNull();
  });
});
