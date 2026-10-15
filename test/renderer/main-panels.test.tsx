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
import { SURFACE_DRAG_TYPE } from "../../src/ui/renderer/preview/surface-moves.js";

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

  async function openSideTerminal(container: HTMLElement): Promise<string> {
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="pane-panel-toggle"]')!;
    await act(async () => { fireEvent.click(toggle); });
    const launcher = await waitFor(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-launcher-terminal"]');
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => { fireEvent.click(launcher); });
    const tab = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="chat-side-panel-tab-strip"] [data-tab-id^="terminal:"]');
      expect(el).not.toBeNull();
      return el!;
    });
    return tab.getAttribute("data-tab-id")!;
  }

  function sideTabIds(): string[] {
    return [...document.querySelectorAll<HTMLElement>('[data-testid="chat-side-panel-tab-strip"] [data-tab-id]')]
      .map((el) => el.getAttribute("data-tab-id")!);
  }

  /** jsdom has no DataTransfer; a drag carries its data through this stand-in. */
  function dataTransfer() {
    const data = new Map<string, string>();
    return {
      get types() { return [...data.keys()]; },
      setData: (type: string, value: string) => { data.set(type, value); },
      getData: (type: string) => data.get(type) ?? "",
      files: [] as File[],
      effectAllowed: "all",
      dropEffect: "none",
    };
  }

  it("moves a side-panel terminal to the main area and back under the same id", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    const tabId = await openSideTerminal(container);

    const move = document.querySelector<HTMLButtonElement>(`[data-tab-id="${tabId}"] [data-testid="chat-side-panel-move-to-main"]`)!;
    await act(async () => { fireEvent.click(move); });
    await waitFor(() => expect(shownSurfaces(container)).toEqual([{ kind: "terminal", tabId }]));
    expect(sideTabIds()).not.toContain(tabId);

    const toSide = container.querySelector<HTMLButtonElement>('[data-testid="surface-pane"]')!
      .closest('[data-testid="pane"]')!
      .querySelector<HTMLButtonElement>('[data-testid="pane-action-surface.moveToSide"]')!;
    await act(async () => { fireEvent.click(toSide); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));
    await waitFor(() => expect(sideTabIds()).toContain(tabId));
  });

  it("drops a dragged side tab on a pane, and a pane's header on the side panel's tabs", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    const tabId = await openSideTerminal(container);
    const transfer = dataTransfer();
    const tabButton = document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"] [role="tab"]`)!;
    expect(tabButton.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(tabButton, { dataTransfer: transfer });
    expect(transfer.types).toContain(SURFACE_DRAG_TYPE);
    const pane = container.querySelector<HTMLElement>('[data-testid="pane-cell:main"] [data-testid="pane"]')!;
    fireEvent.dragOver(pane, { dataTransfer: transfer, clientX: 0, clientY: 0 });
    await act(async () => { fireEvent.drop(pane, { dataTransfer: transfer, clientX: 0, clientY: 0 }); });
    await waitFor(() => expect(shownSurfaces(container).map((each) => each.tabId)).toEqual([tabId]));

    // Back: the pane's header is the handle, the side panel's tab strip the target.
    const header = container.querySelector<HTMLElement>('[data-testid="surface-pane"]')!
      .closest('[data-testid="pane"]')!
      .querySelector<HTMLElement>('[data-testid="pane-header"]')!;
    expect(header.getAttribute("draggable")).toBe("true");
    const back = dataTransfer();
    fireEvent.dragStart(header, { dataTransfer: back });
    const strip = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="chat-side-panel-tab-strip"]');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.dragOver(strip, { dataTransfer: back });
    await act(async () => { fireEvent.drop(strip, { dataTransfer: back }); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));
    expect(sideTabIds()).toContain(tabId);
  });

  it("moves the focused pane's surface to its neighbour with the directional chord", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const terminal = shownSurfaces(container)[0]!;
    await splitIntoTwoTiles(container);
    await clickSidebarNavRow("features", "sidebar-web");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(2));
    const cellOf = (tabId: string | null) => container.querySelector(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`)!
      .closest('[data-testid^="pane-cell:"]')!.getAttribute("data-testid");
    expect(cellOf(terminal.tabId)).toBe("pane-cell:main");
    // Focus the terminal's pane, then move it right: the two swap.
    const terminalPane = container.querySelector<HTMLElement>(`[data-testid="surface-pane"][data-tab-id="${terminal.tabId}"]`)!.closest('[data-testid="pane"]')!;
    await act(async () => { fireEvent.mouseDown(terminalPane); });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true, shiftKey: true, altKey: true });
    });
    await waitFor(() => expect(cellOf(terminal.tabId)).not.toBe("pane-cell:main"));
  });
});
