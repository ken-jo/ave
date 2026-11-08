import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { endAnimation } from "../../../../test/renderer/helpers.js";
import { NoticeLiveRegion, StatusBar } from "../components/StatusBar.js";
import type { PersistentItem, ToastItem } from "../hooks/use-status-bar.js";
import { getWebSurfaceOccluders } from "../preview/web-surfaces.js";

function persistent(overrides: Partial<PersistentItem> = {}): PersistentItem {
  return {
    id: "routine:next",
    severity: "info",
    label: "다음 루틴",
    value: "04:42 KST",
    ...overrides,
  };
}

function toast(overrides: Partial<ToastItem> = {}): ToastItem {
  return {
    id: "toast:1",
    severity: "info",
    message: "samplehub 설치 중…",
    expiresAt: Date.now() + 5000,
    ...overrides,
  };
}

describe("StatusBar", () => {
  it("keeps the notice visible above native page content until it unmounts", () => {
    const { unmount } = render(<StatusBar persistent={[]} visibleToast={toast()} onToastDismiss={() => {}} />);
    const notice = screen.getByTestId("status-toast");
    expect(getWebSurfaceOccluders().has(notice)).toBe(true);
    unmount();
    expect(getWebSurfaceOccluders().has(notice)).toBe(false);
  });
  // wb-final removed the Ave brand mark from app chrome. The empty status bar renders no brand logo/text — only a
  // zero-footprint spacer that keeps the flex layout stable until the first persistent item arrives.
  it("renders no Ave brand placeholder when there are no persistent items", () => {
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={null} />);
    expect(screen.queryByText("Ave")).toBeNull();
    expect(screen.queryByRole("img", { name: "Ave" })).toBeNull();
  });

  it("renders nothing when empty (notifications moved to the top-right banner stack)", () => {
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={null} />);
    expect(screen.queryByTestId("status-bar")).toBeNull();
  });

  it("stays mounted, leaving, after its content is gone and unmounts when the exit animation ends", () => {
    const { rerender } = render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast({ message: "로그인이 취소되었습니다" })} />);
    const presence = screen.getByTestId("status-bar-presence");
    expect(presence.className).toContain("ave-anim-notice-in");
    expect(presence.dataset.leaving).toBeUndefined();

    rerender(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={null} />);
    // The last content is still drawn, now on its way out.
    expect(screen.getByTestId("status-bar-presence").className).toContain("ave-anim-notice-out");
    expect(screen.getByTestId("status-bar-presence").dataset.leaving).toBe("true");
    expect(screen.getByTestId("status-toast-message")).toHaveTextContent("로그인이 취소되었습니다");

    endAnimation(screen.getByTestId("status-bar-presence"));
    expect(screen.queryByTestId("status-bar")).toBeNull();
  });

  it("new content during the exit brings the bar back without unmounting it", () => {
    const { rerender } = render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast({ id: "toast:1", message: "첫 번째" })} />);
    rerender(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={null} />);
    expect(screen.getByTestId("status-bar-presence").dataset.leaving).toBe("true");
    rerender(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast({ id: "toast:2", message: "두 번째" })} />);
    expect(screen.getByTestId("status-bar-presence").className).toContain("ave-anim-notice-in");
    expect(screen.getByTestId("status-toast-message")).toHaveTextContent("두 번째");
  });

  it("floats only the toast while persistent indicators stay in flow", () => {
    const { rerender } = render(<StatusBar persistent={[persistent()]} visibleToast={toast()} onToastDismiss={() => {}} />);
    const overlay = screen.getByTestId("status-bar-presence");
    expect(overlay.className).toContain("absolute");
    expect(overlay.className).toContain("z-30");
    expect(overlay.className).toContain("bottom-full");
    expect(overlay.className).toContain("pointer-events-none");
    expect(screen.getByTestId("status-toast").className).toContain("pointer-events-auto");
    expect(screen.getByTestId("status-toast").className).not.toContain("max-h-(--chrome-band-height)");
    expect(overlay.contains(screen.getByText("04:42 KST"))).toBe(false);

    rerender(<StatusBar persistent={[persistent()]} visibleToast={null} onToastDismiss={() => {}} />);
    expect(screen.getByTestId("status-bar-presence")).toHaveAttribute("data-leaving", "true");
    endAnimation(screen.getByTestId("status-bar-presence"));
    expect(screen.queryByTestId("status-toast")).toBeNull();
    expect(screen.getByText("04:42 KST")).toBeVisible();
  });

  it("floats composer notices above their anchor", () => {
    render(<StatusBar persistent={[]} visibleToast={toast()} onToastDismiss={() => {}} toastPlacement="above" />);
    expect(screen.getByTestId("status-bar-presence").className).toContain("bottom-full");
  });

  it("keeps title bar notices in their single-line slot with only opacity motion and interactive notice controls", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    const notice = toast({ severity: "error", notification: { kind: "system", contextRef: {} } });
    const { rerender } = render(<StatusBar persistent={[]} visibleToast={notice} toastPlacement="titlebar" pendingCount={2} onToastClick={onOpen} onToastDismiss={onDismiss} />);
    const presence = screen.getByTestId("status-bar-presence");
    expect(presence).toHaveClass("relative", "ave-anim-fade-in", "pointer-events-none");
    expect(presence).not.toHaveClass("absolute", "ave-anim-notice-in");
    const surface = screen.getByTestId("status-toast");
    expect(surface).toHaveClass("h-(--chrome-control-height)", "items-center", "max-w-[min(100%,24rem)]");
    expect((surface.style as unknown as Record<string, string>).WebkitAppRegion).toBe("no-drag");
    expect((presence.style as unknown as Record<string, string>).WebkitAppRegion).toBeUndefined();
    expect(screen.getByText("+2")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /자세히 알아보기|Learn more/ }));
    expect(onOpen).toHaveBeenCalledWith(notice);
    fireEvent.click(screen.getByTestId("status-toast-dismiss"));
    expect(onDismiss).toHaveBeenCalledWith(notice);
    const run = vi.fn();
    const actionLabel = "Open the detailed explanation of this notice and the available recovery steps";
    rerender(<StatusBar persistent={[]} toastPlacement="titlebar" visibleToast={toast({ action: { label: actionLabel, run } })} onToastDismiss={onDismiss} />);
    const action = screen.getByRole("button", { name: actionLabel });
    expect(action).toHaveClass("max-w-[40%]");
    expect(action.querySelector("span")).toHaveClass("truncate");
    expect(screen.getByTestId("status-toast-dismiss")).toBeVisible();
    fireEvent.click(action);
    expect(run).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledTimes(2);
    rerender(<StatusBar persistent={[]} visibleToast={null} toastPlacement="titlebar" onToastDismiss={onDismiss} />);
    expect(presence).toHaveClass("ave-anim-fade-out");
    expect(presence).not.toHaveClass("ave-anim-notice-out");
    endAnimation(presence);
    expect(screen.queryByTestId("status-toast")).toBeNull();
  });

  it("renders persistent items with label and value", () => {
    render(<StatusBar onToastDismiss={() => {}} persistent={[persistent()]} visibleToast={null} />);
    expect(screen.getByText("다음 루틴")).toBeInTheDocument();
    expect(screen.getByText("04:42 KST")).toBeInTheDocument();
  });

  it("renders only the visible toast message on the right slot", () => {
    const t1 = toast({ id: "toast:1", message: "samplehub 설치 중…" });
    // Only visibleToast (t1) is shown; one more toast is queued (pendingCount=1).
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={t1} pendingCount={1} />);
    expect(screen.getByTestId("status-toast-message")).toHaveTextContent("samplehub 설치 중…");
    expect(screen.queryByText("samplehub 설치 완료")).not.toBeInTheDocument();
    // pending badge shows +1
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("renders toast text through the marquee surface so long messages can flow", () => {
    const message = "Plugin login failed. code: non-corp-network. Corporate network or VPN is required.";
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast({ message })} pendingCount={0} />);
    const text = screen.getByTestId("status-toast-message");
    expect(text).toHaveAttribute("title", message);
    expect(text).toHaveTextContent(message);
  });

  it("keeps a shared notice frame while the status mark carries severity", () => {
    const { container, rerender } = render(
      <StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast({ severity: "warning" })} />,
    );
    const toastCard = () => container.querySelector('[data-testid="status-toast-message"]')?.parentElement;
    expect(toastCard()?.className).toContain("bg-input-bar");
    expect(toastCard()?.querySelector("[aria-hidden]")?.className).toContain("bg-warning");

    rerender(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast({ severity: "error" })} />);
    expect(toastCard()?.className).toContain("bg-input-bar");
    expect(toastCard()?.querySelector("[aria-hidden]")?.className).toContain("bg-destructive");
  });

  it("shows no toast when visibleToast is null", () => {
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={null} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows no pending badge when pendingCount is 0", () => {
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast()} pendingCount={0} />);
    expect(screen.queryByText(/\+\d/)).not.toBeInTheDocument();
  });

  it("shows pending badge with correct count", () => {
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast()} pendingCount={2} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("draws the pending count as the shared badge, keeping its own size and tone", () => {
    // The chip is the shared `Badge`, so the pill shape and border come from
    // one place; what the status bar overrides is the type scale and the muted
    // tone this row reads in. Merging failures here are silent — the badge's
    // own `text-xs` / `font-semibold` / `text-foreground` surviving the merge
    // is a heavier, brighter chip that still passes every other assertion.
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={toast()} pendingCount={2} />);
    const badge = screen.getByText("+2");
    expect(badge.className).toContain("rounded-full");
    expect(badge.className).toContain("text-dense");
    expect(badge.className).toContain("text-muted-foreground");
    expect(badge.className).toContain("font-normal");
    expect(badge.className).toContain("tabular-nums");
    expect(badge.className).not.toContain("text-xs");
    expect(badge.className).not.toContain("font-semibold");
    expect(badge.className).not.toContain("text-foreground");
    expect(badge.className).not.toContain("px-2.5");
  });

  it("invokes onToastClick when a notification toast is clicked (#260 M2)", () => {
    const onToastClick = vi.fn();
    const notif: ToastItem = toast({
      id: "toast:n",
      message: "질문이 도착했습니다: 진행 상태?",
      severity: "info",
      notification: { kind: "ask-user", contextRef: { questionId: "q-9" } },
    });
    render(<StatusBar onToastDismiss={() => {}} persistent={[]} visibleToast={notif} onToastClick={onToastClick} />);
    const btn = screen.getByRole("button", {
      name: /자세히 알아보기|Learn more/,
    });
    fireEvent.click(btn);
    expect(onToastClick).toHaveBeenCalledTimes(1);
    expect(onToastClick).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "toast:n",
        notification: expect.objectContaining({
          kind: "ask-user",
          contextRef: expect.objectContaining({ questionId: "q-9" }),
        }),
      }),
    );
  });

  it("dismisses the visible toast from the close button", () => {
    const onToastDismiss = vi.fn();
    render(
      <StatusBar
        persistent={[]}
        visibleToast={toast({ id: "toast:d", message: "Claude Fable 5는 현재 사용할 수 없습니다." })}
        onToastDismiss={onToastDismiss}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /알림 닫기|Dismiss notification/ }));

    expect(onToastDismiss).toHaveBeenCalledWith(expect.objectContaining({ id: "toast:d" }));
  });

  it("renders non-notification toasts as plain spans (no click handler)", () => {
    const onToastClick = vi.fn();
    render(
      <StatusBar
        persistent={[]}
        visibleToast={toast({ id: "toast:i", message: "samplehub 설치 완료", severity: "success" })}
        onToastClick={onToastClick}
        onToastDismiss={() => {}}
      />,
    );
    // Plain producer toasts offer no "Learn more": the only button is the close button.
    expect(screen.getAllByRole("button").map((button) => button.getAttribute("data-testid"))).toEqual(["status-toast-dismiss"]);
    expect(onToastClick).not.toHaveBeenCalled();
  });

  it("renders a clickable persistent item as a button and invokes onClick (PR-X1)", () => {
    const onClick = vi.fn();
    render(
      <StatusBar onToastDismiss={() => {}}
        persistent={[persistent({ id: "vendor:llm", label: "🟧", value: "Claude · sonnet-4-6", onClick })]}
        visibleToast={null}
      />,
    );
    const btn = screen.getByRole("button", { name: /Claude · sonnet-4-6/ });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a persistent item without onClick as a plain span", () => {
    render(
      <StatusBar onToastDismiss={() => {}}
        persistent={[persistent({ id: "vendor:llm", label: "🟧", value: "Claude · sonnet-4-6" })]}
        visibleToast={null}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("Claude · sonnet-4-6")).toBeInTheDocument();
  });

  it("renders a dot-only persistent item with severity color + top tooltip trigger", () => {
    const onlineItem: PersistentItem = {
      id: "health:services",
      severity: "success",
      dot: true,
      a11yLabel: "LLM: online, Market: online",
      tooltip: "LLM: online\nMarket: online",
    };
    const { container, rerender } = render(
      <StatusBar onToastDismiss={() => {}} persistent={[onlineItem]} visibleToast={null} />,
    );
    expect(screen.queryByText("Market")).toBeNull();
    expect(screen.getByText("LLM: online, Market: online")).toBeInTheDocument();
    const dot = container.querySelector(
      '[data-testid="status-bar-dot-health:services"]',
    );
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("bg-success");
    const wrapper = [...container.querySelectorAll("[title]")]
      .find((el) => el.getAttribute("title") === "LLM: online\nMarket: online");
    expect(wrapper).not.toBeNull();

    // Flip offline — dot turns destructive, a11y text swaps.
    const offlineItem: PersistentItem = {
      ...onlineItem,
      severity: "error",
      a11yLabel: "LLM: offline, Market: online",
      tooltip: "LLM: offline\nMarket: online",
    };
    rerender(<StatusBar onToastDismiss={() => {}} persistent={[offlineItem]} visibleToast={null} />);
    const dotOffline = container.querySelector(
      '[data-testid="status-bar-dot-health:services"]',
    );
    expect(dotOffline?.className).toContain("bg-destructive");
    expect(screen.getByText("LLM: offline, Market: online")).toBeInTheDocument();
  });

  it("announces a non-error notice through the polite region and leaves the visual notice non-live", () => {
    render(
      <>
        <NoticeLiveRegion toast={toast({ severity: "success", message: "saved" })} />
        <StatusBar persistent={[]} visibleToast={toast({ severity: "success", message: "saved" })} onToastDismiss={() => {}} />
      </>,
    );
    const polite = screen.getByTestId("notice-live-polite");
    expect(polite).toHaveAttribute("role", "status");
    expect(polite).toHaveAttribute("aria-live", "polite");
    expect(polite).toHaveTextContent("saved");
    expect(screen.getByTestId("notice-live-assertive")).toHaveTextContent("");
    const notice = screen.getByTestId("status-toast");
    expect(notice).not.toHaveAttribute("role");
    expect(notice).not.toHaveAttribute("aria-live");
  });

  it("announces an error through the assertive region and still offers a close button", () => {
    const onDismiss = vi.fn();
    const error = toast({ severity: "error", message: "write failed" });
    render(
      <>
        <NoticeLiveRegion toast={error} />
        <StatusBar persistent={[]} visibleToast={error} onToastDismiss={onDismiss} />
      </>,
    );
    const assertive = screen.getByTestId("notice-live-assertive");
    expect(assertive).toHaveAttribute("role", "alert");
    expect(assertive).toHaveAttribute("aria-live", "assertive");
    expect(assertive).toHaveTextContent("write failed");
    expect(screen.getByTestId("notice-live-polite")).toHaveTextContent("");
    fireEvent.click(screen.getByTestId("status-toast-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the same live region nodes while the queue advances, so the next notice is announced", () => {
    const first = toast({ id: "toast:1", severity: "info", message: "first" });
    const second = toast({ id: "toast:2", severity: "info", message: "second" });
    const third = toast({ id: "toast:3", severity: "error", message: "third" });
    const strip = (head: ToastItem | null) => (
      <>
        <NoticeLiveRegion toast={head} />
        <StatusBar persistent={[]} visibleToast={head} onToastDismiss={() => {}} />
      </>
    );
    const { rerender } = render(strip(null));
    const polite = screen.getByTestId("notice-live-polite");
    const assertive = screen.getByTestId("notice-live-assertive");
    rerender(strip(first));
    expect(screen.getByTestId("notice-live-polite")).toBe(polite);
    expect(polite).toHaveTextContent("first");
    rerender(strip(second));
    expect(screen.getByTestId("notice-live-polite")).toBe(polite);
    expect(polite).toHaveTextContent("second");
    rerender(strip(third));
    expect(screen.getByTestId("notice-live-assertive")).toBe(assertive);
    expect(assertive).toHaveTextContent("third");
    expect(polite).toHaveTextContent("");
  });

  it("never takes focus when a notice appears, even an alert", () => {
    const { rerender } = render(
      <>
        <button type="button" data-testid="typing-here">x</button>
        <StatusBar persistent={[]} visibleToast={null} onToastDismiss={() => {}} />
      </>,
    );
    screen.getByTestId("typing-here").focus();
    rerender(
      <>
        <button type="button" data-testid="typing-here">x</button>
        <StatusBar persistent={[]} visibleToast={toast({ severity: "error" })} onToastDismiss={() => {}} />
      </>,
    );
    expect(document.activeElement).toBe(screen.getByTestId("typing-here"));
  });

  it("caps the notice width at min(100%, 24rem) and fades it in on a motion token", () => {
    render(<StatusBar persistent={[]} visibleToast={toast()} onToastDismiss={() => {}} />);
    const notice = screen.getByTestId("status-toast");
    expect(notice.className).toContain("max-w-[min(100%,24rem)]");
    expect(notice.className).toContain("ave-anim-fade-in");
  });

  it("offers Don't show again only on a suppressible notice", () => {
    const onSuppress = vi.fn();
    const { rerender } = render(
      <StatusBar persistent={[]} visibleToast={toast()} onToastDismiss={() => {}} onToastSuppress={onSuppress} />,
    );
    expect(screen.queryByTestId("status-toast-suppress")).toBeNull();
    rerender(
      <StatusBar
        persistent={[]}
        visibleToast={toast({ kind: "repeat", suppressible: true })}
        onToastDismiss={() => {}}
        onToastSuppress={onSuppress}
      />,
    );
    fireEvent.click(screen.getByTestId("status-toast-suppress"));
    expect(onSuppress).toHaveBeenCalledTimes(1);
  });

  it("keeps the persistent chips in their own polite status region", () => {
    const { container } = render(
      <StatusBar persistent={[persistent({ id: "p", label: "x", value: "y" })]} visibleToast={null} onToastDismiss={() => {}} />,
    );
    expect(container.querySelector("footer")).not.toHaveAttribute("role");
    expect(container.querySelector('footer > [role="status"]')).toHaveAttribute("aria-live", "polite");
  });
});
