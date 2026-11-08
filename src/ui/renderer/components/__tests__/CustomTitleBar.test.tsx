// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";
import { StatusBar } from "../StatusBar.js";
import { CustomTitleBar } from "../CustomTitleBar.js";

const mockMinimize = vi.fn().mockResolvedValue(undefined);
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);

let maxListener: ((maximized: boolean) => void) | null = null;
let fullscreenListener: ((fs: boolean) => void) | null = null;

const mockOnMaximizedChanged = vi.fn((handler: (m: boolean) => void) => {
  maxListener = handler;
  return () => { maxListener = null; };
});
const mockOnFullscreenChanged = vi.fn((handler: (fs: boolean) => void) => {
  fullscreenListener = handler;
  return () => { fullscreenListener = null; };
});

function setupBridges(isDarwin: boolean, windowControls: "native" | "trailing" | "leading" = isDarwin ? "native" : "trailing") {
  (window as unknown as Record<string, unknown>).avePlatform = { isDarwin, windowControls };
  (window as unknown as Record<string, unknown>).aveWindow = {
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    close: mockClose,
    onMaximizedChanged: mockOnMaximizedChanged,
    onFullscreenChanged: mockOnFullscreenChanged,
  };
}

function teardownBridges() {
  delete (window as unknown as Record<string, unknown>).avePlatform;
  delete (window as unknown as Record<string, unknown>).aveWindow;
  maxListener = null;
  fullscreenListener = null;
}

