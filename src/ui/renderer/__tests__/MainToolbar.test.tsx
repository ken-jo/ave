import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "../../../components/ui/tooltip.js";
import { MainToolbar } from "../MainToolbar.js";
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
  it("no longer renders a hamburger / more-menu trigger", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("더 많은 메뉴")).toBeNull();
    expect(screen.queryByTitle("홈")).toBeNull();
    expect(screen.queryByText("새 대화")).toBeNull();
    expect(document.querySelector("[data-testid='token-progress-ring']")).toBeNull();
  });

  it("names the location on its leading edge, where the sidebar card ends", () => {
    // History (back/forward) moved to the sidebar, which owns routes. The PATH stays on the band: it says WHERE THE WINDOW IS,
    // and giving it a row of its own below the band cost 28px of every screen to repeat that.
    renderWithProvider(defaultProps());
    const crumb = document.querySelector("[data-testid='view-path-breadcrumb']");
    expect(crumb).toBeTruthy();
    expect(crumb!.textContent).toContain("대화");
    // It is a path, not a Home button — no history controls come with it.
    expect(screen.queryByTestId(TEST_IDS.viewPathBack)).toBeNull();
  });

  // The search / star / export controls + the collapse toggle moved to the sidebar cluster strip — the band must NOT host
  // them anymore.
  it("no longer renders the search / star / export controls (they live in the sidebar cluster)", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTitle("통합 검색 (Cmd/Ctrl+F)")).toBeNull();
    expect(screen.queryByTitle("현재 세션 핀 고정")).toBeNull();
    expect(screen.queryByTestId("toolbar-export")).toBeNull();
  });

  it("no longer renders the sidebar collapse toggle (it lives in the sidebar cluster)", () => {
    renderWithProvider(defaultProps());
    expect(screen.queryByTestId("sidebar-collapse-toggle")).toBeNull();
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
