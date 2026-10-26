import "../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collapsedBandLeadClearance } from "../../../shared/shell-geometry.js";
import { clickSidebarNavRow, mountedTileIds, openSidebarGroup, sidebarNavRowActive, splitIntoNTiles } from "../../../../test/renderer/helpers.js";
import { MAX_PANES } from "../../../contract/app-contract.js";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/renderer/render-app.js";

/** Drive navigation through actual controls to verify inline routing and sidebar selection across shell widths. */
describe("App inline navigation", () => {
  afterEach(() => vi.restoreAllMocks());

  async function collapseSidebar(container: HTMLElement) {
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="sidebar-collapse-toggle"]');
    expect(toggle).not.toBeNull();
    await act(async () => { fireEvent.click(toggle!); });
    await waitFor(() => expect(toggle!.getAttribute("aria-pressed")).toBe("false"));
  }

  // The built-in views live in the Features group's flyout in BOTH sidebar states — the collapsed rail opens the same flyout
  // from its icon, so nothing has to expand. Rows render in a portal: read them from `document`.
  async function openFeaturesFlyout(container: HTMLElement) {
    expect(container.querySelector('[data-testid="sidebar-group-features"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="toolbar-work-board"]')).toBeNull();
    await openSidebarGroup("features");
    await waitFor(() => {
      expect(document.querySelector('[data-testid="toolbar-work-board"]')).not.toBeNull();
    });
  }

  it("renders a built-in view inline on a narrow canvas and lights up its sidebar entry", async () => {
    const { container } = await renderApp({ hasApiKey: true, shellWidth: 600, canvasWidth: 600 });
    await collapseSidebar(container);
    await openFeaturesFlyout(container);

    const workBoardNav = document.querySelector('[data-testid="toolbar-work-board"]') as HTMLButtonElement;
    // Nothing is selected yet, so the entry starts unlit — otherwise the assertion below could pass on a highlight that was
    // never off.
    expect(workBoardNav.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-group-features"]')?.getAttribute("data-active")).toBeNull();

    await act(async () => {
      fireEvent.click(workBoardNav);
    });

    // Inline: the main pane switched off the chat surface. Visit history is owned by the top toolbar, so the content surface
    // has no duplicate back.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="main-pane-shell"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="view-path-current-work-board"]')).not.toBeNull();
    });
    // Hidden, not unmounted: a tile subscribes to its group's stream when it mounts, so swapping it out for the work board
    // would drop the frames of a turn still in flight — along with the composer draft and scroll position.
    expect(
      container.querySelector('[data-testid="chat-surface"]')?.getAttribute("data-visible"),
    ).toBe("false");

    // The pick closed the flyout; the group now reports the page as one of its rows, and the row itself says so once the
    // flyout is opened again.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="sidebar-group-features-menu"]')).toBeNull();
      expect(container.querySelector('[data-testid="sidebar-group-features"]')?.getAttribute("data-active")).toBe("true");
    });
    expect(await sidebarNavRowActive("features", "toolbar-work-board")).toBe(true);
    // The rail stayed collapsed — the flyout needed no expansion.
    expect(container.querySelector('[data-testid="sidebar-card"]')?.getAttribute("data-surface")).toBe("bare");
  });

  it("renders a built-in view inline on a wide canvas", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "sidebar-routines");

    await waitFor(() => {
      expect(container.querySelector('[data-testid="sidebar-group-features"]')?.getAttribute("data-active")).toBe("true");
    });
    expect(await sidebarNavRowActive("features", "sidebar-routines")).toBe(true);
  });

  it("keeps navigating inline after the canvas narrows", async () => {
    const { container, resizeContainers } = await renderApp({ hasApiKey: true });

    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-work-board"]')).not.toBeNull();
    });
    expect(await sidebarNavRowActive("features", "toolbar-work-board")).toBe(true);

    await resizeContainers({ shellWidth: 600, canvasWidth: 600 });

    await clickSidebarNavRow("features", "sidebar-routines");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-routines"]')).not.toBeNull();
    });
    expect(await sidebarNavRowActive("features", "sidebar-routines")).toBe(true);
    expect(await sidebarNavRowActive("features", "toolbar-work-board")).toBe(false);
  });

  it("opens a row in a NEW pane when the click carries the modifier", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await waitFor(() => expect(mountedTileIds(container)).toHaveLength(1));

    await clickSidebarNavRow("features", "sidebar-routines", { metaKey: true });

    // A second pane, and the view in it: the pane the gesture made is the one focus is on, so the ordinary selection landed
    // there.
    await waitFor(() => expect(mountedTileIds(container)).toHaveLength(2));
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-routines"]')).not.toBeNull();
    });
    const [, second] = mountedTileIds(container);
    expect(
      container.querySelector(`[data-testid="pane-cell:${second}"] [data-testid="pane"]`)
        ?.getAttribute("data-focused"),
    ).toBe("true");

    // A plain click on the same row replaces the focused pane's content and adds nothing — the two gestures differ, and not by
    // accident.
    await clickSidebarNavRow("features", "toolbar-work-board");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-work-board"]')).not.toBeNull();
    });
    expect(mountedTileIds(container)).toHaveLength(2);
  });

  it("says so, and opens nothing, when the canvas has no room for another pane", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await splitIntoNTiles(container, MAX_PANES);
    expect(mountedTileIds(container)).toHaveLength(MAX_PANES);

    await clickSidebarNavRow("features", "sidebar-routines", { metaKey: true });

    // The refusal is SAID. A menu row that quietly does nothing is the one outcome a user cannot tell apart from a broken app.
    await waitFor(() => {
      const toasts = container.querySelectorAll('[data-testid="status-toast-message"]');
      expect([...toasts].some((el) => el.textContent?.includes("자리가 없습니다"))).toBe(true);
    });
    expect(mountedTileIds(container)).toHaveLength(MAX_PANES);
    // And nothing moved: the refusal is not a quiet navigation either.
    expect(container.querySelector('[data-testid="view-path-current-routines"]')).toBeNull();
  });

  it("offers no new-pane gesture on a narrow canvas", async () => {
    const { container } = await renderApp({ hasApiKey: true, shellWidth: 600, canvasWidth: 600 });

    await clickSidebarNavRow("features", "sidebar-routines", { metaKey: true });

    // The modifier is inert here, so the row does what a plain click does.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="view-path-current-routines"]')).not.toBeNull();
    });
    expect(mountedTileIds(container)).toHaveLength(1);
  });

  it("starts the band's path past the sidebar's bare cluster strip once the rail is collapsed", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    // jsdom has no preload bridge, so the band is the plain variant and the platform is not darwin — the same two facts the
    // clearance is asked with.
    const band = await waitFor(() => {
      const el = container.querySelector('[data-testid="custom-titlebar-plain"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(band.querySelector('[data-testid="view-path-breadcrumb"]')).not.toBeNull();
    const expandedLead = Number.parseFloat(band.style.paddingLeft);

    await collapseSidebar(container);

    // Collapsed: the card retracts but its cluster strip stays on the band, so the band pads past that strip (CDP:
    // `view-path-breadcrumb`.left must be >= `sidebar-cluster`.right + SHELL_GUTTER) instead of the rail reserve.
    await waitFor(() => {
      expect(band.style.paddingLeft).toBe(`${collapsedBandLeadClearance(false)}px`);
    });
    expect(container.querySelector('[data-testid="sidebar-cluster"]')).not.toBeNull();
    expect(collapsedBandLeadClearance(false)).toBeLessThan(expandedLead);
  });
});
