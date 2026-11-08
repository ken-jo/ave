// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";
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
      // Not maximized initially — Maximize2 icon (title = 최대화)
      expect(getByTestId("titlebar-maximize").title).toBe("최대화");
      await act(async () => {
        maxListener?.(true);
      });
      expect(getByTestId("titlebar-maximize").title).toBe("이전 크기로");
    });
  });

  describe("missing bridge (non-Electron environment)", () => {
    it("renders nothing if avePlatform is absent", () => {
      delete (window as unknown as Record<string, unknown>).avePlatform;
      const { container } = render(<CustomTitleBar />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
