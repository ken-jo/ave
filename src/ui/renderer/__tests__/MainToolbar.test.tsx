import { setContainerWidths } from "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { DEFAULT_APPEARANCE } from "../../../shared/appearance-settings.js";
import { userEvent } from "@testing-library/user-event";
import { TEST_IDS } from "../../../shared/test-ids.js";

function defaultProps(overrides: Partial<Parameters<typeof MainToolbar>[0]> = {}) {
  return {
    streaming: false,
    hasApiKey: true as boolean | null,
    viewNav: {
      segments: [{ key: "home", label: "대화" }],
      canGoBack: false,
      canGoForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onSelectSegment: vi.fn(),
    },
    ...overrides,
  };
}

function renderWithProvider(props: Parameters<typeof MainToolbar>[0]) {
  return render(
    <TooltipProvider>
      <MainToolbar {...props} />
    </TooltipProvider>,
  );
}

/** The band's own controls, in the order the row is asserted to hold them. */
const TRACKED_TOOLBAR_IDS = [
  "app-update-badge-available",
  "marketplace-update-action",
  "bootstrap-status-pill",
  "dev-tools-toggle",
];

describe("MainToolbar", () => {
  // The band hosts right-aligned lifecycle and development controls. The search / star / export controls + the
  // collapse toggle moved into the floating sidebar's cluster strip next to the
  // traffic lights (see Sidebar.tsx / Sidebar tests).
  it("keeps status pills inline without an overflow button on wide screens", () => {
    renderWithProvider(defaultProps({ appUpdateState: { kind: "available", version: "9.9.9" } }));
    expect(screen.queryByTestId("toolbar-status-overflow")).toBeNull();
    expect(screen.getByRole("button", { name: /9.9.9/ })).toBe(screen.getByTestId("app-update-badge-available"));
  });

  it("puts back / forward and then the location on its leading edge", () => {
    // The band carries route history and the path: the sidebar is a rail of launchers and views now, with no strip for history.
    renderWithProvider(defaultProps());
    const crumb = document.querySelector("[data-testid='view-path-breadcrumb']");
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toContain("대화");
    const back = screen.getByTestId(TEST_IDS.viewPathBack);
    expect(back.compareDocumentPosition(crumb!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Search lives on the rail, and the band's unfold button belongs to App, not to the toolbar.
  it("does not render the search / star / export controls", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("통합 검색 (Cmd/Ctrl+F)")).toBeNull();
    expect(screen.queryByTitle("현재 세션 핀 고정")).toBeNull();
    expect(screen.queryByTestId("toolbar-export")).toBeNull();
  });

  it("does not render the sidebar collapse toggle itself", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTestId("sidebar-collapse-toggle")).toBeNull();
  });

  it("reserves the notice slot between breadcrumbs and status controls without marking the free space no-drag", () => {
    renderWithProvider(defaultProps({
      notice: <div data-testid="window-notice-slot">Notice</div>,
      bootstrapStatus: { status: { phase: "complete", installed: [], failed: [], skipped: { reason: "e2e-isolated" } }, onDismiss: vi.fn(), onRetry: vi.fn() },
    }));
    const slot = screen.getByTestId("main-toolbar-drag-band");
    expect(slot).toHaveClass("flex-1", "min-w-min");
    expect(slot).toContainElement(screen.getByTestId("window-notice-slot"));
    expect(slot.closest('[style*="no-drag"]')).toBeNull();
    const crumb = screen.getByTestId("view-path-breadcrumb");
    expect(crumb.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const chip = screen.getByTestId("bootstrap-status-pill");
    expect(slot.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses a counted overflow menu on narrow screens and preserves each update action", async () => {
    await act(async () => { setContainerWidths({ canvasWidth: 360 }); });
    const onReview = vi.fn();
    const onDownload = vi.fn();
    const updates = [{ key: { sourceId: "ave", kind: "plugin" as const, name: "meeting" }, displayName: "Meeting", from: "1.0.0", to: "2.0.0", state: "manual" as const }];
    renderWithProvider(defaultProps({ appUpdateState: { kind: "available", version: "9.9.9" }, onDownloadAppUpdate: onDownload, pluginUpdates: { updates, onSkip: vi.fn(), onReview } }));
    const user = userEvent.setup();
    expect(await screen.findByTestId("toolbar-status-overflow-count")).toHaveTextContent("2");
    expect(screen.queryByTestId("marketplace-update-action")).toBeNull();
    await user.click(await screen.findByTestId("toolbar-status-overflow"));
    expect(screen.getByTestId("marketplace-update-action")).toHaveAttribute("role", "menuitem");
    await user.click(screen.getByTestId("marketplace-update-action"));
    expect(onReview).toHaveBeenCalledWith(updates);
    await user.click(await screen.findByTestId("toolbar-status-overflow"));
    await user.click(screen.getByTestId("app-update-badge-available"));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it("keeps popup status controls usable from the overflow menu", async () => {
    await act(async () => { setContainerWidths({ canvasWidth: 360 }); });
    render(<TooltipProvider><ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, zoomLevel: 1 }}><MainToolbar {...defaultProps()} /></ThemeProvider></TooltipProvider>);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("toolbar-status-overflow"));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("zoom-controls")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("zoom-controls")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("toolbar-status-menu")).toBeNull();
  });

  it("lines the lifecycle pills up in one row, app update first", () => {
    renderWithProvider(defaultProps({
      appUpdateState: { kind: "available", version: "9.9.9" },
      pluginUpdates: {
        updates: [{ key: { sourceId: "ave", kind: "plugin", name: "meeting" }, displayName: "Meeting", from: "1.0.0", to: "2.0.0", state: "manual" }],
        onSkip: vi.fn(),
        onReview: vi.fn(),
      },
      bootstrapStatus: {
        status: { phase: "complete", installed: [], failed: [{ id: "meeting", error: "tarball 404" }] },
        onDismiss: vi.fn(),
        onRetry: vi.fn(),
      },
    }));

    const toolbar = screen.getByTestId("main-toolbar");
    const order = Array.from(toolbar.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id): id is string => id !== null && TRACKED_TOOLBAR_IDS.includes(id));

    expect(order).toEqual([
      "app-update-badge-available",
      "marketplace-update-action",
      "bootstrap-status-pill",
    ]);
  });

  it("keeps a lifecycle pill out of the band while its subject is at rest", () => {
    renderWithProvider(defaultProps({
      pluginUpdates: {
        updates: [],
        onSkip: vi.fn(),
        onReview: vi.fn(),
      },
      bootstrapStatus: { status: null, onDismiss: vi.fn(), onRetry: vi.fn() },
    }));

    expect(screen.queryByTestId("marketplace-update-action")).toBeNull();
    expect(screen.queryByTestId("bootstrap-status-pill")).toBeNull();
    expect(screen.queryByTestId("app-update-badge-available")).toBeNull();
  });

  it("draws the Dev badge as the band's shared status pill, keyboard hint and all", () => {
    // The keyboard hint uses the shared pill's trailing slot without changing the control's accessible name.
    vi.stubGlobal("__aveDevMode", true);
    const onOpenDevTools = vi.fn();
    renderWithProvider(defaultProps({ onOpenDevTools }));

    const pill = screen.getByTestId("dev-tools-toggle");
    expect(pill.getAttribute("aria-label")).toBe("Dev Tools (Cmd/Ctrl+Shift+D)");
    expect(pill.textContent).toContain("Dev");
    expect(pill.textContent).toContain("⇧⌘D");

    fireEvent.click(pill);
    expect(onOpenDevTools).toHaveBeenCalledOnce();
  });

  it("no longer renders the work-panel toggle (each chat group owns its panel)", () => {
    // One window-level button cannot mean the right thing once more than one conversation is on screen, so the control moved
    // into the group header.
    renderWithProvider(defaultProps());
    expect(screen.queryByTestId(TEST_IDS.panePanelToggle)).toBeNull();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("shows the title zoom popover only away from the default level", () => {
 const view = render(<TooltipProvider><ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, zoomLevel: 1 }}><MainToolbar {...defaultProps()} /></ThemeProvider></TooltipProvider>);
 const indicator = screen.getByTestId("zoom-indicator");
 expect(indicator).toHaveClass("h-(--chrome-icon-button)", "w-(--chrome-icon-button)", "p-0");
 expect(indicator).not.toHaveClass("h-10", "w-10");
 expect(indicator).toHaveAttribute("aria-label", expect.stringContaining("120%"));
 fireEvent.click(indicator);
 expect(screen.getByText("120%")).toBeInTheDocument();
 expect(screen.getByRole("button", { name: /Num0/ })).toBeEnabled();
 view.unmount();
 render(<TooltipProvider><ThemeProvider initialAppearance={DEFAULT_APPEARANCE}><MainToolbar {...defaultProps()} /></ThemeProvider></TooltipProvider>);
 expect(screen.queryByTestId("zoom-indicator")).toBeNull();
});
