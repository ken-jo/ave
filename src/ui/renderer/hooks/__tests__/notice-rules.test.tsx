// @vitest-environment jsdom
/**
 * The shared notice rules, as the notice queue (`useStatusNotices`) enforces them for every strip that draws its head:
 * (b) errors stay until dismissed, brief confirmations expire; (c) one visible at a time, the rest queue; (d) a modal holds
 * the queue and its notices show, with their full time, after it closes; (e) a repeating notice can be silenced for good.
 * The role (a), close button, width cap and motion are asserted on the drawn element in StatusBar.test.tsx.
 */
import "../../../../../test/renderer/setup.js";
import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../../../../components/ui/dialog.js";
import { registerOpenModal, useModalOpen } from "../../../../components/ui/modal-presence.js";
import { useStatusNotices } from "../use-status-bar.js";

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.removeItem("ave.notices.suppressed");
});

function Probe({ open }: { open: boolean }) {
  const modalOpen = useModalOpen();
  return (
    <>
      <span data-testid="modal-open">{String(modalOpen)}</span>
      <Dialog open={open}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Dialog</DialogTitle>
          <button type="button">inside</button>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("notice rules", () => {
  it("(b) keeps an error until it is dismissed, whatever TTL its producer asked for", async () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 1000 }));
    act(() => {
      result.current.pushToast({ severity: "error", message: "write failed", ttlMs: 1000 });
    });
    expect(result.current.visibleToast?.sticky).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.visibleToast?.message).toBe("write failed");
    const shown = result.current.visibleToast;
    if (shown === null) throw new Error("expected the error to be shown");
    act(() => {
      result.current.removeToast(shown.id);
    });
    expect(result.current.visibleToast).toBeNull();
  });

  it("(b) lets a brief confirmation expire on its own", async () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 1000 }));
    act(() => {
      result.current.pushToast({ severity: "success", message: "saved" });
    });
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(result.current.visibleToast).toBeNull();
  });

  it("(c) shows one notice at a time and queues the later ones", async () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 1000 }));
    act(() => {
      result.current.pushToast({ severity: "info", message: "first" });
      result.current.pushToast({ severity: "info", message: "second" });
    });
    expect(result.current.visibleToast?.message).toBe("first");
    expect(result.current.pendingCount).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(result.current.visibleToast?.message).toBe("second");
    expect(result.current.pendingCount).toBe(0);
  });

  it("(d) holds notices while a modal is open and shows them, with their full time, after it closes", async () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 1000 }));
    let release = () => {};
    act(() => {
      release = registerOpenModal();
    });
    act(() => {
      result.current.pushToast({ severity: "success", message: "saved behind the modal" });
    });
    expect(result.current.visibleToast).toBeNull();
    expect(result.current.pendingCount).toBe(0);
    // Far longer than the TTL: a held notice is neither shown nor dropped.
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(result.current.toasts).toHaveLength(1);
    act(() => {
      release();
    });
    expect(result.current.visibleToast?.message).toBe("saved behind the modal");
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.visibleToast?.message).toBe("saved behind the modal");
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.visibleToast).toBeNull();
  });

  it("(d) counts a real dialog as open only while its content is shown", () => {
    const { rerender } = render(<Probe open={false} />);
    expect(screen.getByTestId("modal-open").textContent).toBe("false");
    rerender(<Probe open />);
    expect(screen.getByTestId("modal-open").textContent).toBe("true");
    rerender(<Probe open={false} />);
    expect(screen.getByTestId("modal-open").textContent).toBe("false");
  });

  it("(e) silences a suppressible notice kind for good, and drops the queued ones of that kind", () => {
    const { result } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 1000 }));
    act(() => {
      result.current.pushToast({ severity: "info", message: "repeat 1", kind: "repeat", suppressible: true });
      result.current.pushToast({ severity: "info", message: "repeat 2", kind: "repeat", suppressible: true });
    });
    act(() => {
      result.current.suppressToastKind("repeat");
    });
    expect(result.current.toasts).toHaveLength(0);
    act(() => {
      result.current.pushToast({ severity: "info", message: "repeat 3", kind: "repeat", suppressible: true });
    });
    expect(result.current.toasts).toHaveLength(0);

    // A fresh queue (a reload) still honours the choice.
    const { result: fresh } = renderHook(() => useStatusNotices({ defaultToastTtlMs: 1000 }));
    act(() => {
      fresh.current.pushToast({ severity: "info", message: "repeat 4", kind: "repeat", suppressible: true });
    });
    expect(fresh.current.toasts).toHaveLength(0);
  });

  it("(e) refuses to make an error suppressible", () => {
    const { result } = renderHook(() => useStatusNotices());
    expect(() =>
      result.current.pushToast({ severity: "error", message: "boom", kind: "boom", suppressible: true }),
    ).toThrow(/cannot be an error/);
  });
});
