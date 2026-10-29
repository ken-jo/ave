// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PermissionModeBadge } from "../permissions/PermissionModeBadge.js";

beforeEach(() => {
  delete (window as unknown as { ave?: unknown }).ave;
});

describe("PermissionModeBadge", () => {
  it("renders the explicit unknown mode prop without invoking a fetcher", async () => {
    // An explicit unknown mode uses the prop override and must not fetch or subscribe.
    let component: ReturnType<typeof render>;
    await act(async () => {
      component = render(<PermissionModeBadge mode="unknown" />);
    });
    const badge = component!.getByTestId("permission-mode-badge");
    expect(badge.getAttribute("data-mode")).toBe("unknown");
  });

  it("renders the mode prop override", () => {
    const { getByTestId } = render(<PermissionModeBadge mode="strict" />);
    const badge = getByTestId("permission-mode-badge");
    expect(badge.getAttribute("data-mode")).toBe("strict");
    expect(badge.textContent).toContain("기본");
  });

  it("calls fetcher and reflects 'auto' on mount", async () => {
    const fetcher = vi.fn(async () => ({ mode: "auto" }));
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("auto");
      expect(badge.textContent).toContain("auto");
      expect(badge.textContent).not.toContain("LLM");
      expect(badge.getAttribute("aria-label")).toContain("리뷰어");
    });
    expect(fetcher).toHaveBeenCalled();
  });

  it("calls fetcher and reflects 'allow' on mount", async () => {
    const fetcher = vi.fn(async () => ({ mode: "allow" }));
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("allow");
      expect(badge.textContent).toContain("허용");
    });
  });

  it("surfaces recently denied actions as a separate queue button", async () => {
    const recentlyDeniedFetcher = vi.fn(async () => ({
      ok: true,
      entries: [{ id: "p1" }, { id: "p2" }],
    }));
    await act(async () => {
      render(<PermissionModeBadge mode="auto" recentlyDeniedFetcher={recentlyDeniedFetcher} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("최근 거부 2");
    });
    const badge = screen.getByTestId("permission-mode-badge");
    expect(badge.getAttribute("aria-label")).not.toContain("최근 거부 2건");
    const queueButton = screen.getByTestId("permission-queue-button");
    expect(queueButton.getAttribute("aria-label")).toContain("최근 거부 2건");
    expect(queueButton).toBeDisabled();
  });

  it("surfaces denied history load failures instead of hiding the queue state", async () => {
    const recentlyDeniedFetcher = vi.fn(async () => ({
      ok: false,
      error: "recently-denied-list unavailable",
    }));
    await act(async () => {
      render(<PermissionModeBadge mode="auto" recentlyDeniedFetcher={recentlyDeniedFetcher} />);
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("내역 확인 실패");
    });
    expect(screen.getByTestId("permission-queue-button").getAttribute("aria-label")).toContain(
      "recently-denied-list unavailable",
    );
  });

  it("clears denied history failure state when a history-count event arrives", async () => {
    let capturedHandler: ((summary: { total: number }) => void) | null = null;
    const recentlyDeniedSubscriber = vi.fn((handler) => {
      capturedHandler = handler;
      return () => {};
    });
    await act(async () => {
      render(
        <PermissionModeBadge
          mode="default"
          recentlyDeniedFetcher={async () => ({ ok: false, error: "down" })}
          recentlyDeniedSubscriber={recentlyDeniedSubscriber}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("내역 확인 실패");
    });

    await act(async () => {
      capturedHandler!({ total: 1 });
    });

    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("최근 거부 1");
    });
    expect(screen.getByTestId("permission-queue-button").getAttribute("aria-label")).not.toContain("down");
  });

  it("subscribes to denied history changes", async () => {
    let capturedHandler: ((summary: { total: number }) => void) | null = null;
    const recentlyDeniedSubscriber = vi.fn((handler) => {
      capturedHandler = handler;
      return () => {};
    });
    await act(async () => {
      render(
        <PermissionModeBadge
          mode="default"
          recentlyDeniedFetcher={async () => ({ ok: true, entries: [] })}
          recentlyDeniedSubscriber={recentlyDeniedSubscriber}
        />,
      );
    });

    await act(async () => {
      capturedHandler!({ total: 3 });
    });

    await waitFor(() => {
      expect(screen.getByTestId("permission-pending-badge").textContent).toContain("최근 거부 3");
    });
  });

  it("normalizes invalid mode strings to unknown", async () => {
    const fetcher = vi.fn(async () => ({ mode: "yolo" }));
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("unknown");
    });
  });

  it("subscribes to mode-change events and updates", async () => {
    const fetcher = vi.fn(async () => ({ mode: "default" }));
    let capturedHandler: ((m: "default" | "strict" | "auto" | "allow" | "unknown") => void) | null = null;
    const subscribe = vi.fn((handler) => {
      capturedHandler = handler;
      return () => {};
    });
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} subscribe={subscribe} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("default");
    });
    await act(async () => {
      capturedHandler!("strict");
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("strict");
    });
  });

  it("subscribes to cross-window mode changes through preload", async () => {
    let capturedHandler: ((mode: string) => void) | null = null;
    const unsubscribe = vi.fn();
    const onModeChanged = vi.fn((handler: (mode: string) => void) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    (window as unknown as { ave: unknown }).ave = {
      permission: {
        getMode: vi.fn(async () => ({ mode: "default" })),
        onModeChanged,
        recentlyDeniedList: vi.fn(async () => ({ ok: true, entries: [], total: 0 })),
        onRecentlyDeniedChanged: vi.fn(() => () => undefined),
      },
    };

    const { unmount } = render(<PermissionModeBadge />);
    await waitFor(() => {
      expect(screen.getByTestId("permission-mode-badge").getAttribute("data-mode")).toBe("default");
    });
    expect(onModeChanged).toHaveBeenCalledOnce();

    await act(async () => {
      capturedHandler!("auto");
    });

    await waitFor(() => {
      expect(screen.getByTestId("permission-mode-badge").getAttribute("data-mode")).toBe("auto");
    });
    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("invokes onClick handler", async () => {
    const onClick = vi.fn();
    await act(async () => {
      render(<PermissionModeBadge mode="auto" onClick={onClick} />);
    });
    fireEvent.click(screen.getByTestId("permission-mode-badge"));
    expect(onClick).toHaveBeenCalled();
  });

  it("invokes queue click handler independently from mode settings", async () => {
    const onClick = vi.fn();
    const onHistoryClick = vi.fn();
    await act(async () => {
      render(
        <PermissionModeBadge
          mode="auto"
          recentlyDeniedFetcher={async () => ({ ok: true, entries: [{ id: "p1" }] })}
          onClick={onClick}
          onHistoryClick={onHistoryClick}
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("permission-queue-button")).toBeTruthy();
    });
    expect(screen.getByTestId("permission-queue-button")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("permission-queue-button"));
    expect(onHistoryClick).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("falls back to 'unknown' when fetcher rejects", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ipc unavailable");
    });
    await act(async () => {
      render(<PermissionModeBadge fetcher={fetcher} />);
    });
    await waitFor(() => {
      const badge = screen.getByTestId("permission-mode-badge");
      expect(badge.getAttribute("data-mode")).toBe("unknown");
    });
  });

  it("shows description in title attribute (tooltip)", () => {
    const { getByTestId } = render(<PermissionModeBadge mode="strict" />);
    const badge = getByTestId("permission-mode-badge");
    expect(badge.getAttribute("title")).toContain("일반 읽기");
  });
});
