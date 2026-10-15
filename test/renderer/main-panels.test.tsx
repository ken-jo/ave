/**
 * Terminal and web panels in the main area, driven through the real app: the
 * sidebar rows that open them, the panes that hold them, and the rule that a
 * surface is in one pane at a time while two panes may each hold one.
 */
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { clickSidebarNavRow, splitIntoTwoTiles } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

function surfacePanes(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="surface-pane"]')];
}

function shownSurfaces(container: HTMLElement): Array<{ kind: string | null; tabId: string | null }> {
  return surfacePanes(container)
    .filter((pane) => pane.closest('[data-hidden="true"]') === null)
    .map((pane) => ({ kind: pane.getAttribute("data-surface-kind"), tabId: pane.getAttribute("data-tab-id") }));
}

describe("main-area terminal and web panels", () => {
  it("opens a terminal and a web page in the focused pane from the sidebar, and returns to a running terminal", async () => {
    const { container } = await renderApp({ hasApiKey: true });

    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const [terminal] = shownSurfaces(container);
    expect(terminal!.kind).toBe("terminal");
    expect(terminal!.tabId).toMatch(/^terminal:\d+$/);
    // The pane holds it at its own location, so the PTY view is the pane's.
    expect(container.querySelector('[data-testid="pane-header"]')).not.toBeNull();

    await clickSidebarNavRow("features", "sidebar-web");
    await waitFor(() => expect(shownSurfaces(container)[0]?.kind).toBe("browser"));
    expect(container.querySelector('[data-testid="web-panel-empty"]')).not.toBeNull();

    // The terminal the pane left is still running; the row brings THAT one back.
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)[0]).toEqual(terminal));
  });

  it("lets two panes each hold a terminal of their own", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const first = shownSurfaces(container)[0]!;

    await splitIntoTwoTiles(container);
    await clickSidebarNavRow("features", "sidebar-terminal");
    // No unshown terminal is left, so the new pane gets a new one.
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(2));
    const ids = shownSurfaces(container).map((each) => each.tabId);
    expect(ids).toContain(first.tabId);
    expect(new Set(ids).size).toBe(2);
  });

  it("closes a terminal pane's surface and gives the pane back its conversation", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const close = container.querySelector<HTMLButtonElement>('[data-testid="surface-pane"]')!
      .closest('[data-testid="pane"]')!
      .querySelector<HTMLButtonElement>('[data-testid="pane-close"]')!;
    await act(async () => { fireEvent.click(close); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));
    // Closed, not parked: the sidebar row now opens a new terminal.
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
  });
});
