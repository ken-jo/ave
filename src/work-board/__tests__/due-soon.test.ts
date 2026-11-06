/** Scan a half-open deadline window; the host owns delivery decisions. */
import { describe, it, expect, vi } from "vitest";
import { scanAndRaiseDueSoon, startDueSoonScans, DUE_SOON_TICK_MS, DUE_SOON_WINDOW_MS, type DueSoonBoardReader } from "../due-soon.js";
import { ALERT_KIND_COOLDOWN_MS } from "../../alerts/gate.js";
import type { WorkItem, WorkItemResolved } from "../../shared/work-board-types.js";
import { okListReader } from "./board-test-fixtures.js";

const raiseAlert = async () => ({ status: "disabled_by_user" as const });

const NOW = Date.parse("2026-06-16T00:00:00.000Z");

function item(partial: Partial<WorkItem> & { id: number }): WorkItemResolved {
  const base: WorkItem = {
    title: `item ${partial.id}`,
    status: "planned",
    priority: "medium",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
  return { ...base, status_resolved: base.status };
}

describe("scanAndRaiseDueSoon", () => {
  it("propagates delivery exceptions and retries on the next scan", async () => {
    const store = okListReader([item({ id: 1, due_at: new Date(NOW + 60_000).toISOString() })]);
    await expect(scanAndRaiseDueSoon(store, NOW, async () => { throw new Error("delivery failed"); }))
      .rejects.toThrow("delivery failed");
    const raise = vi.fn(raiseAlert);
    await scanAndRaiseDueSoon(store, NOW, raise);
    expect(raise).toHaveBeenCalledOnce();
  });

  it("raises the same deadline on every scan with its remaining lifetime", async () => {
    const dueAt = new Date(NOW + 60 * 60_000).toISOString();
    const store = okListReader([item({ id: 7, title: "Report", due_at: dueAt })]);
    const raise = vi.fn(raiseAlert);
    await scanAndRaiseDueSoon(store, NOW, raise);
    await scanAndRaiseDueSoon(store, NOW + 5 * 60_000, raise);
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenNthCalledWith(1, {
      kind: "due-soon", key: `7:${dueAt}`, slots: { title: "Report", itemId: "7" }, ttlMs: 60 * 60_000,
    });
    expect(raise).toHaveBeenNthCalledWith(2, {
      kind: "due-soon", key: `7:${dueAt}`, slots: { title: "Report", itemId: "7" }, ttlMs: 55 * 60_000,
    });
  });

  it("bounds a title by code points before entering the slot validator", async () => {
    const raise = vi.fn(raiseAlert);
    await scanAndRaiseDueSoon(okListReader([item({
      id: 7, title: "😀".repeat(250), due_at: new Date(NOW + 60_000).toISOString(),
    })]), NOW, raise);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ slots: { title: "😀".repeat(200), itemId: "7" } }));
  });

  it("includes the lower boundary and excludes completed, invalid, undated and out-of-window items", async () => {
    const raise = vi.fn(raiseAlert);
    await scanAndRaiseDueSoon(okListReader([
      item({ id: 1 }),
      item({ id: 2, due_at: new Date(NOW - 1).toISOString() }),
      item({ id: 3, due_at: new Date(NOW + DUE_SOON_WINDOW_MS).toISOString() }),
      item({ id: 4, due_at: new Date(NOW + 60_000).toISOString(), status: "completed" }),
      item({ id: 5, due_at: "invalid" }),
      item({ id: 6, due_at: new Date(NOW).toISOString() }),
    ]), NOW, raise);
    expect(raise).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: `6:${new Date(NOW).toISOString()}`, ttlMs: 0 }));
  });

  it("uses a new identity when the deadline changes and stops raising completed items", async () => {
    const due1 = new Date(NOW + 60 * 60_000).toISOString();
    const due2 = new Date(NOW + 2 * 60 * 60_000).toISOString();
    const raise = vi.fn(raiseAlert);
    await scanAndRaiseDueSoon(okListReader([item({ id: 1, due_at: due1 })]), NOW, raise);
    await scanAndRaiseDueSoon(okListReader([item({ id: 1, due_at: due2 })]), NOW, raise);
    await scanAndRaiseDueSoon(okListReader([item({ id: 1, due_at: due2, status: "completed" })]), NOW, raise);
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: `1:${due1}` }));
    expect(raise).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: `1:${due2}` }));
  });

  it("raises nothing when the board list is not ok", async () => {
    const store: DueSoonBoardReader = { list: async () => ({ status: "invalid", reason: "boom" }) };
    const raise = vi.fn(raiseAlert);
    await scanAndRaiseDueSoon(store, NOW, raise);
    expect(raise).not.toHaveBeenCalled();
  });
});

describe("startDueSoonScans", () => {
  it("re-scans once per cooldown while deferred, keeps one pending re-scan and stops both timers", async () => {
    vi.useFakeTimers();
    try {
      let deferred = true;
      const scan = vi.fn(async () => deferred);
      const onError = vi.fn();
      const stop = startDueSoonScans(scan, onError);
      await vi.advanceTimersByTimeAsync(0);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(ALERT_KIND_COOLDOWN_MS);
      expect(scan).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(2);
      deferred = false;
      await vi.advanceTimersByTimeAsync(ALERT_KIND_COOLDOWN_MS);
      expect(scan).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(DUE_SOON_TICK_MS);
      expect(scan).toHaveBeenCalledTimes(4);
      deferred = true;
      await vi.advanceTimersByTimeAsync(DUE_SOON_TICK_MS);
      expect(vi.getTimerCount()).toBe(2);
      const calls = scan.mock.calls.length;
      stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * DUE_SOON_TICK_MS);
      expect(scan).toHaveBeenCalledTimes(calls);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a failed scan and keeps the tick", async () => {
    vi.useFakeTimers();
    try {
      const scan = vi.fn(async () => { throw new Error("scan failed"); });
      const onError = vi.fn();
      const stop = startDueSoonScans(scan, onError);
      await vi.advanceTimersByTimeAsync(DUE_SOON_TICK_MS);
      expect(onError).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
