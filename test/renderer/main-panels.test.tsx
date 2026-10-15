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
import { getTerminalAttention, markTerminalRead } from "../../src/ui/renderer/preview/terminal-attention.js";

// The terminal suites below give the app a terminal surface, which mounts
// xterm; jsdom has no canvas, so xterm is the one thing stood in for.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => {
  for (const tabId of [...getTerminalAttention().keys()]) markTerminalRead(tabId);
  vi.restoreAllMocks();
});

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

  type TerminalDouble = { emitTerminalData: (tabId: string, chunk: string) => void };
  const notify = (api: unknown, tabId: string, message: string) =>
    act(() => { (api as { terminal: TerminalDouble }).terminal.emitTerminalData(tabId, `\x1b]9;${message}\x07`); });
  const jumpToUnread = () => act(() => {
    fireEvent.keyDown(window, { key: "u", ctrlKey: true, shiftKey: true });
  });

  /** jsdom lays nothing out; give every element a box so "on screen" holds as in the app. */
  function withLaidOutBoxes() {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(300);
  }

  it("rings a main terminal that asks for attention unless its pane has focus, and the jump chord focuses and reads it", async () => {
    withLaidOutBoxes();
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const terminal = shownSurfaces(container)[0]!;
    const terminalPane = () => container.querySelector(`[data-testid="surface-pane"][data-tab-id="${terminal.tabId}"]`)!.closest('[data-testid="pane"]')!;
    // Its pane has focus: the user is looking at it, so nothing rings.
    expect(terminalPane().getAttribute("data-focused")).toBe("true");
    notify(api, terminal.tabId!, "seen already");
    expect(getTerminalAttention().has(terminal.tabId!)).toBe(false);

    // Focus moves to the other half of a split: still on screen, but not attended.
    await splitIntoTwoTiles(container);
    await waitFor(() => expect(terminalPane().getAttribute("data-focused")).toBeNull());
    notify(api, terminal.tabId!, "build done");
    await waitFor(() => expect(terminalPane().getAttribute("data-attention")).toBe("true"));

    await jumpToUnread();
    await waitFor(() => expect(terminalPane().getAttribute("data-focused")).toBe("true"));
    expect(terminalPane().getAttribute("data-attention")).toBeNull();
  });

  it("badges a side-panel terminal tab that asks for attention, and the jump chord selects it", async () => {
    withLaidOutBoxes();
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true });
    const tabId = await openSideTerminal(container);
    // Another tab takes the front, so the terminal is out of view.
    // Radix opens the "+" menu on pointerdown.
    const add = document.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-add-tab"]')!;
    await act(async () => {
      fireEvent.pointerDown(add, { button: 0, ctrlKey: false });
      fireEvent.click(add);
    });
    const browser = await waitFor(() => {
      const item = document.querySelector<HTMLElement>('[data-testid="chat-side-panel-launcher-menu-browser"]');
      expect(item).not.toBeNull();
      return item!;
    });
    await act(async () => { fireEvent.click(browser); });
    const terminalTab = () => document.querySelector<HTMLElement>(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${tabId}"] [role="tab"]`)!;
    await waitFor(() => expect(terminalTab().getAttribute("aria-selected")).toBe("false"));

    notify(api, tabId, "tests passed");
    const dot = await waitFor(() => {
      const el = terminalTab().querySelector('[data-testid="chat-side-panel-tab-terminal-attention"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(dot.getAttribute("title")).toContain("tests passed");

    await jumpToUnread();
    await waitFor(() => expect(terminalTab().getAttribute("aria-selected")).toBe("true"));
    expect(terminalTab().querySelector('[data-testid="chat-side-panel-tab-terminal-attention"]')).toBeNull();
  });

  it("shows a main terminal's directory in its header and reopens a closed one there", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true });
    const terminalApi = (api as unknown as { terminal: { listBlocks: ReturnType<typeof vi.fn>; spawn: ReturnType<typeof vi.fn> } }).terminal;
    terminalApi.listBlocks.mockResolvedValue({
      ok: true,
      integrated: true,
      blocks: [{ id: 1, command: "cd app", cwd: "/work/repo/app", exitCode: 0, startedAt: 1, endedAt: 2, status: "done", source: "osc133", outputChars: 0, truncated: false }],
    });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const meta = await waitFor(() => {
      const el = container.querySelector('[data-testid="pane-header-meta"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(meta.textContent).toBe("app");
    expect(meta.getAttribute("title")).toBe("/work/repo/app");
    // A new shell starts where every new shell does.
    expect(terminalApi.spawn.mock.calls[0]![0]).not.toHaveProperty("cwd");

    const close = container.querySelector('[data-testid="surface-pane"]')!
      .closest('[data-testid="pane"]')!
      .querySelector<HTMLButtonElement>('[data-testid="pane-close"]')!;
    await act(async () => { fireEvent.click(close); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));

    await act(async () => {
      fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    await waitFor(() => expect(terminalApi.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: "/work/repo/app" })));
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
