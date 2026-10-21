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
import { clearActiveSurface } from "../../src/ui/renderer/preview/active-surface.js";
import { terminalSessionFixture } from "../../src/__tests__/support/terminal-session-fixtures.js";
import type { TerminalSessionRef } from "../../src/shared/terminal-session.js";
import { t } from "../../src/i18n/index.js";

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
  clearActiveSurface();
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
  it("re-reports an already focused main page after a hidden side page becomes the target", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, browserTabs: true });
    const browser = api as unknown as {
      browserTabs: { emitBrowserTabOp: (request: unknown) => void };
      setActiveSurface: ReturnType<typeof vi.fn>;
    };
    await clickSidebarNavRow("features", "sidebar-web");
    const page = shownSurfaces(container)[0]!.tabId!;
    const address = container.querySelector('[data-testid="web-panel-address"]')!;
    await act(async () => {
      fireEvent.change(address, { target: { value: "https://a.example/" } });
      fireEvent.submit(address.closest("form")!);
    });
    await act(async () => browser.browserTabs.emitBrowserTabOp({ requestId: "new-side-page", op: "new", url: "about:blank" }));
    const other = document.querySelector('[data-testid="chat-side-panel-browser-tab-host"]')!.getAttribute("data-tab-id");
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId: other }));
    await act(async () => browser.browserTabs.emitBrowserTabOp({ requestId: "select-main-page", op: "select", tabId: page }));
    expect(shownSurfaces(container)[0]!.tabId).toBe(page);
    expect(browser.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId: page });
  });

  it("clears the active report when the agent closes the last side page", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, browserTabs: true });
    const browser = api as unknown as {
      browserTabs: { emitBrowserTabOp: (request: unknown) => void };
      setActiveSurface: ReturnType<typeof vi.fn>;
    };
    await act(async () => fireEvent.click(container.querySelector('[data-testid="pane-panel-toggle"]')!));
    await act(async () => browser.browserTabs.emitBrowserTabOp({ requestId: "new-side-page", op: "new", url: "about:blank" }));
    const page = document.querySelector('[data-testid="chat-side-panel-browser-tab-host"]')!.getAttribute("data-tab-id");
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId: page }));
    await act(async () => browser.browserTabs.emitBrowserTabOp({ requestId: "close-side-page", op: "close", tabId: page }));
    expect(document.querySelector('[data-testid="chat-side-panel-browser-tab-host"]')).toBeNull();
    expect(browser.setActiveSurface).toHaveBeenLastCalledWith(null);
  });

  it("clears the window's active report when App unmounts", async () => {
    const { container, api, unmount } = await renderApp({ hasApiKey: true, browserTabs: true });
    const browser = api as unknown as {
      browserTabs: { emitBrowserTabOp: (request: unknown) => void };
      setActiveSurface: ReturnType<typeof vi.fn>;
    };
    await act(async () => fireEvent.click(container.querySelector('[data-testid="pane-panel-toggle"]')!));
    await act(async () => browser.browserTabs.emitBrowserTabOp({ requestId: "new-window-page", op: "new", url: "about:blank" }));
    const page = document.querySelector('[data-testid="chat-side-panel-browser-tab-host"]')!.getAttribute("data-tab-id");
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId: page }));
    unmount();
    expect(browser.setActiveSurface).toHaveBeenLastCalledWith(null);
  });

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

  it("lets the agent browser tools reach a main web panel: reported as the active surface, shown, badged and closed there", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, browserTabs: true });
    const browser = (api as unknown as {
      browserTabs: { emitBrowserTabOp: (request: unknown) => void; emitBrowserControl: (ids: string[]) => void };
      setActiveSurface: ReturnType<typeof vi.fn>;
    });
    await clickSidebarNavRow("features", "sidebar-web");
    await waitFor(() => expect(shownSurfaces(container)[0]?.kind).toBe("browser"));
    const page = shownSurfaces(container)[0]!.tabId!;
    // The focused pane's page is the tab the tools default to.
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId: page }));

    // The pane moves on to a terminal; the page keeps running unshown.
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)[0]?.kind).toBe("terminal"));
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "terminal" })));

    // Main asks to show the page: it comes back in the focused pane.
    act(() => browser.browserTabs.emitBrowserTabOp({ requestId: "r1", op: "select", tabId: page }));
    await waitFor(() => expect(shownSurfaces(container)[0]?.tabId).toBe(page));
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith({ kind: "browser", tabId: page }));

    // The agent controls it: the pane says so.
    act(() => browser.browserTabs.emitBrowserControl([page]));
    await waitFor(() => expect(container.querySelector('[data-testid="web-panel"] [data-testid="agent-browser-control-badge"]')).not.toBeNull());

    // Main closes it: the pane gives it up and nothing is the active surface.
    act(() => browser.browserTabs.emitBrowserTabOp({ requestId: "r2", op: "close", tabId: page }));
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));
    await waitFor(() => expect(browser.setActiveSurface).toHaveBeenLastCalledWith(null));
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
    const { container, api } = await renderApp({ hasApiKey: true, browserTabs: true });
    const report = (api as unknown as { setActiveSurface: ReturnType<typeof vi.fn> }).setActiveSurface;
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    expect(report).toHaveBeenLastCalledWith({ kind: "terminal", tabId: shownSurfaces(container)[0]!.tabId });
    const close = container.querySelector<HTMLButtonElement>('[data-testid="surface-pane"]')!
      .closest('[data-testid="pane"]')!
      .querySelector<HTMLButtonElement>('[data-testid="pane-close"]')!;
    await act(async () => { fireEvent.click(close); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));
    expect(report).toHaveBeenLastCalledWith(null);
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

  it("moves a side-panel terminal to the main area under the same id", async () => {
    const { container } = await renderApp({ hasApiKey: true });
    const tabId = await openSideTerminal(container);

    const move = document.querySelector<HTMLButtonElement>(`[data-tab-id="${tabId}"] [data-testid="chat-side-panel-move-to-main"]`)!;
    await act(async () => { fireEvent.click(move); });
    await waitFor(() => expect(shownSurfaces(container)).toEqual([{ kind: "terminal", tabId }]));
    expect(sideTabIds()).not.toContain(tabId);
    // Back to a side panel is a drag of the pane's header (below); the header's
    // panel toggle opens the pane's own chat instead.
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

  it("keeps Manual's current directory unknown and does not reuse a heuristic command as a reopen directory", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true });
    const terminalApi = (api as unknown as { terminal: { listBlocks: ReturnType<typeof vi.fn>; spawn: ReturnType<typeof vi.fn> } }).terminal;
    terminalApi.listBlocks.mockImplementation(async (ref: TerminalSessionRef) => ({
      ok: true,
      session: terminalSessionFixture(ref.tabId, ref.lane, ref.terminalSessionId),
      integrated: false,
      blocks: [{ id: 1, command: "cd /work/repo/app", cwd: null, exitCode: null, startedAt: 1, endedAt: 2, status: "done", source: "heuristic", outputChars: 0, truncated: false }],
    }));
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const manual = terminalSessionFixture(shownSurfaces(container)[0]!.tabId!, "manual");
    await waitFor(() => expect(terminalApi.listBlocks).toHaveBeenCalledWith(expect.objectContaining({ lane: "manual", terminalSessionId: manual.terminalSessionId })));
    expect(container.querySelector('[data-testid="pane-header-meta"]')).toBeNull();
    expect(container.textContent).toContain(t("ptyTerminal.manualEnvironment"));
    expect(container.textContent).toContain(t("ptyTerminal.initialCwd", { cwd: manual.initialCwd }));
    // The launch directory is not evidence of a current directory to save.
    expect(terminalApi.spawn.mock.calls[0]![0]).toMatchObject({ lane: "manual" });
    expect(terminalApi.spawn.mock.calls[0]![0]).not.toHaveProperty("cwd");
    const spawnsBeforeClose = terminalApi.spawn.mock.calls.length;

    const close = container.querySelector('[data-testid="surface-pane"]')!
      .closest('[data-testid="pane"]')!
      .querySelector<HTMLButtonElement>('[data-testid="pane-close"]')!;
    await act(async () => { fireEvent.click(close); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));

    await act(async () => {
      fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    await waitFor(() => expect(terminalApi.spawn.mock.calls.length).toBeGreaterThan(spawnsBeforeClose));
    expect(terminalApi.spawn.mock.calls.at(-1)![0]).toMatchObject({ lane: "manual" });
    expect(terminalApi.spawn.mock.calls.at(-1)![0]).not.toHaveProperty("cwd");
    expect(container.querySelector('[data-testid="pane-header-meta"]')).toBeNull();
  });

  it("opens a terminal or web pane's own chat beside it, bound to that pane's tab", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true, sideChat: true, browserTabs: true });
    const sideChat = (api as unknown as { sideChat: { send: ReturnType<typeof vi.fn> } }).sideChat;
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const terminal = shownSurfaces(container)[0]!.tabId!;
    const pane = () => container.querySelector(`[data-testid="surface-pane"][data-tab-id="${terminal}"]`)!.closest('[data-testid="pane"]')!;
    const toggle = () => pane().querySelector<HTMLButtonElement>('[data-testid="pane-action-surface.chat"]')!;
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(pane().querySelector('[data-testid="pane-chat"]')).toBeNull();

    await act(async () => { fireEvent.click(toggle()); });
    // The chat docks inside the pane's own tile, beside the terminal.
    const chat = await waitFor(() => {
      const el = pane().querySelector<HTMLElement>('[data-testid="pane-chat"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(chat.getAttribute("data-tab-id")).toBe(terminal);
    const chip = chat.querySelector<HTMLElement>('[data-testid="side-chat-target"] [data-tab-id]')!;
    expect(chip.getAttribute("data-tab-id")).toBe(terminal);
    expect(chip.getAttribute("data-surface-kind")).toBe("terminal");
    // The binding is the pane's: the chip offers nothing to change it.
    expect(chat.querySelector('[data-testid="side-chat-target"] button')).toBeNull();

    // Every turn names the pane's tab.
    const input = chat.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      fireEvent.change(input, { target: { value: "what failed?" } });
    });
    await act(async () => {
      fireEvent.click(chat.querySelector<HTMLButtonElement>('[data-testid="side-chat-action-row"] button:last-child')!);
    });
    await waitFor(() => expect(sideChat.send).toHaveBeenCalled());
    expect(sideChat.send.mock.calls.at(-1)![4]).toEqual({ kind: "terminal", tabId: terminal });

    await act(async () => { fireEvent.click(toggle()); });
    expect(pane().querySelector('[data-testid="pane-chat"]')).toBeNull();
  });

  it("keeps each pane's chat its own conversation: apart from the other pane's, back when reopened, ended with its pane", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true, sideChat: true, browserTabs: true });
    const sideChat = (api as unknown as { sideChat: Record<"send" | "new" | "paneHistory" | "endPaneChat", ReturnType<typeof vi.fn>> }).sideChat;
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    await splitIntoTwoTiles(container);
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(2));
    const [first, second] = shownSurfaces(container).map((each) => each.tabId!);
    const pane = (tabId: string) => container.querySelector(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`)!.closest('[data-testid="pane"]')!;
    const toggle = async (tabId: string) => {
      await act(async () => { fireEvent.click(pane(tabId).querySelector('[data-testid="pane-action-surface.chat"]')!); });
    };
    const chat = (tabId: string) => pane(tabId).querySelector<HTMLElement>('[data-testid="pane-chat"]');
    const transcript = (tabId: string) => chat(tabId)!.querySelector('[data-testid="side-chat-transcript"]')!.textContent ?? "";
    const say = async (tabId: string, text: string) => {
      const input = chat(tabId)!.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => { fireEvent.change(input, { target: { value: text } }); });
      await act(async () => {
        fireEvent.click(chat(tabId)!.querySelector<HTMLButtonElement>('[data-testid="side-chat-action-row"] button:last-child')!);
      });
      await waitFor(() => expect(transcript(tabId)).toContain(text));
    };

    await toggle(first!);
    await waitFor(() => expect(chat(first!)).not.toBeNull());
    await say(first!, "first pane question");
    await toggle(second!);
    await waitFor(() => expect(chat(second!)).not.toBeNull());
    await waitFor(() => expect(sideChat.paneHistory).toHaveBeenCalledWith(second));
    expect(transcript(second!)).not.toContain("first pane question");
    await say(second!, "second pane question");
    expect(transcript(first!)).not.toContain("second pane question");
    expect(sideChat.send.mock.calls.map((call) => (call[4] as { tabId: string }).tabId)).toEqual([first, second]);

    // Closed and opened again, a pane's chat is back on its own conversation.
    await toggle(first!);
    expect(chat(first!)).toBeNull();
    await toggle(first!);
    await waitFor(() => expect(transcript(first!)).toContain("first pane question"));
    expect(transcript(first!)).not.toContain("second pane question");

    // "New" in a pane chat starts that pane's chat afresh, not the window-wide one.
    await act(async () => { fireEvent.click(chat(second!)!.querySelector('[data-testid="side-chat-new"]')!); });
    await waitFor(() => expect(sideChat.endPaneChat).toHaveBeenCalledWith(second, "new"));
    expect(sideChat.new).not.toHaveBeenCalled();
    await waitFor(() => expect(transcript(second!)).not.toContain("second pane question"));

    // Closing the pane ends its chat.
    await act(async () => { fireEvent.click(pane(first!).querySelector('[data-testid="pane-close"]')!); });
    await waitFor(() => expect(sideChat.endPaneChat).toHaveBeenCalledWith(first, "closed"));
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

  it("shows a pane's chat for the surface it holds now: a page put in a terminal's pane gets its own conversation", async () => {
    const { container } = await renderApp({ hasApiKey: true, terminal: true, sideChat: true, browserTabs: true });
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const terminal = shownSurfaces(container)[0]!.tabId!;
    const pane = () => container.querySelector('[data-testid="surface-pane"]')!.closest('[data-testid="pane"]')!;
    await act(async () => { fireEvent.click(pane().querySelector('[data-testid="pane-action-surface.chat"]')!); });
    const chat = () => pane().querySelector<HTMLElement>('[data-testid="pane-chat"]');
    await waitFor(() => expect(chat()).not.toBeNull());
    const input = chat()!.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => { fireEvent.change(input, { target: { value: "what did the build print?" } }); });
    await act(async () => {
      fireEvent.click(chat()!.querySelector<HTMLButtonElement>('[data-testid="side-chat-action-row"] button:last-child')!);
    });
    await waitFor(() => expect(chat()!.textContent).toContain("what did the build print?"));

    // The same pane now shows a page: its chat is the page's, not the terminal's.
    await clickSidebarNavRow("features", "sidebar-web");
    const page = await waitFor(() => {
      const tab = shownSurfaces(container)[0]!.tabId!;
      expect(tab).not.toBe(terminal);
      return tab;
    });
    const pageChat = await waitFor(() => {
      const el = pane().querySelector<HTMLElement>(`[data-testid="pane-chat"][data-tab-id="${page}"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    expect(pageChat.textContent).not.toContain("what did the build print?");
  });

  it("gives a web pane's chat the page's tab and names it by the page", async () => {
    const { container } = await renderApp({ hasApiKey: true, sideChat: true, browserTabs: true });
    await clickSidebarNavRow("features", "sidebar-web");
    const page = shownSurfaces(container)[0]!.tabId!;
    const address = container.querySelector('[data-testid="web-panel-address"]')!;
    await act(async () => {
      fireEvent.change(address, { target: { value: "https://a.example/" } });
      fireEvent.submit(address.closest("form")!);
    });
    const pane = container.querySelector(`[data-testid="surface-pane"][data-tab-id="${page}"]`)!.closest('[data-testid="pane"]')!;
    await act(async () => { fireEvent.click(pane.querySelector('[data-testid="pane-action-surface.chat"]')!); });
    const chip = await waitFor(() => {
      const el = pane.querySelector<HTMLElement>('[data-testid="pane-chat"] [data-testid="side-chat-target"] [data-tab-id]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(chip.getAttribute("data-tab-id")).toBe(page);
    expect(chip.getAttribute("data-surface-kind")).toBe("browser");
    expect(chip.textContent).toContain("a.example");
  });

  it("attaches a main terminal's block to the composer last typed in — the side chat, here", async () => {
    const { container, api } = await renderApp({ hasApiKey: true, terminal: true, sideChat: true });
    const terminalApi = (api as unknown as { terminal: { listBlocks: ReturnType<typeof vi.fn>; getBlock: ReturnType<typeof vi.fn> } }).terminal;
    const block = { id: 1, command: "npm test", cwd: null, exitCode: null, startedAt: 1, endedAt: 2, status: "done", source: "heuristic", outputChars: 3, truncated: false };
    terminalApi.listBlocks.mockImplementation(async (ref: TerminalSessionRef) => ({
      ok: true, session: terminalSessionFixture(ref.tabId, ref.lane, ref.terminalSessionId), integrated: false, blocks: [block],
    }));
    terminalApi.getBlock.mockImplementation(async (ref: TerminalSessionRef) => ({
      ok: true, session: terminalSessionFixture(ref.tabId, ref.lane, ref.terminalSessionId), block: { ...block, output: "ok\n" },
    }));
    await clickSidebarNavRow("features", "sidebar-terminal");
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const terminalTabId = shownSurfaces(container)[0]!.tabId!;
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
    expect(terminalApi.getBlock).toHaveBeenCalledWith(expect.objectContaining({ tabId: terminalTabId, lane: "manual", terminalSessionId: `${terminalTabId}/manual` }), 1);
    const chip = await waitFor(() => {
      const el = sideDock.querySelector<HTMLButtonElement>('[data-testid="attachment-chip"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await act(async () => { fireEvent.click(chip); });
    await waitFor(() => expect(document.querySelector('[data-testid="overlay-paste-text"]')?.textContent).toContain("$ npm test\nok\n"));
  });

  it("saves the layout as it changes and puts it back at the next launch, with new shells in the saved directories", async () => {
    const startingDirectory = "/work/repo/app";
    const initialLayout = {
      version: 1,
      tree: { kind: "leaf", chatGroupId: "main" },
      focusedId: "main",
      surfaces: { main: { kind: "terminal", tabId: "terminal:abcd1234-1", ordinal: 1, cwd: startingDirectory, url: null } },
      panelOpenIds: [],
      sideTabs: {},
    };
    // A saved starting directory is known input; Manual output supplies no observed cwd.
    const first = await renderApp({
      hasApiKey: true,
      terminal: true,
      settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", mainLayout: initialLayout } },
    });
    const firstTerminal = (first.api as unknown as { terminal: { spawn: ReturnType<typeof vi.fn> } }).terminal;
    await waitFor(() => expect(shownSurfaces(first.container)).toHaveLength(1));
    const mainTerminal = shownSurfaces(first.container)[0]!.tabId!;
    expect(mainTerminal).toBe(initialLayout.surfaces.main.tabId);
    await waitFor(() => expect(firstTerminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: mainTerminal, lane: "manual", cwd: startingDirectory })));
    await waitFor(() => expect(first.container.querySelector('[data-testid="pane-header-meta"]')?.textContent).toBe("app"));
    const tiles = await splitIntoTwoTiles(first.container);
    const sideTerminal = await openSideTerminalIn(tiles[1]!.element);

    const saved = await waitFor(() => {
      const calls = vi.mocked(first.api.updateSettings).mock.calls
        .map(([patch]) => (patch as { system?: { mainLayout?: Record<string, unknown> } }).system?.mainLayout)
        .filter((each) => each !== undefined);
      const last = calls.at(-1) as { surfaces: Record<string, { tabId: string; cwd: string | null }>; sideTabs: Record<string, Array<{ tabId: string; cwd: string | null }>> } | undefined;
      expect(Object.values(last?.surfaces ?? {}).map((each) => each.tabId)).toEqual([mainTerminal]);
      expect(Object.values(last?.sideTabs ?? {}).flat().map((each) => each.tabId)).toEqual([sideTerminal]);
      return last!;
    }, { timeout: MAIN_LAYOUT_SAVE_DELAY_MS * 10 });
    expect(Object.values(saved.surfaces)[0]!.cwd).toBe(startingDirectory);
    expect(Object.values(saved.sideTabs).flat()[0]!.cwd).toBeNull();
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
    await waitFor(() => expect(secondTerminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: mainTerminal, lane: "manual", cwd: startingDirectory })));
    expect(xtermWrites.join("")).toContain(t("ptyTerminal.restored"));
    await waitFor(() => expect(secondTerminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: sideTerminal, lane: "manual" })));
    const sideSpawn = secondTerminal.spawn.mock.calls.find(([payload]) => (payload as { tabId: string }).tabId === sideTerminal)![0];
    expect(sideSpawn).not.toHaveProperty("cwd");
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
