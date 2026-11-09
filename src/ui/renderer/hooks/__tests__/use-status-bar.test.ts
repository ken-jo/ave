// @vitest-environment jsdom
/** Pane-local notices retain their queue, TTL and persistent status behavior. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useStatusNotices } from "../use-status-bar.js";

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// Case 1 — Toast TTL eviction
describe("useStatusNotices — toast TTL eviction", () => {
  it("removes a toast after its TTL elapses (default 5 s, checked after 6 s)", async () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 5000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "hello" });
    });

    // Immediately after push: 1 toast.
    expect(result.current.toasts).toHaveLength(1);

    // Advance 6 s — past the 5 s TTL. The sequential display effect schedules a setTimeout at exactly the TTL, so the toast is
    // gone after 5 s.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it("extends long toast TTL so marquee text can finish flowing", async () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 3000 }),
    );
    const longMessage =
      "Plugin login failed. code: non-corp-network. Corporate network or VPN is required. Please connect and try again.";

    vi.setSystemTime(0);
    act(() => {
      result.current.pushToast({ severity: "warning", message: longMessage, ttlMs: 5000 });
    });

    const ttlMs = result.current.visibleToast?.ttlMs ?? 0;
    expect(ttlMs).toBeGreaterThan(5000);

    await act(async () => {
      vi.advanceTimersByTime(5100);
    });
    expect(result.current.visibleToast?.message).toBe(longMessage);

    await act(async () => {
      vi.advanceTimersByTime(ttlMs);
    });
    expect(result.current.visibleToast).toBeNull();
  });
});

// Case 2 — Toast queue cap at 50
describe("useStatusNotices — toast queue cap", () => {
  it("caps at 50 toasts and keeps the LATEST 50 when 100 are pushed", () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 60_000 }),
    );

    act(() => {
      for (let i = 1; i <= 100; i++) {
        result.current.pushToast({ severity: "info", message: `msg-${i}` });
      }
    });

    expect(result.current.toasts).toHaveLength(50);

    // The oldest 50 (toast:1 … toast:50) should have been dropped.
    const ids = result.current.toasts.map((t) => t.id);
    expect(ids[0]).toBe("toast:51");
    expect(ids[49]).toBe("toast:100");
  });
});

// Case 3 — upsertPersistent updates in place
describe("useStatusNotices — upsertPersistent", () => {
  it("updates an existing persistent item in place (no duplicate entries)", () => {
    const { result } = renderHook(() => useStatusNotices());

    act(() => {
      result.current.upsertPersistent({
        id: "x",
        severity: "info",
        label: "Label",
        value: "first",
      });
    });
    act(() => {
      result.current.upsertPersistent({
        id: "x",
        severity: "info",
        label: "Label",
        value: "second",
      });
    });

    expect(result.current.persistent).toHaveLength(1);
    expect(result.current.persistent[0]?.value).toBe("second");
  });
});

// Case 4 — removePersistent
describe("useStatusNotices — removePersistent", () => {
  it("removes a previously upserted persistent item by id", () => {
    const { result } = renderHook(() => useStatusNotices());

    act(() => {
      result.current.upsertPersistent({
        id: "y",
        severity: "info",
        label: "L",
        value: "v",
      });
    });
    expect(result.current.persistent).toHaveLength(1);

    act(() => {
      result.current.removePersistent("y");
    });
    expect(result.current.persistent).toHaveLength(0);
  });
});

describe("useStatusNotices — sequential toast display", () => {
  it("visibleToast exposes the queue head, pendingCount reflects the rest", () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 5000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "first" });
      result.current.pushToast({ severity: "success", message: "second" });
      result.current.pushToast({ severity: "warning", message: "third" });
    });

    expect(result.current.visibleToast?.message).toBe("first");
    expect(result.current.pendingCount).toBe(2);
  });

  it("auto-advances to next toast after the visible one's TTL elapses", async () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 3000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "first", ttlMs: 3000 });
      result.current.pushToast({ severity: "success", message: "second", ttlMs: 3000 });
    });

    expect(result.current.visibleToast?.message).toBe("first");
    expect(result.current.pendingCount).toBe(1);

    // Advance past first toast TTL.
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(result.current.visibleToast?.message).toBe("second");
    expect(result.current.pendingCount).toBe(0);
  });

  it("queue drains to null visibleToast after all toasts expire", async () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 3000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "only one", ttlMs: 3000 });
    });

    expect(result.current.visibleToast?.message).toBe("only one");

    await act(async () => {
      vi.advanceTimersByTime(3100);
    });

    expect(result.current.visibleToast).toBeNull();
    expect(result.current.pendingCount).toBe(0);
  });

  it("removeToast on visibleToast immediately advances to next", () => {
    const { result } = renderHook(() =>
      useStatusNotices({ defaultToastTtlMs: 30_000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "first" });
      result.current.pushToast({ severity: "success", message: "second" });
    });

    const firstId = result.current.visibleToast?.id;
    expect(firstId).toBeDefined();

    act(() => {
      result.current.removeToast(firstId!);
    });

    expect(result.current.visibleToast?.message).toBe("second");
    expect(result.current.pendingCount).toBe(0);
  });

  it("removeToast of a queued toast leaves the head's expiry alone", async () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 3000 }));

    let secondId = "";
    act(() => {
      result.current.pushToast({ severity: "info", message: "first", ttlMs: 3000 });
      secondId = result.current.pushToast({ severity: "info", message: "second", ttlMs: 3000 });
    });
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    act(() => result.current.removeToast(secondId));
    expect(result.current.visibleToast?.message).toBe("first");
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current.visibleToast).toBeNull();
  });

  it("removeToast gives the promoted head a full TTL", async () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 3000 }));

    let firstId = "";
    act(() => {
      firstId = result.current.pushToast({ severity: "info", message: "first", ttlMs: 3000 });
      result.current.pushToast({ severity: "info", message: "second", ttlMs: 3000 });
    });
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    act(() => result.current.removeToast(firstId));
    expect(result.current.visibleToast?.message).toBe("second");

    await act(async () => {
      vi.advanceTimersByTime(2900);
    });
    expect(result.current.visibleToast?.message).toBe("second");
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.visibleToast).toBeNull();
  });

});
