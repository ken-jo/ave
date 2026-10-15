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
import { resetMainLayoutRestoreForTest } from "../../src/ui/renderer/preview/main-layout-restore.js";
import { MAIN_LAYOUT_SAVE_DELAY_MS } from "../../src/ui/renderer/hooks/use-main-layout.js";
import { MOCK_DEFAULT_SETTINGS } from "./mock-ave-api.js";

// The terminal suites below give the app a terminal surface, which mounts
// xterm; jsdom has no canvas, so xterm is the one thing stood in for.
const { xtermWrites } = vi.hoisted(() => ({ xtermWrites: [] as string[] }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write(text: string) { xtermWrites.push(text); }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => {
  xtermWrites.length = 0;
  resetMainLayoutRestoreForTest();
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
    expect(terminal!.tabId).toMatch(/^terminal:[0-9a-f]{8}-\d+$/);
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

  /** Open `tile`'s side panel and a terminal tab in it; the tab's id. */
  async function openSideTerminalIn(tile: HTMLElement): Promise<string> {
    await act(async () => { fireEvent.click(tile.querySelector('[data-testid="pane-panel-toggle"]')!); });
    const launcher = await waitFor(() => {
      const button = tile.ownerDocument.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-launcher-terminal"]');
      expect(button).not.toBeNull();
      return button!;
    });
    await act(async () => { fireEvent.click(launcher); });
    return waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="chat-side-panel-tab-strip"] [data-tab-id^="terminal:"]');
      expect(el).not.toBeNull();
      return el!.getAttribute("data-tab-id")!;
    });
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

  it("points the side chat at the terminal or page last brought into view, and lets the user drop it", async () => {
    const { container } = await renderApp({ hasApiKey: true, terminal: true, sideChat: true });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const mainTerminal = shownSurfaces(container)[0]!.tabId!;
    const tiles = await splitIntoTwoTiles(container);
    const chatTile = tiles[1]!.element;
    await act(async () => {
      fireEvent.click(chatTile.querySelector('[data-testid="pane-panel-toggle"]')!);
    });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-testid="chat-side-panel-launcher-side-chat"]')!);
    });
    const chip = () => document.querySelector<HTMLElement>('[data-testid="side-chat-target"] [data-tab-id]');
    // Moving to the side chat did not change what it acts on: the terminal shown last.
    await waitFor(() => expect(chip()?.getAttribute("data-tab-id")).toBe(mainTerminal));
    expect(chip()!.getAttribute("data-surface-kind")).toBe("terminal");

    await act(async () => { fireEvent.click(document.querySelector('[data-testid="side-chat-target-remove"]')!); });
    expect(chip()).toBeNull();

    // Focusing the terminal's pane again picks it back up.
    const terminalPane = container.querySelector(`[data-testid="surface-pane"][data-tab-id="${mainTerminal}"]`)!.closest('[data-testid="pane"]')!;
    await act(async () => { fireEvent.mouseDown(terminalPane); });
    await waitFor(() => expect(chip()?.getAttribute("data-tab-id")).toBe(mainTerminal));

    // A terminal brought to the front of the side panel takes over.
    const add = chatTile.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-add-tab"]')
      ?? document.querySelector<HTMLButtonElement>('[data-testid="chat-side-panel-add-tab"]')!;
    await act(async () => {
      fireEvent.pointerDown(add, { button: 0, ctrlKey: false });
      fireEvent.click(add);
    });
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="chat-side-panel-launcher-menu-terminal"]')!); });
    const sideTerminal = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="chat-side-panel-tab-strip"] [data-tab-id^="terminal:"]');
      expect(el).not.toBeNull();
      return el!.getAttribute("data-tab-id")!;
    });
    await waitFor(() => expect(chip()?.getAttribute("data-tab-id")).toBe(sideTerminal));

    // Closing the target clears it.
    await act(async () => {
      // The tab's close control is the last of its row.
      fireEvent.click(document.querySelector(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${sideTerminal}"] > button:last-child`)!);
    });
    await waitFor(() => expect(document.querySelector('[data-testid="side-chat-target"]')).toBeNull());
  });

  it("attaches a main terminal's block to the composer last typed in — the side chat, here", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true, sideChat: true });
    const terminalApi = (api as unknown as { terminal: { listBlocks: ReturnType<typeof vi.fn>; getBlock: ReturnType<typeof vi.fn> } }).terminal;
    const block = { id: 1, command: "npm test", cwd: "/work", exitCode: 0, startedAt: 1, endedAt: 2, status: "done", source: "osc133", outputChars: 3, truncated: false };
    terminalApi.listBlocks.mockResolvedValue({ ok: true, integrated: true, blocks: [block] });
    terminalApi.getBlock.mockResolvedValue({ ok: true, block: { ...block, output: "ok\n" } });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const tiles = await splitIntoTwoTiles(container);
    const chatTile = tiles[1]!.element;
    await act(async () => { fireEvent.click(chatTile.querySelector('[data-testid="pane-panel-toggle"]')!); });
    await act(async () => { fireEvent.click(document.querySelector('[data-testid="chat-side-panel-launcher-side-chat"]')!); });
    const sideDock = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="side-chat-composer-dock"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const sideInput = sideDock.querySelector<HTMLTextAreaElement>("textarea")!;
    const mainInput = chatTile.querySelector<HTMLTextAreaElement>('[data-composer-surface="main"] textarea')!;
    act(() => { sideInput.focus(); });

    const attach = await waitFor(() => {
      const el = container.querySelector<HTMLButtonElement>('[data-testid="surface-pane"] [data-testid="terminal-blocks-attach-last"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await act(async () => { fireEvent.click(attach); });
    await waitFor(() => expect(sideInput.value).not.toBe(""));
    expect(mainInput.value).toBe("");
  });

  it("saves the layout as it changes and puts it back at the next launch, with new shells in the saved directories", async () => {
    const first = await renderApp({ hasApiKey: true, terminal: true });
    const firstTerminal = (first.api as unknown as { terminal: { listBlocks: ReturnType<typeof vi.fn> } }).terminal;
    firstTerminal.listBlocks.mockResolvedValue({
      ok: true,
      integrated: true,
      blocks: [{ id: 1, command: "cd app", cwd: "/work/repo/app", exitCode: 0, startedAt: 1, endedAt: 2, status: "done", source: "osc133", outputChars: 0, truncated: false }],
    });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(first.container)).toHaveLength(1));
    const mainTerminal = shownSurfaces(first.container)[0]!.tabId!;
    await waitFor(() => expect(first.container.querySelector('[data-testid="pane-header-meta"]')?.textContent).toBe("app"));
    const tiles = await splitIntoTwoTiles(first.container);
    const sideTerminal = await openSideTerminalIn(tiles[1]!.element);

    const saved = await waitFor(() => {
      const calls = vi.mocked(first.api.updateSettings).mock.calls
        .map(([patch]) => (patch as { system?: { mainLayout?: Record<string, unknown> } }).system?.mainLayout)
        .filter((each) => each !== undefined);
      const last = calls.at(-1) as { surfaces: Record<string, { tabId: string; cwd: string | null }>; sideTabs: Record<string, Array<{ tabId: string }>> } | undefined;
      expect(Object.values(last?.surfaces ?? {}).map((each) => each.tabId)).toEqual([mainTerminal]);
      expect(Object.values(last?.sideTabs ?? {}).flat().map((each) => each.tabId)).toEqual([sideTerminal]);
      return last!;
    }, { timeout: MAIN_LAYOUT_SAVE_DELAY_MS * 10 });
    expect(Object.values(saved.surfaces)[0]!.cwd).toBe("/work/repo/app");
    const persisted = await first.api.getSettings();
    first.unmount();
    resetMainLayoutRestoreForTest();
    xtermWrites.length = 0;

    const second = await renderApp({ hasApiKey: true, terminal: true, settings: persisted });
    const secondTerminal = (second.api as unknown as { terminal: { spawn: ReturnType<typeof vi.fn> } }).terminal;
    await waitFor(() => expect(shownSurfaces(second.container).map((each) => each.tabId)).toEqual([mainTerminal]));
    expect(second.container.querySelectorAll('[data-testid^="pane-cell:"]:not([data-hidden="true"])')).toHaveLength(2);
    await waitFor(() => expect(document.querySelector(`[data-testid="chat-side-panel-tab-strip"] [data-tab-id="${sideTerminal}"]`)).not.toBeNull());
    // A new shell, in the saved directory, saying it is one.
    await waitFor(() => expect(secondTerminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: mainTerminal, cwd: "/work/repo/app" })));
    expect(xtermWrites.join("")).toContain("[restored: new shell in /work/repo/app]");
    // A terminal opened after the restore does not take a restored id.
    await clickSidebarNavRow("features", "sidebar-terminal");
    const ids = new Set([mainTerminal, sideTerminal]);
    await waitFor(() => expect(secondTerminal.spawn.mock.calls.some(([payload]) => !ids.has((payload as { tabId: string }).tabId))).toBe(true));
  });

  it("leaves the saved layout to the primary window: a second window neither restores it nor saves over it", async () => {
    const saved = {
      version: 1,
      tree: { kind: "leaf", chatGroupId: "main" },
      focusedId: "main",
      surfaces: { main: { kind: "terminal", tabId: "terminal:0000000a-4", ordinal: 1, cwd: "/work/repo", url: null } },
      panelOpenIds: [],
      sideTabs: {},
    };
    // Main loads a secondary window with the role query (`shared/main-window-role.ts`).
    const before = window.location.href;
    window.history.replaceState(null, "", "?aveWindow=secondary");
    try {
      const { container, api } = await renderApp({
        hasApiKey: true,
        terminal: true,
        settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", mainLayout: saved } },
      });
      const terminal = (api as unknown as { terminal: { spawn: ReturnType<typeof vi.fn> } }).terminal;
      await clickSidebarNavRow("features", "sidebar-terminal");
      await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
      // Its own new terminal, not the primary window's saved one.
      expect(shownSurfaces(container)[0]!.tabId).not.toBe("terminal:0000000a-4");
      expect(terminal.spawn.mock.calls.some(([payload]) => (payload as { tabId: string }).tabId === "terminal:0000000a-4")).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, MAIN_LAYOUT_SAVE_DELAY_MS * 3));
      const layoutWrites = vi.mocked(api.updateSettings).mock.calls
        .filter(([patch]) => (patch as { system?: { mainLayout?: unknown } }).system?.mainLayout !== undefined);
      expect(layoutWrites).toEqual([]);
    } finally {
      window.history.replaceState(null, "", before);
    }
  });

  it("starts in the default layout, saying why, when the saved one breaks a rule", async () => {
    const warn = vi.spyOn(console, "warn");
    const broken = {
      version: 1,
      tree: { kind: "leaf", chatGroupId: "main" },
      focusedId: "group-5",
      surfaces: {},
      panelOpenIds: [],
      sideTabs: {},
    };
    const { container } = await renderApp({
      hasApiKey: true,
      terminal: true,
      settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", mainLayout: broken } },
    });
    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[main-layout] saved layout refused: focusedId names pane "group-5", which is not in the tree; starting in the default layout',
    ));
    expect(container.querySelectorAll('[data-testid^="pane-cell:"]:not([data-hidden="true"])')).toHaveLength(1);
    expect(shownSurfaces(container)).toHaveLength(0);
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
