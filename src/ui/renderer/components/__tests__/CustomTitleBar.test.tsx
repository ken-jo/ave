// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent, waitFor } from "@testing-library/react";
import { CustomTitleBar } from "../CustomTitleBar.js";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider.js";
import { DEFAULT_BUNDLE_ID, setInstalledThemeBundles, type ThemeBundle } from "../../theme/bundles/index.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../../installed-content.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { installedTheme, installedThemeContent, NO_LANGUAGE_BRIDGE } from "../../../../../test/renderer/installed-theme.js";

const mockMinimize = vi.fn().mockResolvedValue(undefined);
const mockToggleMaximize = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockSyncTheme = vi.fn().mockResolvedValue(undefined);

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

function setupBridges(isDarwin: boolean) {
  (window as unknown as Record<string, unknown>).avePlatform = { isDarwin };
  (window as unknown as Record<string, unknown>).aveWindow = {
    minimize: mockMinimize,
    toggleMaximize: mockToggleMaximize,
    close: mockClose,
    syncTitleBarTheme: mockSyncTheme,
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

  describe("Win/Linux (isDarwin=false)", () => {
    beforeEach(() => setupBridges(false));

    it("renders the full control bar", () => {
      const { getByTestId, queryByTestId } = render(<CustomTitleBar />);
      expect(getByTestId("custom-titlebar")).toBeTruthy();
      expect(queryByTestId("custom-titlebar-darwin")).toBeNull();
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

  describe("native overlay colors follow the applied theme (Win/Linux)", () => {
    beforeEach(() => setupBridges(false));
    afterEach(() => {
      resetInstalledContentForTests();
      setInstalledThemeBundles([]);
    });

    const reload = (themes: ThemeBundle[]) => applyInstalledContent(installedThemeContent(themes), NO_LANGUAGE_BRIDGE);

    it("sends the colors ThemeProvider wrote, including after the shown theme is updated in place", async () => {
      const harbor = installedTheme("harbor", "dark", { background: "210 40% 12%", foreground: "0 0% 100%" });
      const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: "harbor" } } });
      act(() => { reload([harbor]); });
      render(
        <ThemeProvider api={api as never} initialBundleId="harbor">
          <CustomTitleBar />
        </ThemeProvider>,
      );
      await waitFor(() => expect(mockSyncTheme).toHaveBeenLastCalledWith("#121f2b", "#ffffff"));

      // Same id, same shell: only the values change.
      await act(async () => { reload([{ ...harbor, tokens: { ...harbor.tokens, background: "210 40% 18%", foreground: "0 0% 95%" } }]); });

      await waitFor(() => expect(mockSyncTheme).toHaveBeenLastCalledWith("#1c2e40", "#f2f2f2"));
    });

    it("sends the new theme's colors, not the replaced theme's, when the shell flips", async () => {
      const harbor = installedTheme("harbor", "dark", { background: "210 40% 12%", foreground: "0 0% 100%" });
      const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: DEFAULT_BUNDLE_ID } } });
      act(() => { reload([harbor]); });
      let pick: ((id: string) => void) | null = null;
      function Picker() {
        pick = useTheme().setBundle;
        return null;
      }
      render(
        <ThemeProvider api={api as never} initialBundleId={DEFAULT_BUNDLE_ID}>
          <Picker />
          <CustomTitleBar />
        </ThemeProvider>,
      );
      await waitFor(() => expect(pick).not.toBeNull());
      mockSyncTheme.mockClear();

      act(() => { pick!("harbor"); });

      await waitFor(() => expect(mockSyncTheme).toHaveBeenLastCalledWith("#121f2b", "#ffffff"));
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