describe("CustomTitleBar", () => {
  afterEach(() => {
    teardownBridges();
    vi.clearAllMocks();
  });

  describe("macOS (isDarwin=true)", () => {
    beforeEach(() => setupBridges(true));

    it("renders a drag-only darwin band", () => {
      const { getByTestId, queryByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar-darwin")).toBeTruthy();
      expect(queryByTestId("custom-titlebar")).toBeNull();
    });

    it("does not render minimize/maximize/close buttons", () => {
      const { queryByTestId } = render(<CustomTitleBar />);
      expect(queryByTestId("titlebar-minimize")).toBeNull();
      expect(queryByTestId("titlebar-maximize")).toBeNull();
      expect(queryByTestId("titlebar-close")).toBeNull();
    });
  });

  describe("Linux (controls leading)", () => {
    beforeEach(() => setupBridges(false, "leading"));

    it("puts close, minimize, maximize at the leading edge, GNOME/macOS order", () => {
      const { getByTestId } = render(<CustomTitleBar><span data-testid="band-content">path</span></CustomTitleBar>);
      const band = getByTestId("custom-titlebar");
      expect(band).toHaveAttribute("data-window-controls", "leading");
      const controls = getByTestId("titlebar-controls");
      expect([...controls.children].map((button) => button.getAttribute("data-testid"))).toEqual(["titlebar-close", "titlebar-minimize", "titlebar-maximize"]);
      expect(controls).toHaveClass("absolute", "left-0", "top-0");
      expect(controls.className).not.toContain("ml-auto");
      expect(controls.style.getPropertyValue("-webkit-app-region") || (controls.style as unknown as Record<string, string>).WebkitAppRegion).toBe("no-drag");
      for (const button of controls.children) expect(button).toHaveClass("w-(--chrome-window-button-width)");
    });

    it("starts content past the buttons and mirrors the trailing pad", () => {
      const { getByTestId } = render(<CustomTitleBar><span>path</span></CustomTitleBar>);
      const band = getByTestId("custom-titlebar");
      // 3 x 44px buttons + the 4px tight gap, as BAND_LEAD_PAD_DARWIN clears the lights; 12px on the far edge.
      expect(band.style.paddingLeft).toBe("136px");
      expect(band.style.paddingRight).toBe("12px");
      expect(render(<CustomTitleBar leadClearance={300} />).getAllByTestId("custom-titlebar")[1].style.paddingLeft).toBe("300px");
    });

    it("still drags from the band and toggles maximize on double-click", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.doubleClick(getByTestId("custom-titlebar"));
      expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
      fireEvent.click(getByTestId("titlebar-close"));
      expect(mockClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Windows (controls trailing)", () => {
    beforeEach(() => setupBridges(false));

    it("keeps minimize, maximize, close at the trailing edge", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar")).toHaveAttribute("data-window-controls", "trailing");
      expect([...getByTestId("titlebar-controls").children].map((button) => button.getAttribute("data-testid"))).toEqual(["titlebar-minimize", "titlebar-maximize", "titlebar-close"]);
    });

    it("renders the full control bar", () => {
      const { getByTestId, queryByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar")).toBeTruthy();
      expect(queryByTestId("custom-titlebar-darwin")).toBeNull();
    });

    it("lets the window material show through the band, as on macOS", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar")).toHaveClass("ave-glass-clear");
    });

    it("renders minimize, maximize, and close buttons", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("titlebar-minimize")).toBeTruthy();
      expect(getByTestId("titlebar-maximize")).toBeTruthy();
      expect(getByTestId("titlebar-close")).toBeTruthy();
    });

    it("right-aligns the − □ × cluster even with no children", () => {
      // Regression guard: the band has no `justify-*`, so the control wrapper
      // must carry `ml-auto` to pin the cluster to the trailing corner. Without
      // it, a no-children render strands the buttons flush-left. The main
      // window happens to work via the child MainToolbar's own flex-1.
      const { getByTestId } = render(<CustomTitleBar />);
      const controlWrapper = getByTestId("titlebar-minimize").parentElement;
      expect(controlWrapper?.className).toContain("ml-auto");
    });

    it("clicking minimize calls window:minimize IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.click(getByTestId("titlebar-minimize"));
      expect(mockMinimize).toHaveBeenCalledTimes(1);
    });

    it("clicking maximize calls window:toggleMaximize IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.click(getByTestId("titlebar-maximize"));
      expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
    });

    it("clicking close calls window:close IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.click(getByTestId("titlebar-close"));
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it("double-clicking drag band calls window:toggleMaximize IPC", () => {
      const { getByTestId } = render(<CustomTitleBar />);
      fireEvent.doubleClick(getByTestId("custom-titlebar"));
      expect(mockToggleMaximize).toHaveBeenCalledTimes(1);
    });

    it("hides entirely when fullscreen event fires", async () => {
      const { queryByTestId } = render(<CustomTitleBar />);
      expect(queryByTestId("custom-titlebar")).toBeTruthy();
      await act(async () => {
        fullscreenListener?.(true);
      });
      expect(queryByTestId("custom-titlebar")).toBeNull();
    });

    it("keeps the sidebar reopen control available in fullscreen without native controls", async () => {
      const { getByRole, queryByTestId } = render(
        <CustomTitleBar keepVisibleInFullscreen><button>Show sidebar</button></CustomTitleBar>,
      );
      await act(async () => { fullscreenListener?.(true); });
      expect(getByRole("button", { name: "Show sidebar" })).toBeVisible();
      expect(queryByTestId("titlebar-minimize")).toBeNull();
      expect(queryByTestId("titlebar-maximize")).toBeNull();
      expect(queryByTestId("titlebar-close")).toBeNull();
    });

    it("maximize icon toggles when maximized event fires", async () => {
      const { getByTestId } = render(<CustomTitleBar />);
      // Not maximized initially: one square (Windows caption maximize), title 최대화
      expect(getByTestId("titlebar-maximize").title).toBe("최대화");
      expect(getByTestId("titlebar-maximize").querySelector("svg.lucide-square")).not.toBeNull();
      await act(async () => {
        maxListener?.(true);
      });
      // Maximized: two overlapping squares (caption restore)
      expect(getByTestId("titlebar-maximize").title).toBe("이전 크기로");
      expect(getByTestId("titlebar-maximize").querySelector("svg.lucide-copy")).not.toBeNull();
      expect(getByTestId("titlebar-maximize").querySelector("svg.lucide-square")).toBeNull();
    });

    it("names each window button for assistive tech, maximize switching to restore", async () => {
      const { getByRole, getByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("titlebar-minimize")).toHaveAttribute("aria-label", "최소화");
      expect(getByTestId("titlebar-maximize")).toHaveAttribute("aria-label", "최대화");
      expect(getByTestId("titlebar-close")).toHaveAttribute("aria-label", "닫기");
      expect(getByRole("button", { name: "최소화" })).toHaveAttribute("data-testid", "titlebar-minimize");
      expect(getByRole("button", { name: "최대화" })).toHaveAttribute("data-testid", "titlebar-maximize");
      expect(getByRole("button", { name: "닫기" })).toHaveAttribute("data-testid", "titlebar-close");
      await act(async () => { maxListener?.(true); });
      expect(getByRole("button", { name: "이전 크기로" })).toHaveAttribute("aria-label", "이전 크기로");
    });
  });

  describe("no bottom rule under the band", () => {
    // The owner removed the band's underline on every platform; the tile cards below carry the only edge.
    function expectNoRule(band: HTMLElement) {
      expect(band).not.toHaveClass("border-b");
      expect(band.className).not.toMatch(/(^|\s)(border-b|border-border|shadow)\S*/);
    }
    it.each([
      ["macOS", true, "native", "custom-titlebar-darwin"],
      ["Windows", false, "trailing", "custom-titlebar"],
      ["Linux", false, "leading", "custom-titlebar"],
    ] as const)("%s band", (_name, darwin, controls, testId) => {
      setupBridges(darwin, controls);
      expectNoRule(render(<CustomTitleBar />).getByTestId(testId));
    });
    it("plain band without a bridge", () => {
      expectNoRule(render(<CustomTitleBar><span>path</span></CustomTitleBar>).getByTestId("custom-titlebar-plain"));
    });
  });

  it.each(["native", "leading", "trailing"] as const)("keeps the %s controls reserved and notice clicks separate from dragging", (placement) => {
    setupBridges(placement === "native", placement);
    const { getByTestId, queryByTestId } = render(
      <CustomTitleBar keepVisibleInFullscreen>
        <div className="flex min-w-0 flex-1">
          <StatusBar persistent={[]} toastPlacement="titlebar" visibleToast={{ id: "notice", message: "Ready", severity: "error", expiresAt: Number.POSITIVE_INFINITY, sticky: true }} onToastDismiss={vi.fn()} />
        </div>
      </CustomTitleBar>,
    );
    const band = getByTestId(placement === "native" ? "custom-titlebar-darwin" : "custom-titlebar");
    expect(band.style.getPropertyValue("-webkit-app-region") || (band.style as unknown as Record<string, string>).WebkitAppRegion).toBe("drag");
    if (placement === "native") expect(Number.parseFloat(band.style.paddingLeft)).toBeGreaterThanOrEqual(80);
    else {
      expect(getByTestId("titlebar-controls")).toHaveClass("shrink-0");
      fireEvent.click(getByTestId("titlebar-minimize"));
      expect(mockMinimize).toHaveBeenCalledOnce();
    }
    fireEvent.doubleClick(getByTestId("status-toast"));
    expect(mockToggleMaximize).not.toHaveBeenCalled();
    expect(queryByTestId("status-toast-dismiss")).not.toBeNull();
  });

  describe("missing bridge (non-Electron environment)", () => {
    it("renders nothing if avePlatform is absent", () => {
      delete (window as unknown as Record<string, unknown>).avePlatform;
      const { container } = render(<CustomTitleBar />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
