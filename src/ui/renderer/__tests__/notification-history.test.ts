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

  it("retains the newest original arrival times regardless of replay delivery order", () => {
    const history = createNotificationHistory();
    for (let index = 60; index > 0; index--) {
      history.receive(`notification:main:${index}`, { severity: "info", message: String(index), createdAt: index });
    }
    expect(history.getSnapshot().map((item) => item.createdAt)).toEqual(Array.from({ length: 50 }, (_, index) => 60 - index));
  });

  it("orders equal arrival times by stable identity independently of delivery order", () => {
    const ids = ["notification:main:2", "notification:main:10", "notification:main:9", "notification:main:02"];
    const snapshots = [ids, ids.toReversed()].map((delivery) => {
      const history = createNotificationHistory();
      for (const id of delivery) history.receive(id, { severity: "info", message: id, createdAt: 1000 });
      return history.getSnapshot().map((item) => item.id);
    });
    expect(snapshots[0]).toEqual(["notification:main:10", "notification:main:9", "notification:main:2", "notification:main:02"]);
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  it("caps hidden banner history and preserves every still-showing banner", () => {
    const history = createNotificationHistory();
    history.upsertBanner("banner:older", { severity: "error", message: "Older banner", createdAt: 1 });
    history.upsertBanner("banner:current", { severity: "warning", message: "Current banner", createdAt: 100 });
    for (let index = 2; index < 77; index++) history.push({ severity: "info", message: String(index), createdAt: index });
    expect(history.getSnapshot()).toHaveLength(52);
    expect(history.getSnapshot()[0]?.id).toBe("banner:current");
    expect(history.getSnapshot().at(-1)?.id).toBe("banner:older");
    history.hideBanner("banner:older");
    expect(history.getSnapshot()).toHaveLength(51);
    expect(notificationCounts(history.getSnapshot(), 0).error).toBe(false);
    history.hideBanner("banner:current");
    expect(history.getSnapshot()).toHaveLength(50);
    expect(history.getSnapshot()[0]?.id).toBe("banner:current");
    expect(history.getSnapshot().at(-1)?.createdAt).toBe(28);
  });

  it("restores a suspended banner without a new arrival or unread announcement", () => {
    const history = createNotificationHistory();
    history.upsertBanner("banner:older", { severity: "error", message: "Older banner", createdAt: 1 });
    history.markRead();
    const banner = history.getSnapshot()[0];
    if (!banner) throw new Error("Expected the showing banner");
    for (let index = 2; index < 52; index++) history.push({ severity: "info", message: String(index), createdAt: index });
    const latest = history.getLatest();
    const announcement = history.getLatestError();
    const snapshot = history.getSnapshot();
    history.hideBanner(banner.id);
    expect(history.getSnapshot().some((item) => item.id === banner.id)).toBe(false);
    history.restoreBanner(banner.id, snapshot);
    expect(history.getSnapshot().at(-1)).toBe(banner);
    expect(history.getLatest()).toBe(latest);
    expect(history.getLatestError()).toBe(announcement);
    expect(notificationCounts(history.getSnapshot(), 0)).toEqual({ unread: 50, total: 50, error: false });
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
