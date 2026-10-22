// @vitest-environment jsdom
/**
 * useStatusBar — unit tests for toast TTL eviction, queue cap,
 * persistent item management, and producer lifecycle effects.
 *
 * The CONTROL_CHARS regex in use-status-bar.ts is `/[\x00-\x1f\x7f]/g`
 * (rendered as invisible bytes in the file — verified by reading raw hex).
 * It strips C0 control characters (0x00–0x1F) and DEL (0x7F).
 * Spaces, hyphens, and other visible ASCII are NOT stripped.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useStatusBar } from "../use-status-bar.js";
import type { AveApi } from "../../types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";

// ── Minimal API factory ───────────────────────────────────────────────────────
// Only wire up the methods exercised by each test so that accidental calls to
// missing methods throw "not a function" rather than silently succeeding.

function noop() {
  return () => {};
}

function statusBarApi(overrides: Partial<AveApi> = {}): AveApi {
  const { api } = makeMockAveApi();
  // Keep the default status-bar fixture quiet. Individual producer tests opt
  // into the API methods they exercise through overrides below.
  delete api.getSettings;
  delete api.onSettingsUpdated;
  delete api.pingMarketplace;
  Object.assign(api, overrides);
  return api as unknown as AveApi;
}

// ── Fake-timer harness ────────────────────────────────────────────────────────
// shouldAdvanceTime: true is required so that @testing-library/react's
// internal waitFor polling timers advance alongside our fake clock.

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Case 1 — Toast TTL eviction
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — toast TTL eviction", () => {
  it("removes a toast after its TTL elapses (default 5 s, checked after 6 s)", async () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 5000 }),
    );

    act(() => {
      result.current.pushToast({ severity: "info", message: "hello" });
    });

    // Immediately after push: 1 toast.
    expect(result.current.toasts).toHaveLength(1);

    // Advance 6 s — past the 5 s TTL. The sequential display effect schedules
    // a setTimeout at exactly the TTL, so the toast is gone after 5 s.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it("keeps a sticky notification toast at the head until it is dismissed", async () => {
    let emit: ((payload: { kind: "alert"; title: string; body: string; sticky?: true }) => void) | undefined;
    const api = statusBarApi({
      onNotificationToast: (handler) => {
        emit = handler as typeof emit;
        return noop();
      },
    });
    const { result } = renderHook(() => useStatusBar({ api, defaultToastTtlMs: 5000 }));
    act(() => {
      emit?.({ kind: "alert", title: "Meeting", body: "starting", sticky: true });
      emit?.({ kind: "alert", title: "Mail", body: "new" });
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.visibleToast?.message).toBe("Meeting: starting");
    act(() => {
      result.current.removeToast(result.current.visibleToast!.id);
    });
    expect(result.current.visibleToast?.message).toBe("Mail: new");
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });
    expect(result.current.visibleToast).toBeNull();
  });

  it("extends long toast TTL so marquee text can finish flowing", async () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
    );
    const longMessage =
      "Plugin login failed. code: non-corp-network. Corporate network or VPN is required. Please connect and try again.";

    vi.setSystemTime(0);
    act(() => {
      result.current.pushToast({ severity: "error", message: longMessage, ttlMs: 5000 });
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

// ─────────────────────────────────────────────────────────────────────────────
// Case 2 — Toast queue cap at 50
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — toast queue cap", () => {
  it("caps at 50 toasts and keeps the LATEST 50 when 100 are pushed", () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 60_000 }),
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

// ─────────────────────────────────────────────────────────────────────────────
// Case 3 — upsertPersistent updates in place
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — upsertPersistent", () => {
  it("updates an existing persistent item in place (no duplicate entries)", () => {
    const api = statusBarApi();
    const { result } = renderHook(() => useStatusBar({ api }));

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

// ─────────────────────────────────────────────────────────────────────────────
// Case 4 — removePersistent
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — removePersistent", () => {
  it("removes a previously upserted persistent item by id", () => {
    const api = statusBarApi();
    const { result } = renderHook(() => useStatusBar({ api }));

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

// ─────────────────────────────────────────────────────────────────────────────
// Case 5 — Install lifecycle producer wires onPluginInstallResult
// ─────────────────────────────────────────────────────────────────────────────
type InstallResultHandler = (payload: { slug: string; success: boolean; error?: string }) => void;

describe("useStatusBar — install lifecycle producer", () => {
  function renderWithResultHandler() {
    let handler: InstallResultHandler | null = null;
    const api = statusBarApi({
      onPluginInstallResult: vi.fn((h) => {
        handler = h;
        return noop();
      }),
    });
    const hook = renderHook(() => useStatusBar({ api }));
    expect(api.onPluginInstallResult).toHaveBeenCalledOnce();
    return { ...hook, emit: (payload: Parameters<InstallResultHandler>[0]) => act(() => handler!(payload)) };
  }

  it("pushes a success toast when onPluginInstallResult reports an install", () => {
    const { result, emit } = renderWithResultHandler();

    emit({ slug: "samplehub", success: true });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({ severity: "success", message: "samplehub 설치 완료" });
  });

  it("sanitizeToastField strips C0 control characters (0x00–0x1F) from slug", () => {
    const { result, emit } = renderWithResultHandler();

    // Null byte (0x00) is in the C0 range → stripped.
    emit({ slug: "ev\x00il", success: true });
    expect(result.current.toasts[0]?.message).toBe("evil 설치 완료");

    // Other C0 control chars — tab (0x09), LF (0x0A), CR (0x0D).
    emit({ slug: "a\tb\nc\rd", success: true });
    expect(result.current.toasts[1]?.message).toBe("abcd 설치 완료");
  });

  it("keeps one toast per slug, replacing it with the latest result", () => {
    const { result, emit } = renderWithResultHandler();

    emit({ slug: "sampleassistant", success: false, error: "disk full" });
    const toastId = result.current.toasts[0]?.id;
    emit({ slug: "sampleassistant", success: true });

    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({ id: toastId, severity: "success", message: "sampleassistant 설치 완료" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Note: the vendor (provider/model) + combined health producers were removed
// from useStatusBar — the window status bar is NOTIFICATIONS-ONLY. Those cells
// now live in the unified InputActionBar status sub-row (see
// use-input-status-row.ts + InputActionBar.test.tsx). useStatusBar retains only
// the toast/notification surface plus the install lifecycle producer.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Case 9 — Sequential toast display (visibleToast + pendingCount)
// ─────────────────────────────────────────────────────────────────────────────
describe("useStatusBar — sequential toast display", () => {
  it("visibleToast exposes the queue head, pendingCount reflects the rest", () => {
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 5000 }),
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
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
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
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
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
    const api = statusBarApi();
    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 30_000 }),
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

  it("burst of 3 install-result events shows only 1 toast at a time, advancing sequentially", async () => {
    let capturedHandler: ((payload: { slug: string; success: boolean; error?: string }) => void) | null = null;

    const api = statusBarApi({
      onPluginInstallResult: vi.fn((h) => {
        capturedHandler = h;
        return () => {};
      }),
    });

    const { result } = renderHook(() =>
      useStatusBar({ api, defaultToastTtlMs: 3000 }),
    );

    // Pin the fake clock to a known epoch before pushing toasts so that
    // expiresAt values are deterministic regardless of real CI wall-clock
    // drift (shouldAdvanceTime: true can cause extra advancement on slow
    // runners, draining the queue prematurely).
    vi.setSystemTime(0);

    // Burst: 3 install-result events in the same tick.
    act(() => {
      capturedHandler!({ slug: "plugin-a", success: true });
      capturedHandler!({ slug: "plugin-b", success: true });
      capturedHandler!({ slug: "plugin-c", success: true });
    });

    // Only 1 visible at a time.
    expect(result.current.visibleToast?.message).toBe("plugin-a 설치 완료");
    expect(result.current.pendingCount).toBe(2);

    // Advance past first TTL → second becomes visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.visibleToast?.message).toBe("plugin-b 설치 완료");
    expect(result.current.pendingCount).toBe(1);

    // Advance past second TTL → third becomes visible.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.visibleToast?.message).toBe("plugin-c 설치 완료");
    expect(result.current.pendingCount).toBe(0);

    // Advance past third TTL → queue empty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(result.current.visibleToast).toBeNull();
  });
});
