// @vitest-environment jsdom
/** Retint the existing terminal from root theme values; recreating it would discard screen and scrollback. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render as renderUnwrapped, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import { TERMINAL_INPUT_MAX_BYTES, type TerminalControlAction, type TerminalControlEvent, type TerminalControlResult, type TerminalSessionInfo, type TerminalSessionRef, type TerminalSpawnRequest, type TerminalDataEvent, type TerminalExitEvent } from "../../../../shared/terminal-session.js";
import { PtyTerminalView } from "../PtyTerminalView.js";
import { SidePanelTerminal } from "../SidePanelTerminal.js";
import { forgetTerminalFileReview, requestTerminalFileReview } from "../../preview/terminal-file-review.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import { useState, type ReactElement } from "react";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import { t } from "../../../../i18n/index.js";
import { terminalCwd } from "../../preview/main-layout-restore.js";
import { surfaceMountLocation } from "../../preview/surface-mounts.js";
import { disposeLiveTerminal, requestTerminalFocus } from "../../preview/live-terminal-registry.js";
import { useMainSurfaces } from "../../preview/main-surfaces.js";
import { terminalClipboardAction } from "../terminal-keys.js";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider.js";
import { DEFAULT_APPEARANCE } from "../../../../shared/appearance-settings.js";
import { requireScheme } from "../../theme/schemes/index.js";

/** The app renders every terminal under its root TooltipProvider; the terminal's header chip needs one. */
const render = (ui: ReactElement) => renderUnwrapped(ui, { wrapper: ({ children }) => <ThemeProvider initialAppearance={DEFAULT_APPEARANCE}><TooltipProvider>{children}</TooltipProvider></ThemeProvider> });

interface FakeMarker { line: number; isDisposed: boolean; onDispose: () => { dispose(): void }; dispose(): void }
interface FakeTerminal {
  options: { theme?: unknown; linkHandler?: { activate: LinkCallback; hover: LinkCallback; leave: LinkCallback; allowNonHttpProtocols?: boolean } };
  commandRow: string;
  oscHandlers: Map<number, (data: string) => boolean>;
  dataHandler: ((data: string) => void) | null;
  userInputListener: (() => void) | null;
  written: string[];
  cursorLine: number;
  focusCount: number;
  markers: { offset: number; marker: FakeMarker }[];
  decorations: { options: { marker: FakeMarker; x?: number; width?: number; height?: number }; element: HTMLElement }[];
  element: HTMLElement | null;
  disposed: boolean;
  keyHandler: ((event: KeyboardEvent) => boolean) | null;
  selection: string;
  pasted: string[];
  selectedAll: number;
  clears: number;
  unicode: { activeVersion: string; providers: Map<string, { version: string; wcwidth(codepoint: number): number }> };
}
const { terminals } = vi.hoisted(() => ({ terminals: [] as FakeTerminal[] }));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: { theme?: unknown };
    cols = 80;
    rows = 24;
    oscHandlers = new Map<number, (data: string) => boolean>();
    dataHandler: ((data: string) => void) | null = null;
    parser = {
      registerOscHandler: (ident: number, handler: (data: string) => boolean) => {
        this.oscHandlers.set(ident, handler);
        return { dispose: () => this.oscHandlers.delete(ident) };
      },
    };
    constructor(options: { theme?: unknown }) {
      this.options = { ...options };
      terminals.push(this);
    }
    cursorLine = 4;
    focusCount = 0;
    focus() { this.focusCount++; }
    host: HTMLElement | null = null;
    markers: { offset: number; marker: FakeMarker }[] = [];
    decorations: { options: { marker: FakeMarker; x?: number; width?: number; height?: number }; element: HTMLElement }[] = [];
    /** The text on the command row, as the shell echoed it. */
    commandRow = "~/demo ❯ make build";
    viewportY = 0;
    selectedAll = 0;
    clears = 0;
    selectAll() { this.selectedAll++; this.selection = "everything"; }
    clear() { this.clears++; }
    buffer = { active: { viewportY: 0, getLine: (_line: number) => {
      const text = this.commandRow;
      return { length: this.cols, translateToString: () => text,
        getCell: (x: number) => ({ getChars: () => text[x] ?? "", getWidth: () => 1 }) };
    } } };
    registerMarker(offset = 0): FakeMarker {
      const marker = { line: this.cursorLine + offset, isDisposed: false, onDispose: () => ({ dispose() {} }), dispose() {} };
      this.markers.push({ offset, marker });
      return marker;
    }
    registerDecoration(options: { marker: FakeMarker; x?: number; width?: number; height?: number }) {
      // xterm draws decorations in its own layer inside the screen, never as rows of the buffer.
      const element = document.createElement("div");
      element.className = "xterm-decoration";
      this.host?.appendChild(element);
      this.decorations.push({ options, element });
      return { element, marker: options.marker, onRender: (listener: (element: HTMLElement) => void) => { listener(element); return { dispose() {} }; },
        onDispose: () => ({ dispose() {} }), dispose: () => element.remove() };
    }
    /** Width providers by version, as xterm's unicode service keeps them; the real Unicode 11 addon registers into it. */
    unicode = {
      activeVersion: "6",
      providers: new Map<string, { version: string; wcwidth(codepoint: number): number }>(),
      register(provider: { version: string; wcwidth(codepoint: number): number }) { this.providers.set(provider.version, provider); },
    };
    loadAddon(addon: { activate?: (terminal: unknown) => void }) { addon.activate?.(this); }
    element: HTMLElement | null = null;
    open(host: HTMLElement) {
      this.host = host;
      this.element = document.createElement("div");
      this.element.className = "xterm";
      // The cell grid: 24 rows of 10px, as xterm's screen element measures.
      const grid = document.createElement("div");
      grid.className = "xterm-screen";
      grid.getBoundingClientRect = () => ({ top: 100, bottom: 340, left: 0, right: 800, width: 800, height: 240, x: 0, y: 100, toJSON() {} });
      this.element.appendChild(grid);
      host.appendChild(this.element);
    }
    /** As the terminal's core announces user input, just before its data event. */
    userInputListener: (() => void) | null = null;
    _core = { coreService: { onUserInput: (listener: () => void) => { this.userInputListener = listener; return { dispose: () => { this.userInputListener = null; } }; } } };
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: () => { this.dataHandler = null; } };
    }
    written: string[] = [];
    write(text: string) {
      this.written.push(text);
    }
    disposed = false;
    dispose() { this.disposed = true; }
    keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) { this.keyHandler = handler; }
    selection = "";
    hasSelection() { return this.selection.length > 0; }
    getSelection() { return this.selection; }
    clearSelection() { this.selection = ""; }
    pasted: string[] = [];
    paste(text: string) { this.pasted.push(text); }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
interface FakeSearch {
  calls: Array<{ direction: "next" | "previous"; query: string; options: { caseSensitive?: boolean; incremental?: boolean; decorations?: Record<string, string> } }>;
  found: boolean;
  cleared: number;
  emit(resultIndex: number, resultCount: number): void;
}
const { searches } = vi.hoisted(() => ({ searches: [] as FakeSearch[] }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {
  calls: FakeSearch["calls"] = [];
  found = true;
  cleared = 0;
  listeners = new Set<(event: { resultIndex: number; resultCount: number }) => void>();
  constructor() { searches.push(this); }
  findNext(query: string, options: FakeSearch["calls"][number]["options"]) { this.calls.push({ direction: "next", query, options }); return this.found; }
  findPrevious(query: string, options: FakeSearch["calls"][number]["options"]) { this.calls.push({ direction: "previous", query, options }); return this.found; }
  clearDecorations() { this.cleared++; }
  onDidChangeResults(listener: (event: { resultIndex: number; resultCount: number }) => void) { this.listeners.add(listener); return { dispose: () => { this.listeners.delete(listener); } }; }
  emit(resultIndex: number, resultCount: number) { for (const listener of this.listeners) listener({ resultIndex, resultCount }); }
} }));
type LinkCallback = (event: MouseEvent, target: string) => void;
const { webLinks } = vi.hoisted(() => ({ webLinks: [] as Array<{ activate: LinkCallback; hover: LinkCallback; leave: LinkCallback }> }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {
  constructor(activate: LinkCallback, options: { hover: LinkCallback; leave: LinkCallback }) { webLinks.push({ activate, hover: options.hover, leave: options.leave }); }
} }));

/** The fake xterm of the n-th terminal this test created. */
function fakeTerm(index = 0): FakeTerminal {
  const found = terminals[index];
  if (!found) throw new Error(`the test created no terminal ${index}`);
  return found;
}
/** Deliver an OSC 133 marker as xterm's parser would. */
function osc133(xterm: FakeTerminal, data: string): boolean {
  const handler = xterm.oscHandlers.get(133);
  if (!handler) throw new Error("the terminal registered no OSC 133 handler");
  return handler(data);
}
/** Type into the terminal as the keyboard does. */
function typeInto(xterm: FakeTerminal, data: string): void {
  if (!xterm.dataHandler || !xterm.userInputListener) throw new Error("the terminal takes no input");
  xterm.userInputListener();
  xterm.dataHandler(data);
}
/** Offer a key event to the terminal's custom key handler; false means the terminal kept the key from xterm. */
function offerKey(xterm: FakeTerminal, event: KeyboardEvent): boolean {
  if (!xterm.keyHandler) throw new Error("the terminal registered no key handler");
  return xterm.keyHandler(event);
}

afterEach(() => {
  terminals.length = 0;
  webLinks.length = 0;
});

function terminalApi() {
  return {
    spawn: vi.fn(async (payload: TerminalSpawnRequest) => ({ ok: true as const, tabId: payload.tabId, replayed: false, session: { ...terminalSessionFixture(payload.tabId, payload.lane), initialCwd: payload.cwd ?? "/workspace" }, blockMarkerToken: "view-token" })),
    input: vi.fn(async () => ({ ok: true as const })),
    resize: vi.fn(async () => ({ ok: true as const })),
    kill: vi.fn(async () => ({ ok: true as const })),
    onData: vi.fn((_handler: (event: TerminalDataEvent) => void) => () => {}),
    onExit: vi.fn((_handler: (event: TerminalExitEvent) => void) => () => {}),
    onControl: vi.fn((_handler: (event: TerminalControlEvent) => void) => () => {}),
    control: vi.fn(async (_ref: TerminalSessionRef, _action: TerminalControlAction): Promise<TerminalControlResult> => ({ ok: true, control: { mode: "available", generation: 0, agentInput: "supported" } })),
    listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot: { cwd: "/", latestBlockId: null, files: [], warnings: [] } })),
    listBlocks: vi.fn(async (session: TerminalSessionInfo) => ({ ok: true as const, session, integrated: session.shellIntegration, blocks: [] as unknown[] })),
    getBlock: vi.fn(async (_session: TerminalSessionInfo, _id: number) => ({ ok: false as const, error: "block-not-found" })),
  };
}

describe("PtyTerminalView theme", () => {
  it("requires an applied theme provider", () => {
    const { api } = makeMockAveApi();
    expect(() => renderUnwrapped(<PtyTerminalView api={api as never} location="side-panel" tabId="missing-provider" tabLabel="Terminal" />)).toThrow("useTheme() must be used inside <ThemeProvider>");
  });
  it("updates the full palette and font without restarting the terminal", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE, mode: "light" } } });
    const ave = { ...api, terminal: terminalApi() };
    let switchMode: (() => void) | null = null;
    function Picker() { const theme = useTheme(); switchMode = () => theme.setMode("dark"); return null; }
    render(<ThemeProvider api={api as never} initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light" }}><Picker /><PtyTerminalView api={ave as never} location="side-panel" tabId="tab-1" tabLabel="Terminal 1" /></ThemeProvider>);
    await waitFor(() => expect(terminals).toHaveLength(1));
    expect(fakeTerm().options.theme).toEqual(requireScheme("github-light").terminal);
    await act(async () => { switchMode!(); });
    expect(fakeTerm().options.theme).toEqual(requireScheme("github-dark").terminal);
    await act(async () => { await api.updateSettings({ appearance: { terminalFont: { family: "Example Mono", size: 16, lineHeight: 1.5 } } }); });
    expect(fakeTerm().options).toEqual(expect.objectContaining({ fontFamily: "Example Mono", fontSize: 16, lineHeight: 1.5 }));
    expect(terminals).toHaveLength(1);
    expect(ave.terminal.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("PtyTerminalView command blocks", () => {
  const summary = (id: number, command: string, exitCode: number | null, status: "done" | "running" = "done") => ({
    id, command, cwd: "/repo", exitCode, startedAt: 1_000, endedAt: status === "done" ? 2_000 : null,
    status, source: "osc133", outputChars: 4, truncated: false,
  });

  function renderView(onAttachText?: (text: string) => boolean) {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.listBlocks.mockResolvedValue({
      ok: true,
      session: terminalSessionFixture("terminal:1", "manual"),
      integrated: true,
      blocks: [summary(2, "npm test", 1), summary(1, "git status", 0)],
    });
    terminal.getBlock.mockImplementation((async (_tabId: string, blockId: number) => ({
      ok: true,
      block: { ...summary(blockId, blockId === 2 ? "npm test" : "git status", blockId === 2 ? 1 : 0), output: "out\n" },
    })) as never);
    const ave = { ...api, terminal };
    render(
      <PtyTerminalView
        api={ave as never}
        location="side-panel"
        tabId="terminal:1"
        tabLabel="Terminal 1"
        {...(onAttachText ? { onAttachText } : {})}
      />,
    );
    return terminal;
  }

  it("re-lists blocks when the shell reports a command boundary", async () => {
    const terminal = renderView();
    await waitFor(() => expect(terminal.listBlocks).toHaveBeenCalledTimes(1));
    const handler = fakeTerm().oscHandlers.get(133)!;
    // Prompt-end markers do not end a block; the finish marker does.
    let handled = true;
    act(() => { handled = handler("B"); });
    expect(handled).toBe(false);
    expect(terminal.listBlocks).toHaveBeenCalledTimes(1);
    act(() => { handler("D;0"); });
    await waitFor(() => expect(terminal.listBlocks).toHaveBeenCalledTimes(2));
    expect(terminal.listBlocks).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "terminal:1", lane: "manual", terminalSessionId: "terminal:1/manual" }));
  });

  it("attaches the latest block to chat as a fenced block naming the tab", async () => {
    const onAttachText = vi.fn(() => true);
    const terminal = renderView(onAttachText);
    const attach = await screen.findByTestId("terminal-blocks-attach-last");
    expect(onAttachText).not.toHaveBeenCalled();
    expect(terminal.getBlock).not.toHaveBeenCalled();
    fireEvent.click(attach);
    await waitFor(() => expect(onAttachText).toHaveBeenCalledTimes(1));
    expect(terminal.getBlock).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:1", lane: "manual", terminalSessionId: "terminal:1/manual" }), 2);
    const text = (onAttachText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("Terminal 1 · terminal:1/manual · terminal:1 · #2");
    expect(text).toContain("신뢰할 수 없는 내용");
    expect(text).toContain("$ npm test\nout");
    expect(text.split("\n")[1]).toBe("```console");
  });

  it("lists blocks, filters them by command, and attaches the selected one", async () => {
    const onAttachText = vi.fn(() => true);
    renderView(onAttachText);
    fireEvent.click(await screen.findByTestId("terminal-blocks-toggle"));
    await waitFor(() => expect(screen.getAllByTestId("terminal-block-row")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("terminal-blocks-search"), { target: { value: "GIT" } });
    const rows = screen.getAllByTestId("terminal-block-row");
    expect(rows).toHaveLength(1);
    fireEvent.click(rows[0]!);
    fireEvent.click(screen.getByTestId("terminal-block-attach"));
    await waitFor(() => expect(onAttachText).toHaveBeenCalledTimes(1));
    expect((onAttachText.mock.calls[0] as unknown as [string])[0]).toContain("$ git status");
  });

  it("says so when the composer is full", async () => {
    renderView(() => false);
    fireEvent.click(await screen.findByTestId("terminal-blocks-attach-last"));
    expect(await screen.findByRole("status")).toBeTruthy();
  });
});

describe("PtyTerminalView tab identity across groups", () => {
  it("gives two groups' first terminals distinct PTYs", async () => {
    const groupA = renderHook(() => useWorkspaceTabs());
    const groupB = renderHook(() => useWorkspaceTabs());
    act(() => groupA.result.current.addTab("terminal"));
    act(() => groupB.result.current.addTab("terminal"));
    const tabA = groupA.result.current.tabs[0]!;
    const tabB = groupB.result.current.tabs[0]!;
    // Labels and PTY identities are distinct across groups.
    expect(tabA.ordinal).not.toBe(tabB.ordinal);
    expect(tabA.id).not.toBe(tabB.id);

    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal };
    render(
      <>
        <PtyTerminalView api={ave as never} location="pane:a" tabId={tabA.id} tabLabel={`Terminal ${tabA.ordinal}`} />
        <PtyTerminalView api={ave as never} location="pane:b" tabId={tabB.id} tabLabel={`Terminal ${tabB.ordinal}`} />
      </>,
    );
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    const spawnedIds = (terminal.spawn.mock.calls as unknown as Array<[{ tabId: string }]>).map(([req]) => req.tabId);
    expect(new Set(spawnedIds)).toEqual(new Set([tabA.id, tabB.id]));
    expect(screen.queryByTestId("pty-terminal-mounted-elsewhere")).toBeNull();
  });

  it("mounts one tab in one place only and hands the mount over when the holder leaves", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal };
    const view = (location: string) => (
      <PtyTerminalView key={location} api={ave as never} location={location} tabId="terminal:7" tabLabel="Terminal 7" />
    );
    const { rerender } = render(<>{view("side-panel")}{view("pane:main")}</>);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    // The second view does not attach a second xterm to the same PTY.
    expect(terminals).toHaveLength(1);
    const notice = screen.getByTestId("pty-terminal-mounted-elsewhere");
    expect(notice.getAttribute("data-owner-location")).toBe("side-panel");
    expect(surfaceMountLocation("terminal:7")).toBe("side-panel");

    rerender(<>{view("pane:main")}</>);
    await waitFor(() => expect(surfaceMountLocation("terminal:7")).toBe("pane:main"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("pty-terminal-mounted-elsewhere")).toBeNull();
    expect(terminal.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "terminal:7" }));

    rerender(<></>);
    expect(surfaceMountLocation("terminal:7")).toBeNull();
  });
});

describe("PtyTerminalView environment and session boundaries", () => {
  it("labels the host launch directory without claiming it is current or saving it", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:11" tabLabel="Terminal 11" initialCwd="/repo/app" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ lane: "manual", cwd: "/repo/app" })));
    // The launch directory is the chip's tooltip; the row's directory waits for the shell to report one.
    await waitFor(() => expect(screen.getByTestId("terminal-pane-host-chip").getAttribute("title")).toContain(t("ptyTerminal.initialCwd", { cwd: "/repo/app" })));
    expect(screen.getByTestId("terminal-pane-cwd").textContent).toBe("");
    expect(terminalCwd("terminal:11")).toBeNull();
  });

  it("shows the directory the shell reported as its last segment in the header row, the full path on hover", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.listBlocks.mockImplementation(async (session: TerminalSessionInfo) => ({ ok: true as const,
      session: { ...session, currentCwd: "/repo/app/packages/web", cwdSource: "shell-marker" as const }, integrated: true, blocks: [] }));
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:16" tabLabel="Terminal 16" initialCwd="/repo/app" />);
    const cwd = screen.getByTestId("terminal-pane-cwd");
    await waitFor(() => expect(cwd.textContent).toBe("web"));
    expect(cwd.getAttribute("title")).toBe("/repo/app/packages/web");
    expect(screen.getByTestId("terminal-pane-host-chip").getAttribute("title")).not.toContain("/repo/app");
  });

  it("refuses an invalid explicitly chosen directory without silently changing it", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.spawn.mockResolvedValueOnce({ ok: false, reason: "spawn-failed", message: "missing directory" } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:12" tabLabel="Terminal 12" initialCwd="/elsewhere" />);
    await waitFor(() => expect(fakeTerm().written.join("")).toContain(t("ptyTerminal.manualUnavailable")));
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("identifies a retiring shell and starts nowhere else", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.spawn.mockResolvedValueOnce({ ok: false, reason: "still-closing", message: "still closing" } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:13" tabLabel="Terminal 13" initialCwd="/repo/app" />);
    await waitFor(() => expect(fakeTerm().written.join("")).toContain(t("ptyTerminal.stillClosing")));
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("buffers pre-reply replay by lane and incarnation, then ignores retired output", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const tabId = "terminal:14";
    const manual = terminalSessionFixture(tabId, "manual", "live-manual");
    terminal.spawn.mockImplementation(async () => {
      const data = terminal.onData.mock.calls.at(-1)![0];
      data({ ...manual, terminalSessionId: "old-manual", chunk: "OLD" });
      data({ ...terminalSessionFixture(tabId, "agent"), chunk: "AGENT" });
      data({ ...manual, chunk: "MANUAL" });
      return { ok: true, tabId, replayed: true, session: manual, blockMarkerToken: "view-token" };
    });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId={tabId} tabLabel="Terminal 14" />);
    await waitFor(() => expect(fakeTerm().written.join("")).toBe("MANUAL"));
    act(() => terminal.onData.mock.calls.at(-1)![0]({ ...manual, terminalSessionId: "old-manual", chunk: "LATE" }));
    expect(fakeTerm().written.join("")).toBe("MANUAL");
    act(() => typeInto(fakeTerm(), "user"));
    expect(terminal.input).toHaveBeenCalledWith(manual, "user");
  });

  it("explains unavailable integration without blocking the native host shell", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const session = { ...terminalSessionFixture("terminal:16", "manual"), shellIntegration: false, integrationUnavailableReason: "unsupported-shell" as const };
    terminal.spawn.mockResolvedValue({ ok: true, tabId: session.tabId, replayed: false, session, blockMarkerToken: "view-token" });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId={session.tabId} tabLabel="Terminal 16" />);
    expect(await screen.findByTestId("terminal-integration-unavailable")).toHaveTextContent(t("ptyTerminal.integrationUnsupportedShell"));
    act(() => typeInto(fakeTerm(), "user-command\r"));
    expect(terminal.input).toHaveBeenCalledWith(session, "user-command\r");
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("offers one private host shell without a lane switch and keeps it alive on unmount", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const tabId = "terminal:15";
    const view = render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId={tabId} tabLabel="Terminal 15" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ lane: "manual" }));
    // One row of chrome, as a pane header: the chip carries the identity, its tooltip the explanation.
    const header = screen.getByTestId("terminal-pane-header");
    const chip = within(header).getByTestId("terminal-pane-host-chip");
    // The name never shrinks; the detail is a separate part that a narrow header gives up first, before the pane's title.
    expect(chip.firstElementChild).toHaveTextContent(t("ptyTerminal.hostChip"));
    expect(chip.firstElementChild!.className).toContain("shrink-0");
    expect(within(chip).getByTestId("terminal-pane-host-chip-detail")).toHaveTextContent(`· ${t("ptyTerminal.hostChipAgentless")}`);
    expect(chip.textContent).toBe(`${t("ptyTerminal.hostChip")} · ${t("ptyTerminal.hostChipAgentless")}`);
    expect(chip.getAttribute("title")).toContain(t("ptyTerminal.hostBadge"));
    expect(chip.getAttribute("title")).toContain(t("ptyTerminal.manualEnvironment"));
    await waitFor(() => expect(within(header).getByTestId("terminal-blocks-toggle")).toBeTruthy());
    expect(screen.queryByTestId("terminal-host-identity")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-pty-terminal").textContent).not.toContain(t("ptyTerminal.manualEnvironment"));
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(terminals).toHaveLength(1);
    view.unmount();
    expect(terminal.kill).not.toHaveBeenCalled();
  });
});

describe("PtyTerminalView host control strip", () => {
  it("declares the workspace purpose, shows the agent's period with Take over and Stop, then Hand back after a take-over", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    let announce: ((event: TerminalControlEvent) => void) | undefined;
    terminal.onControl.mockImplementation((handler: (event: TerminalControlEvent) => void) => { announce = handler; return () => { announce = undefined; }; });
    terminal.control.mockImplementation(async (_ref: TerminalSessionRef, action: TerminalControlAction): Promise<TerminalControlResult> =>
      action === "hand-back" ? { ok: false, error: "hand-back-command-running" }
        : { ok: true, control: { mode: action === "get" ? "available" : "taken-over", generation: 3, agentInput: "supported" } });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId="terminal:21" tabLabel="Terminal 21" />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:21" }), "get"));
    expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ lane: "manual", purpose: "workspace" }));
    // The header chip names the exposure; its tooltip carries the full statement.
    expect(screen.getByTestId("terminal-pane-host-chip").textContent).toBe(`${t("ptyTerminal.hostChip")} · ${t("ptyTerminal.hostChipApproval")}`);
    expect(screen.getByTestId("terminal-pane-host-chip").getAttribute("title")).toContain(t("ptyTerminal.hostBadgeWorkspace"));
    expect(screen.getByTestId("terminal-pane-host-chip").getAttribute("title")).toContain(t("ptyTerminal.workspaceEnvironment"));
    const session = terminalSessionFixture("terminal:21", "manual");
    act(() => announce!({ ...session, control: { mode: "agent", generation: 1, agentInput: "supported", command: "npm test", typed: true } }));
    expect(screen.getByTestId("terminal-agent-control")).toHaveTextContent(t("ptyTerminal.agentRunning", { command: "npm test" }));
    expect(screen.getByTestId("terminal-take-over-hint")).toHaveTextContent(t("ptyTerminal.typingTakesOver"));
    fireEvent.click(screen.getByTestId("terminal-take-over"));
    await waitFor(() => expect(screen.getByTestId("terminal-user-control")).toHaveTextContent(t("ptyTerminal.takenOver")));
    expect(terminal.control).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:21" }), "take-over");
    fireEvent.click(screen.getByTestId("terminal-hand-back"));
    // The refusal names the prompt's actual state, and the next control change clears it.
    expect(await screen.findByTestId("terminal-control-notice")).toHaveTextContent(t("ptyTerminal.handBackCommandRunning"));
    act(() => announce!({ ...session, control: { mode: "available", generation: 4, agentInput: "supported" } }));
    expect(screen.queryByTestId("terminal-control-notice")).toBeNull();
    // Another incarnation's announcement does not change this view.
    act(() => announce!({ ...session, terminalSessionId: "other", control: { mode: "agent", generation: 9, agentInput: "supported", command: "rm -rf x" } }));
    expect(screen.queryByTestId("terminal-agent-control")).toBeNull();
  });

  it("keeps the side panel terminal private and without agent controls, even after a take-over moved it there", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.control.mockImplementation(async (): Promise<TerminalControlResult> => ({ ok: true, control: { mode: "taken-over", generation: 2, agentInput: "supported" } }));
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:22" tabLabel="Terminal 22" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ purpose: "side-panel" })));
    const chip = screen.getByTestId("terminal-pane-host-chip");
    expect(chip.textContent).toBe(`${t("ptyTerminal.hostChip")} · ${t("ptyTerminal.hostChipAgentless")}`);
    expect(chip.getAttribute("title")).toContain(t("ptyTerminal.hostBadge"));
    expect(chip.getAttribute("title")).toContain(t("ptyTerminal.manualEnvironment"));
    await waitFor(() => expect(terminal.control).toHaveBeenCalled());
    expect(screen.queryByTestId("terminal-user-control")).toBeNull();
    expect(screen.queryByTestId("terminal-hand-back")).toBeNull();
  });

  it.each([
    ["powershell", "ptyTerminal.agentInputPowerShell"],
    ["unsupported", "ptyTerminal.agentInputUnsupported"],
  ] as const)("says a %s workspace terminal takes no agent input and drops the agent badge", async (agentInput, noteKey) => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.control.mockImplementation(async (): Promise<TerminalControlResult> => ({ ok: true, control: { mode: "available", generation: 0, agentInput } }));
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId="terminal:23" tabLabel="Terminal 23" />);
    // One header row: the chip says it in a word, its tooltip says why; no extra row over the output.
    await waitFor(() => expect(screen.getByTestId("terminal-pane-host-chip").textContent).toBe(`${t("ptyTerminal.hostChip")} · ${t("ptyTerminal.hostChipNoAgentInput")}`));
    const about = screen.getByTestId("terminal-pane-host-chip").getAttribute("title");
    expect(about).toContain(t(noteKey));
    expect(about).toContain(t("ptyTerminal.hostBadgeNoAgentInput"));
    expect(about).toContain(t("ptyTerminal.manualEnvironment"));
  });
});

describe("PtyTerminalView changed-file annotation", () => {
  it("anchors the warning to its command's row as an xterm decoration, with no overlay and no rows taken", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.listFileReviews.mockResolvedValue({ ok: true as const, snapshot: {
      cwd: "/workspace",
      latestBlockId: 1,
      files: [{ path: "/workspace/Makefile", sessionIds: ["conversation"], lastUsed: { command: "make build", when: 1_000 } }],
      warnings: [{ blockId: 1, command: "make build", files: ["/workspace/Makefile"] }],
    } } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:banner" tabLabel="Terminal 1" />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    const term = fakeTerm();
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    await act(async () => {});
    // Main forwards an authenticated C with its block id and this incarnation's view token while the cursor sits just
    // below the entered command. Copies without the token, as a program could print, are ignored.
    act(() => {
      osc133(term, "C;ave-block=1;ave-view=forged");
      osc133(term, "C;ave-block=1");
      osc133(term, "C;ave-block=1;ave-view=view-token");
    });
    expect(term.markers).toEqual([{ offset: -1, marker: expect.objectContaining({ line: 3 }) }]);
    const annotation = await screen.findByTestId("terminal-file-warning");
    expect(annotation).toHaveTextContent("# ⚠ 에이전트가 수정한 파일 사용: Makefile");
    expect(term.decorations).toHaveLength(1);
    const [decoration] = term.decorations;
    expect(decoration!.options.marker).toBe(term.markers[0]!.marker);
    expect(decoration!.options).toMatchObject({ height: 1, x: "~/demo ❯ make build".length + 2, width: 80 - ("~/demo ❯ make build".length + 2) });
    expect(decoration!.element).toContainElement(annotation);
    // Nothing reaches the shell or the buffer: no PTY input and no xterm writes for the warning.
    expect(terminal.input).not.toHaveBeenCalled();
    expect(term.written.join("")).not.toContain("에이전트");
    // No overlay strip: the xterm host remains the output area's only in-flow child.
    const outputArea = screen.getByTestId("terminal-output-area");
    const xtermHost = screen.getByTestId("terminal-xterm-host");
    expect([...outputArea.children].filter((child) => !child.classList.contains("absolute"))).toEqual([xtermHost]);
    expect(outputArea.querySelectorAll(".absolute")).toHaveLength(0);
    expect(xtermHost).toHaveClass("flex-1");
  });

  it("never draws a warning over a long command: it shrinks to the free columns after it", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.listFileReviews.mockResolvedValue({ ok: true as const, snapshot: {
      cwd: "/workspace", latestBlockId: 1,
      files: [{ path: "/workspace/Makefile", sessionIds: ["conversation"], lastUsed: { command: "make build", when: 1_000 } }],
      warnings: [{ blockId: 1, command: "make build", files: ["/workspace/Makefile"] }],
    } } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:long" tabLabel="Terminal 1" />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    const term = fakeTerm();
    term.commandRow = `~/demo ❯ make build ${"VERBOSE=1 ".repeat(4)}`.trimEnd();
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    await act(async () => {});
    act(() => { osc133(term, "C;ave-block=1;ave-view=view-token"); });
    const annotation = await screen.findByTestId("terminal-file-warning");
    const start = term.commandRow.length + 2;
    expect(term.decorations[0]!.options).toMatchObject({ x: start, width: 80 - start });
    expect(annotation).toHaveAttribute("data-form", "compact");
    expect(annotation.textContent).toBe("⚠[변경 보기]");
  });

  it("ignores a C marker without a main-assigned, token-proven block id", async () => {
    const { api } = makeMockAveApi();
    render(<PtyTerminalView api={{ ...api, terminal: terminalApi() } as never} location="side-panel" tabId="terminal:plain" tabLabel="Terminal 1" />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    await act(async () => {});
    act(() => {
      for (const data of ["C", "C;ave-block=x;ave-view=view-token", "C;ave-block=3", "C;ave-block=3;ave-view=other"]) osc133(fakeTerm(), data);
    });
    expect(fakeTerm().markers).toEqual([]);
  });
});

describe("PtyTerminalView keyboard focus", () => {
  it("focuses the terminal when it opens attended, so keystrokes reach the shell without a click", async () => {
    const { api } = makeMockAveApi();
    render(<PtyTerminalView api={{ ...api, terminal: terminalApi() } as never} location="side-panel" tabId="terminal:focus" tabLabel="Terminal 1" />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    expect(fakeTerm().focusCount).toBe(1);
  });

  it("focuses when its pane becomes attended, and not while unattended", async () => {
    const { api } = makeMockAveApi();
    const ave = { ...api, terminal: terminalApi() };
    const view = render(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:pane" tabLabel="Terminal 1" attended={false} />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    expect(fakeTerm().focusCount).toBe(0);
    view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:pane" tabLabel="Terminal 1" attended />);
    expect(fakeTerm().focusCount).toBe(1);
  });

  it("never takes focus from the chat composer the user is typing in", async () => {
    const { api } = makeMockAveApi();
    const ave = { ...api, terminal: terminalApi() };
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    try {
      const view = render(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:typing" tabLabel="Terminal 1" />);
      await waitFor(() => expect(terminals).toHaveLength(1));
      view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:typing" tabLabel="Terminal 1" attended={false} />);
      view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:typing" tabLabel="Terminal 1" attended />);
      expect(fakeTerm().focusCount).toBe(0);
      expect(document.activeElement).toBe(composer);
    } finally { composer.remove(); }
  });

  it("leaves focus on an approval card's button on open and on activation", async () => {
    const { api } = makeMockAveApi();
    const ave = { ...api, terminal: terminalApi() };
    const card = document.createElement("div");
    card.setAttribute("data-approval-scope", "");
    const allow = document.createElement("button");
    allow.textContent = "Allow once";
    card.appendChild(allow);
    document.body.appendChild(card);
    allow.focus();
    try {
      const view = render(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:approval" tabLabel="Terminal 1" />);
      await waitFor(() => expect(terminals).toHaveLength(1));
      await act(async () => {});
      view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:approval" tabLabel="Terminal 1" attended={false} />);
      view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:approval" tabLabel="Terminal 1" attended />);
      expect(fakeTerm().focusCount).toBe(0);
      expect(document.activeElement).toBe(allow);
    } finally { card.remove(); }
  });

  it("takes focus only from this terminal's own selected tab, and keeps any other focused control", async () => {
    const { api } = makeMockAveApi();
    const ave = { ...api, terminal: terminalApi() };
    // A tab strip entry as the side panel renders it: the tab button inside its tab's `data-tab-id` wrapper.
    const tabFor = (tabId: string) => {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-tab-id", tabId);
      const button = document.createElement("button");
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", "true");
      wrapper.appendChild(button);
      document.body.appendChild(wrapper);
      return { button, remove: () => wrapper.remove() };
    };
    const own = tabFor("terminal:tab");
    const other = tabFor("terminal:other");
    const cycle = (view: ReturnType<typeof render>) => {
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended={false} />);
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended />);
    };
    try {
      own.button.focus();
      const view = render(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended={false} />);
      await waitFor(() => expect(terminals).toHaveLength(1));
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended />);
      expect(fakeTerm().focusCount).toBe(1);
      // A selected tab in another area is not an activation of this terminal.
      other.button.focus();
      cycle(view);
      expect(fakeTerm().focusCount).toBe(1);
      expect(document.activeElement).toBe(other.button);
      // Nor is a tab that is no longer selected.
      own.button.setAttribute("aria-selected", "false");
      own.button.focus();
      cycle(view);
      expect(fakeTerm().focusCount).toBe(1);
      // A control inside the terminal keeps focus too.
      const chip = view.getByTestId("terminal-pane-host-chip");
      chip.focus();
      cycle(view);
      expect(fakeTerm().focusCount).toBe(1);
      expect(document.activeElement).toBe(chip);
    } finally { own.remove(); other.remove(); }
  });

  it("writes nothing to the PTY when it opens or is activated", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal };
    const view = render(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:quiet" tabLabel="Terminal 1" />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    await act(async () => {});
    view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:quiet" tabLabel="Terminal 1" attended={false} />);
    view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:quiet" tabLabel="Terminal 1" attended />);
    await act(async () => {});
    expect(fakeTerm().focusCount).toBe(2);
    expect(terminal.input).not.toHaveBeenCalled();
  });
});

describe("SidePanelTerminal", () => {
  function Harness({ ave }: { ave: never }) {
    const [showChanges, setShowChanges] = useState(false);
    return <TooltipProvider><SidePanelTerminal api={ave} tabId="terminal:side" tabLabel="Terminal 1" visible showChanges={showChanges} onShowChanges={setShowChanges} /></TooltipProvider>;
  }

  it("shows the side-panel terminal's 변경 파일 view in the work panel on [view changes], and returns to the same shell", async () => {
    const previousAve = window.ave;
    (window as unknown as { ave: unknown }).ave = makeMockAveNamespace().ns;
    try {
      const { api } = makeMockAveApi();
      const terminal = terminalApi();
      render(<Harness ave={{ ...api, terminal } as never} />);
      await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("terminal-changes-view")).toBeNull();
      act(() => { requestTerminalFileReview("terminal:side", "/workspace/Makefile"); });
      expect(await screen.findByTestId("terminal-changes-view")).toBeTruthy();
      expect(screen.queryByTestId("terminal-xterm-host")).toBeNull();
      // The PTY outlives the view switch, as it outlives a tab switch.
      expect(terminal.kill).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("terminal-changes-back"));
      expect(await screen.findByTestId("terminal-xterm-host")).toBeTruthy();
      expect(terminal.kill).not.toHaveBeenCalled();
    } finally {
      (window as unknown as { ave: unknown }).ave = previousAve;
      forgetTerminalFileReview("terminal:side");
    }
  });
});

describe("a terminal tab keeps its xterm across views", () => {
  it("re-parents the same xterm on a tab switch: no second shell request, no replay, and output written while hidden is kept", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const tabId = "terminal:31";
    const session = terminalSessionFixture(tabId, "manual");
    const ave = { ...api, terminal } as never;
    const first = render(<PtyTerminalView api={ave} location="pane:a" tabId={tabId} tabLabel="Terminal 31" />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalledWith(expect.objectContaining({ tabId }), "get"));
    const deliver = terminal.onData.mock.calls.at(-1)![0];
    act(() => deliver({ ...session, chunk: "line-1\r\n" }));
    const xterm = fakeTerm();
    expect(xterm.element!.isConnected).toBe(true);

    // Another tab is shown in the pane: the view unmounts, the xterm does not.
    first.unmount();
    expect(xterm.disposed).toBe(false);
    expect(xterm.element!.isConnected).toBe(false);
    act(() => deliver({ ...session, chunk: "while-hidden\r\n" }));
    expect(xterm.written.join("")).toBe("line-1\r\nwhile-hidden\r\n");

    render(<PtyTerminalView api={ave} location="pane:a" tabId={tabId} tabLabel="Terminal 31" />);
    await waitFor(() => expect(xterm.element!.isConnected).toBe(true));
    expect(screen.getByTestId("terminal-xterm-host").contains(xterm.element)).toBe(true);
    // The same instance, and nothing asked main to replay into it.
    expect(terminals).toHaveLength(1);
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
    expect(xterm.written.join("")).toBe("line-1\r\nwhile-hidden\r\n");
    await waitFor(() => expect(screen.getByTestId("terminal-pane-host-chip")).toBeTruthy());
    act(() => typeInto(xterm, "typed"));
    expect(terminal.input).toHaveBeenCalledWith(expect.objectContaining({ tabId, terminalSessionId: session.terminalSessionId }), "typed");
  });

  it("declares a move between the side panel and a pane without asking for a replay", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal } as never;
    const view = (location: string) => <PtyTerminalView key={location} api={ave} location={location} tabId="terminal:32" tabLabel="Terminal 32" />;
    const shown = render(view("side-panel"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    expect(terminal.spawn.mock.calls[0]![0]).not.toHaveProperty("replay");
    shown.rerender(view("pane:main"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    expect(terminal.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "terminal:32", purpose: "workspace", replay: false }));
    expect(terminals).toHaveLength(1);
  });

  it("releases the xterm when the tab closes", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const shown = render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId="terminal:33" tabLabel="Terminal 33" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    disposeLiveTerminal("terminal:33");
    expect(fakeTerm().disposed).toBe(true);
    shown.unmount();
  });
});

describe("a terminal the user opens takes the keyboard", () => {
  function launcherWithFocus(): HTMLButtonElement {
    const launcher = document.createElement("button");
    document.body.appendChild(launcher);
    launcher.focus();
    expect(document.activeElement).toBe(launcher);
    return launcher;
  }

  it("focuses a terminal opened from the main launcher or the side panel's new-tab menu while that control still has focus", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal } as never;
    const launcher = launcherWithFocus();
    try {
      // The two open funnels: a main-area surface and a side-panel tab.
      const surfaces = renderHook(() => useMainSurfaces());
      let mainTab = "";
      act(() => { mainTab = surfaces.result.current.create("terminal", { projectRoot: "/repo" }).tabId; });
      const tabs = renderHook(() => useWorkspaceTabs());
      act(() => tabs.result.current.addTab("terminal"));
      const sideTab = tabs.result.current.tabs[0]!.id;
      render(<PtyTerminalView api={ave} location="pane:a" tabId={mainTab} tabLabel="Terminal" />);
      await waitFor(() => expect(terminals).toHaveLength(1));
      expect(fakeTerm().focusCount).toBe(1);
      launcher.focus();
      render(<PtyTerminalView api={ave} location="side-panel" tabId={sideTab} tabLabel="Terminal" />);
      await waitFor(() => expect(terminals).toHaveLength(2));
      expect(fakeTerm(1).focusCount).toBe(1);
    } finally { launcher.remove(); }
  });

  it("asks once: a later passive remount leaves focus on the control that has it", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal } as never;
    const launcher = launcherWithFocus();
    try {
      requestTerminalFocus("terminal:41");
      const first = render(<PtyTerminalView api={ave} location="pane:a" tabId="terminal:41" tabLabel="Terminal 41" />);
      await waitFor(() => expect(terminals).toHaveLength(1));
      expect(fakeTerm().focusCount).toBe(1);
      first.unmount();
      launcher.focus();
      render(<PtyTerminalView api={ave} location="pane:a" tabId="terminal:41" tabLabel="Terminal 41" />);
      await waitFor(() => expect(fakeTerm().element!.isConnected).toBe(true));
      expect(fakeTerm().focusCount).toBe(1);
      // A terminal nobody asked for (a restored tab) never takes it either.
      render(<PtyTerminalView api={ave} location="pane:b" tabId="terminal:42" tabLabel="Terminal 42" />);
      await waitFor(() => expect(terminals).toHaveLength(2));
      expect(fakeTerm(1).focusCount).toBe(0);
    } finally { launcher.remove(); }
  });
});

describe("a terminal whose shell ended", () => {
  async function endedTerminal(tabId: string, onCloseTab?: () => void) {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const first = { ...terminalSessionFixture(tabId, "manual", "first-shell"), currentCwd: "/repo/app", cwdSource: "shell-marker" as const };
    terminal.spawn.mockResolvedValueOnce({ ok: true, tabId, replayed: false, session: first, blockMarkerToken: "view-token" });
    terminal.listBlocks.mockImplementation(async (session: TerminalSessionInfo) => ({ ok: true as const, session, integrated: true, blocks: [] }));
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId={tabId} tabLabel="Terminal" {...(onCloseTab ? { onCloseTab } : {})} />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: "first-shell" }), "get"));
    expect(screen.queryByTestId("terminal-ended")).toBeNull();
    act(() => terminal.onExit.mock.calls.at(-1)![0]({ ...first, exitCode: 3 }));
    return { terminal, first, xterm: fakeTerm() };
  }

  it("says it ended, hides the cursor, and offers Restart shell and Close tab", async () => {
    const close = vi.fn();
    const { terminal, first, xterm } = await endedTerminal("terminal:51", close);
    const strip = screen.getByTestId("terminal-ended");
    expect(within(strip).getByTestId("terminal-ended-chip")).toHaveTextContent(t("ptyTerminal.endedChip"));
    expect(strip).toHaveTextContent(t("ptyTerminal.endedExit", { code: 3 }));
    // DECTCEM hide after the exit line; the buffer names the way back.
    expect(xterm.written.at(-1)).toContain(t("ptyTerminal.exitedRestartHint"));
    expect(xterm.written.at(-1)!.endsWith("\x1b[?25l")).toBe(true);
    // Keys other than Enter go nowhere: the dead incarnation takes no input and no new shell starts.
    act(() => typeInto(xterm, "ls"));
    expect(terminal.input).not.toHaveBeenCalled();
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
    fireEvent.click(within(strip).getByTestId("terminal-close-tab"));
    expect(close).toHaveBeenCalledOnce();

    fireEvent.click(within(strip).getByTestId("terminal-restart"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    // The new shell starts where the ended one was, in the same xterm, with the cursor shown again.
    expect(terminal.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "terminal:51", cwd: "/repo/app", purpose: "workspace" }));
    expect(terminal.spawn.mock.calls[1]![0]).not.toHaveProperty("replay");
    await waitFor(() => expect(screen.queryByTestId("terminal-ended")).toBeNull());
    expect(terminals).toHaveLength(1);
    expect(xterm.written.join("")).toContain("\x1b[?25h");
    act(() => typeInto(xterm, "pwd\r"));
    expect(terminal.input).toHaveBeenCalledWith(expect.not.objectContaining({ terminalSessionId: first.terminalSessionId }), "pwd\r");
  });

  it("restarts on Enter, and offers no Close tab where the tab has no close of its own", async () => {
    const { terminal, xterm } = await endedTerminal("terminal:52");
    expect(screen.queryByTestId("terminal-close-tab")).toBeNull();
    act(() => typeInto(xterm, "\r"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("terminal-ended")).toBeNull());
  });

  it("does not start a new shell on its own when the ended tab is shown again", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal } as never;
    const shown = render(<PtyTerminalView api={ave} location="pane:a" tabId="terminal:53" tabLabel="Terminal" />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalled());
    act(() => terminal.onExit.mock.calls.at(-1)![0]({ ...terminalSessionFixture("terminal:53", "manual"), exitCode: 0 }));
    shown.unmount();
    render(<PtyTerminalView api={ave} location="side-panel" tabId="terminal:53" tabLabel="Terminal" />);
    expect(await screen.findByTestId("terminal-ended")).toBeInTheDocument();
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("offers a restart when the shell could not be started", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.spawn.mockResolvedValueOnce({ ok: false, reason: "spawn-failed", message: "missing directory" } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:54" tabLabel="Terminal" initialCwd="/elsewhere" />);
    expect(await screen.findByTestId("terminal-ended")).toHaveTextContent(t("ptyTerminal.endedNotStarted"));
    fireEvent.click(screen.getByTestId("terminal-restart"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("terminal-ended")).toBeNull());
  });
});

describe("the terminal's own context menu", () => {
  function menuBridge() {
    const previous = (window as unknown as { ave?: unknown }).ave;
    let handler: ((action: { requestId: string; id: string }) => void) | null = null;
    const showDynamicMenu = vi.fn(async (_payload: { requestId: string; x: number; y: number; sections: Array<{ items: Array<{ id: string; label: string; enabled?: boolean }> }> }) => ({ ok: true as const }));
    (window as unknown as { ave?: unknown }).ave = { ui: { showDynamicMenu, onDynamicMenuAction: (cb: typeof handler) => { handler = cb; return () => { handler = null; }; } } };
    return {
      showDynamicMenu,
      sections: () => showDynamicMenu.mock.calls.at(-1)![0].sections.map((section) => section.items),
      choose: async (id: string) => { await act(async () => { handler!({ requestId: showDynamicMenu.mock.calls.at(-1)![0].requestId, id }); }); },
      restore: () => { (window as unknown as { ave?: unknown }).ave = previous; },
    };
  }
  async function terminalWithMenu(tabId: string, attach?: (text: string) => true | "full" | "no-composer") {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const writeText = vi.fn(async (_text: string) => undefined);
    const readText = vi.fn(async () => "pasted text");
    vi.stubGlobal("navigator", { ...navigator, userAgent: navigator.userAgent, clipboard: { writeText, readText } });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId={tabId} tabLabel="Terminal 7" {...(attach ? { onAttachText: attach } : {})} />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalled());
    const xterm = fakeTerm();
    const rightClick = async (clientY: number) => {
      const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY });
      await act(async () => { screen.getByTestId("terminal-xterm-host").dispatchEvent(event); });
      return event;
    };
    return { terminal, xterm, writeText, readText, rightClick };
  }
  afterEach(() => vi.unstubAllGlobals());

  it("offers Copy, Paste, Select All and Clear at the pointer, and nothing about blocks above the first command", async () => {
    const bridge = menuBridge();
    try {
      const { xterm, writeText, rightClick } = await terminalWithMenu("terminal:71");
      const event = await rightClick(120);
      // The generic text menu is replaced, not added to.
      expect(event.defaultPrevented).toBe(true);
      expect(bridge.showDynamicMenu).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ x: 40, y: 120 }));
      expect(bridge.sections()).toEqual([[
        { id: "copy", label: t("ptyTerminal.menuCopy"), enabled: false },
        { id: "paste", label: t("ptyTerminal.menuPaste"), enabled: true },
        { id: "select-all", label: t("ptyTerminal.menuSelectAll") },
        { id: "clear", label: t("ptyTerminal.menuClear") },
      ]]);
      await bridge.choose("select-all");
      expect(xterm.selectedAll).toBe(1);
      await rightClick(120);
      expect(bridge.sections()[0]![0]).toMatchObject({ id: "copy", enabled: true });
      await bridge.choose("copy");
      expect(writeText).toHaveBeenCalledWith("everything");
      await rightClick(120);
      await bridge.choose("paste");
      await waitFor(() => expect(xterm.pasted).toEqual(["pasted text"]));
      await rightClick(120);
      await bridge.choose("clear");
      expect(xterm.clears).toBe(1);
    } finally { bridge.restore(); }
  });

  it("adds the command block under the pointer: copy its command, copy its output, attach it", async () => {
    const bridge = menuBridge();
    try {
      const attach = vi.fn((_text: string) => true as const);
      const { terminal, xterm, writeText, rightClick } = await terminalWithMenu("terminal:72", attach);
      terminal.getBlock.mockImplementation((async (_session: TerminalSessionInfo, id: number) => ({
        ok: true as const,
        block: { id, command: id === 1 ? "make build" : "make test", cwd: "/repo", exitCode: 0, startedAt: 1, endedAt: 2, status: "done", source: "osc133", outputChars: 9, truncated: false, output: id === 1 ? "built ok\n\n" : "2 passed\n" },
      })) as never);
      // Two commands: the first started on buffer line 3 (its marker is one above the cursor), the second on line 9.
      xterm.cursorLine = 4;
      act(() => { osc133(xterm, "C;ave-block=1;ave-view=view-token"); });
      xterm.cursorLine = 10;
      act(() => { osc133(xterm, "C;ave-block=2;ave-view=view-token"); });

      // Row 2 (y 120..129) is above both; row 5 is inside the first block; row 9 and below are the second.
      await rightClick(125);
      expect(bridge.sections()).toHaveLength(1);
      await rightClick(155);
      expect(bridge.sections()[1]!.map((item) => item.id)).toEqual(["block-copy-command", "block-copy-output", "block-attach"]);
      await bridge.choose("block-copy-command");
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("make build"));
      expect(terminal.getBlock).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "terminal:72" }), 1);
      await rightClick(155);
      await bridge.choose("block-copy-output");
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("built ok"));

      await rightClick(300);
      await bridge.choose("block-attach");
      await waitFor(() => expect(attach).toHaveBeenCalledOnce());
      expect(terminal.getBlock).toHaveBeenLastCalledWith(expect.anything(), 2);
      expect(attach.mock.calls[0]![0]).toContain("make test");
      expect(attach.mock.calls[0]![0]).toContain("2 passed");
    } finally { bridge.restore(); }
  });

  it("says why when the block cannot be read or the chat cannot take it", async () => {
    const bridge = menuBridge();
    try {
      const attach = vi.fn((_text: string) => "no-composer" as const);
      const { terminal, xterm, rightClick } = await terminalWithMenu("terminal:73", attach);
      act(() => { osc133(xterm, "C;ave-block=1;ave-view=view-token"); });
      await rightClick(300);
      await bridge.choose("block-copy-output");
      expect((await screen.findByTestId("terminal-menu-notice")).textContent).toMatch(new RegExp(`^${t("terminalBlocks.loadFailed", { error: "(.+)" })}$`, "u"));
      terminal.getBlock.mockResolvedValueOnce({ ok: true, block: { id: 1, command: "ls", cwd: "/repo", exitCode: 0, startedAt: 1, endedAt: 2, status: "done", source: "osc133", outputChars: 0, truncated: false, output: "" } } as never);
      // Opening the menu again clears the old notice.
      await rightClick(300);
      expect(screen.queryByTestId("terminal-menu-notice")).toBeNull();
      await bridge.choose("block-attach");
      expect(await screen.findByTestId("terminal-menu-notice")).toHaveTextContent(t("terminalBlocks.attachNoComposer"));
    } finally { bridge.restore(); }
  });

  it("leaves the platform's menu alone where the menu bridge is not available", async () => {
    const previous = (window as unknown as { ave?: unknown }).ave;
    (window as unknown as { ave?: unknown }).ave = undefined;
    try {
      const { rightClick } = await terminalWithMenu("terminal:74");
      expect((await rightClick(120)).defaultPrevented).toBe(false);
    } finally { (window as unknown as { ave?: unknown }).ave = previous; }
  });
});

describe("find in the terminal", () => {
  async function terminalWithFind(tabId: string) {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    searches.length = 0;
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId={tabId} tabLabel="Terminal" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    return { xterm: fakeTerm(), search: searches[0]! };
  }
  // The test platform is not macOS: the app's search key is Ctrl+F.
  const searchKey = () => new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true });

  it("opens on the app's search key pressed in the terminal, and keeps that key from the shell and from the window's own search", async () => {
    const { xterm } = await terminalWithFind("terminal:95");
    expect(screen.queryByTestId("terminal-find-bar")).toBeNull();
    const windowSearch = vi.fn();
    window.addEventListener("keydown", windowSearch);
    try {
      const key = searchKey();
      const stop = vi.spyOn(key, "stopPropagation");
      let handled = true;
      act(() => { handled = offerKey(xterm, key); });
      expect(handled).toBe(false);
      expect(key.defaultPrevented).toBe(true);
      expect(stop).toHaveBeenCalled();
      // A plain "f", and the key's release, stay the shell's.
      expect(offerKey(xterm, new KeyboardEvent("keydown", { key: "f" }))).toBe(true);
      expect(offerKey(xterm, new KeyboardEvent("keyup", { key: "f", ctrlKey: true }))).toBe(true);
    } finally { window.removeEventListener("keydown", windowSearch); }
    const bar = await screen.findByTestId("terminal-find-bar");
    // The search landmark element: its role is "search" without an attribute.
    expect(bar.tagName).toBe("SEARCH");
    expect(document.activeElement).toBe(within(bar).getByTestId("terminal-find-input"));
  });

  it("searches as the query is typed, steps with Enter and Shift+Enter, and reports where it stands", async () => {
    const { xterm, search } = await terminalWithFind("terminal:96");
    act(() => { offerKey(xterm, searchKey()); });
    const input = await screen.findByTestId("terminal-find-input");
    const status = screen.getByTestId("terminal-find-status");
    expect(status).toHaveTextContent("");
    expect(screen.getByTestId("terminal-find-next")).toBeDisabled();

    fireEvent.change(input, { target: { value: "error" } });
    expect(search.calls.at(-1)).toMatchObject({ direction: "next", query: "error", options: { caseSensitive: false, incremental: true } });
    // The other matches are marked, in colours the addon accepts (#RRGGBB).
    for (const colour of Object.values(search.calls.at(-1)!.options.decorations!)) expect(colour).toMatch(/^#[0-9a-f]{6}$/iu);
    act(() => search.emit(0, 5));
    expect(status).toHaveTextContent(t("ptyTerminal.findCount", { index: 1, count: 5 }));

    fireEvent.keyDown(input, { key: "Enter" });
    expect(search.calls.at(-1)).toMatchObject({ direction: "next", query: "error", options: { incremental: false } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(search.calls.at(-1)).toMatchObject({ direction: "previous", query: "error" });
    fireEvent.click(screen.getByTestId("terminal-find-previous"));
    fireEvent.click(screen.getByTestId("terminal-find-next"));
    expect(search.calls.slice(-2).map((call) => call.direction)).toEqual(["previous", "next"]);
    // An IME commit's Enter is the composition's, not a step.
    const before = search.calls.length;
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(search.calls).toHaveLength(before);

    fireEvent.click(screen.getByTestId("terminal-find-case"));
    expect(screen.getByTestId("terminal-find-case")).toHaveAttribute("aria-pressed", "true");
    expect(search.calls.at(-1)).toMatchObject({ query: "error", options: { caseSensitive: true } });

    search.found = false;
    fireEvent.change(input, { target: { value: "errorz" } });
    expect(status).toHaveTextContent(t("ptyTerminal.findNoResults"));
    expect(input).toHaveAttribute("aria-invalid", "true");
    // An emptied query clears the marks instead of searching for nothing.
    const cleared = search.cleared;
    fireEvent.change(input, { target: { value: "" } });
    expect(search.cleared).toBe(cleared + 1);
    expect(status).toHaveTextContent("");
  });

  it("closes on Escape: the marks go and the keyboard returns to the shell", async () => {
    const { xterm, search } = await terminalWithFind("terminal:97");
    act(() => { offerKey(xterm, searchKey()); });
    const input = await screen.findByTestId("terminal-find-input");
    fireEvent.change(input, { target: { value: "make" } });
    const focused = xterm.focusCount;
    const cleared = search.cleared;
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("terminal-find-bar")).toBeNull());
    expect(search.cleared).toBeGreaterThan(cleared);
    expect(xterm.focusCount).toBe(focused + 1);
    // And the close button does the same.
    act(() => { offerKey(xterm, searchKey()); });
    fireEvent.click(await screen.findByTestId("terminal-find-close"));
    await waitFor(() => expect(screen.queryByTestId("terminal-find-bar")).toBeNull());
    expect(xterm.focusCount).toBe(focused + 2);
  });
});

describe("character widths", () => {
  it("measures with the Unicode 11 tables, so an emoji takes the two cells its program assumed", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId="terminal:91" tabLabel="Terminal" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    const { unicode } = fakeTerm();
    expect(unicode.activeVersion).toBe("11");
    const active = unicode.providers.get(unicode.activeVersion)!;
    // U+1F91D (handshake, Unicode 9) and U+1F600 are wide; a Hangul syllable stays wide and a Latin letter narrow.
    expect([0x1f91d, 0x1f600, 0xd55c, 0x41].map((codepoint) => active.wcwidth(codepoint))).toEqual([2, 2, 2, 1]);
  });
});

describe("input the shell did not receive", () => {
  async function liveTerminal(tabId: string) {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const session = terminalSessionFixture(tabId, "manual", "live-shell");
    terminal.spawn.mockResolvedValueOnce({ ok: true, tabId, replayed: false, session, blockMarkerToken: "view-token" });
    terminal.listBlocks.mockImplementation(async (ref: TerminalSessionInfo) => ({ ok: true as const, session: ref, integrated: true, blocks: [] }));
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId={tabId} tabLabel="Terminal" />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: "live-shell" }), "get"));
    return { terminal, session, xterm: fakeTerm() };
  }

  it("says a paste over the limit was not sent, and clears once input arrives again", async () => {
    const { terminal, xterm } = await liveTerminal("terminal:81");
    expect(screen.queryByTestId("terminal-input-notice")).toBeNull();
    terminal.input.mockResolvedValueOnce({ ok: false, error: "invalid-params" } as never);
    await act(async () => { typeInto(xterm, "x".repeat(64)); });
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputTooLarge"));
    expect(screen.getByTestId("terminal-input-notice")).toHaveAttribute("role", "alert");
    await act(async () => { typeInto(xterm, "a"); });
    await waitFor(() => expect(screen.queryByTestId("terminal-input-notice")).toBeNull());
  });

  it("says input for a replaced shell was not delivered, whether main refuses it or the call fails", async () => {
    const { terminal, xterm } = await liveTerminal("terminal:82");
    terminal.input.mockResolvedValueOnce({ ok: false, error: "stale-terminal-session" } as never);
    await act(async () => { typeInto(xterm, "ls\r"); });
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputNotDelivered"));
    await act(async () => { typeInto(xterm, "a"); });
    await waitFor(() => expect(screen.queryByTestId("terminal-input-notice")).toBeNull());
    terminal.input.mockRejectedValueOnce(new Error("ipc closed"));
    await act(async () => { typeInto(xterm, "b"); });
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputNotDelivered"));
  });

  it("leaves a refusal that raced the shell's exit to the Ended strip", async () => {
    const { terminal, session, xterm } = await liveTerminal("terminal:83");
    let refuse!: (value: { ok: false; error: string }) => void;
    terminal.input.mockReturnValueOnce(new Promise((resolve) => { refuse = resolve; }) as never);
    act(() => typeInto(xterm, "exit\r"));
    act(() => terminal.onExit.mock.calls.at(-1)![0]({ ...session, exitCode: 0 }));
    await act(async () => { refuse({ ok: false, error: "stale-terminal-session" }); });
    expect(screen.getByTestId("terminal-ended")).toBeTruthy();
    expect(screen.queryByTestId("terminal-input-notice")).toBeNull();
  });
});

describe("input typed before the shell is there to take it", () => {
  /** A terminal whose shell start the test completes when it chooses. */
  function startingTerminal(tabId: string) {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const session = terminalSessionFixture(tabId, "manual", "slow-shell");
    let reply: (result: unknown) => void = () => { throw new Error("no shell start is waiting"); };
    terminal.spawn.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve as (result: unknown) => void; }) as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId={tabId} tabLabel="Terminal" />);
    const started = async (): Promise<void> => {
      await act(async () => { reply({ ok: true, tabId, replayed: false, session, blockMarkerToken: "view-token" }); });
      await waitFor(() => expect(terminal.control).toHaveBeenCalled());
    };
    const failed = (): Promise<void> => act(async () => { reply({ ok: false, reason: "spawn-failed", message: "no shell" }); });
    return { terminal, session, started, failed };
  }

  it("keeps it and gives it to the shell when the shell starts, in the order it was typed", async () => {
    const { terminal, session, started } = startingTerminal("terminal:91");
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    act(() => { typeInto(fakeTerm(), "echo he"); typeInto(fakeTerm(), "llo\r"); });
    expect(terminal.input).not.toHaveBeenCalled();
    await started();
    expect(terminal.input).toHaveBeenCalledTimes(1);
    expect(terminal.input).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: session.terminalSessionId }), "echo hello\r");
    // What is typed from here on goes straight through.
    act(() => typeInto(fakeTerm(), "x"));
    expect(terminal.input).toHaveBeenLastCalledWith(expect.objectContaining({ terminalSessionId: session.terminalSessionId }), "x");
  });

  it("does not keep the terminal's own answers for a shell that never asked", async () => {
    const { terminal, started } = startingTerminal("terminal:92");
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    // An answer to a question in output drawn before the shell exists (a diagnostic, an earlier shell's output).
    act(() => fakeTerm().dataHandler?.("\x1b[1;1R"));
    await started();
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("says the input went nowhere when the shell does not start", async () => {
    const { terminal, failed } = startingTerminal("terminal:93");
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    act(() => typeInto(fakeTerm(), "make test\r"));
    await failed();
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputNotDelivered"));
    expect(terminal.input).not.toHaveBeenCalled();
  });

  it("says nothing when the shell does not start and nothing was typed", async () => {
    const { terminal, failed } = startingTerminal("terminal:94");
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    await failed();
    expect(screen.queryByTestId("terminal-input-notice")).toBeNull();
  });

  it("keeps what is typed while an ended shell restarts", async () => {
    const tabId = "terminal:95";
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const first = terminalSessionFixture(tabId, "manual", "first-shell");
    const second = terminalSessionFixture(tabId, "manual", "second-shell");
    terminal.spawn.mockResolvedValueOnce({ ok: true, tabId, replayed: false, session: first, blockMarkerToken: "view-token" });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId={tabId} tabLabel="Terminal" />);
    await waitFor(() => expect(terminal.control).toHaveBeenCalled());
    act(() => terminal.onExit.mock.calls.at(-1)?.[0]({ ...first, exitCode: 0 }));
    let reply: (result: unknown) => void = () => { throw new Error("no restart is waiting"); };
    terminal.spawn.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve as (result: unknown) => void; }) as never);
    // Enter on the ended terminal starts a new shell; the user keeps typing while it starts.
    act(() => typeInto(fakeTerm(), "\r"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    act(() => typeInto(fakeTerm(), "ls\r"));
    expect(terminal.input).not.toHaveBeenCalled();
    await act(async () => { reply({ ok: true, tabId, replayed: false, session: second, blockMarkerToken: "view-token" }); });
    await waitFor(() => expect(terminal.input).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: "second-shell" }), "ls\r"));
  });

  it("says the input went nowhere when the shell ends before it could take it, and does not give it to the next shell", async () => {
    const { terminal, session, started } = startingTerminal("terminal:96");
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    act(() => typeInto(fakeTerm(), "echo STALE\r"));
    // The shell ends while its start is still being answered: its exit arrives ahead of the reply.
    act(() => terminal.onExit.mock.calls.at(-1)?.[0]({ ...session, exitCode: 1 }));
    await started();
    expect(terminal.input).not.toHaveBeenCalled();
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputNotDelivered"));
    const replacement = terminalSessionFixture("terminal:96", "manual", "replacement-shell");
    terminal.spawn.mockResolvedValueOnce({ ok: true, tabId: "terminal:96", replayed: false, session: replacement, blockMarkerToken: "view-token" });
    act(() => typeInto(fakeTerm(), "\r"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(terminal.control).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: "replacement-shell" }), "get"));
    expect(terminal.input).not.toHaveBeenCalled();
    // What is typed for the new shell reaches it.
    act(() => typeInto(fakeTerm(), "x"));
    expect(terminal.input).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: "replacement-shell" }), "x");
    expect(terminal.input).toHaveBeenCalledTimes(1);
  });

  it("holds no more UTF-8 bytes than one write to a shell takes", async () => {
    const { terminal, session, started } = startingTerminal("terminal:97");
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    // Each piece is within a write on its own; together they are not, though they are far fewer characters than that.
    const piece = "가".repeat(200_000);
    act(() => { typeInto(fakeTerm(), piece); typeInto(fakeTerm(), piece); });
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputTooLarge"));
    await started();
    expect(terminal.input).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputTooLarge"));
    act(() => typeInto(fakeTerm(), "x"));
    expect(terminal.input).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: session.terminalSessionId }), "x");
  });

  it("holds input of exactly one write's bytes, and not a byte more", async () => {
    const limit = TERMINAL_INPUT_MAX_BYTES;
    const exact = `${"가".repeat(Math.floor(limit / 3))}${"a".repeat(limit % 3)}`;
    expect(new TextEncoder().encode(exact).length).toBe(limit);
    const whole = startingTerminal("terminal:98");
    await waitFor(() => expect(whole.terminal.spawn).toHaveBeenCalled());
    act(() => typeInto(fakeTerm(), exact));
    await whole.started();
    expect(whole.terminal.input).toHaveBeenCalledWith(expect.objectContaining({ terminalSessionId: whole.session.terminalSessionId }), exact);
    expect(screen.queryByTestId("terminal-input-notice")).toBeNull();
  });

  it("refuses to hold input one byte over a write", async () => {
    const limit = TERMINAL_INPUT_MAX_BYTES;
    const exact = `${"가".repeat(Math.floor(limit / 3))}${"a".repeat(limit % 3)}`;
    const over = startingTerminal("terminal:99");
    await waitFor(() => expect(over.terminal.spawn).toHaveBeenCalled());
    act(() => { typeInto(fakeTerm(), exact); typeInto(fakeTerm(), "b"); });
    expect(await screen.findByTestId("terminal-input-notice")).toHaveTextContent(t("ptyTerminal.inputTooLarge"));
    await over.started();
    expect(over.terminal.input).not.toHaveBeenCalled();
  });
});

describe("terminal links", () => {
  async function terminalWithLinks(onOpenLink?: (url: string) => void) {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId="terminal:61" tabLabel="Terminal" {...(onOpenLink ? { onOpenLink } : {})} />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
    return { detected: webLinks[0]!, osc8: fakeTerm().options.linkHandler! };
  }
  const click = (init: MouseEventInit = {}) => new MouseEvent("click", { clientX: 40, clientY: 30, ...init });

  it("opens a detected URL and an OSC 8 link the same way, on a modifier-click only", async () => {
    const open = vi.fn();
    const { detected, osc8 } = await terminalWithLinks(open);
    // A plain click selects or places the cursor; it never navigates.
    detected.activate(click(), "https://example.test/docs");
    osc8.activate(click(), "https://example.test/osc");
    expect(open).not.toHaveBeenCalled();
    // The test platform is not macOS: Ctrl is the modifier, Cmd is not.
    detected.activate(click({ metaKey: true }), "https://example.test/docs");
    expect(open).not.toHaveBeenCalled();
    detected.activate(click({ ctrlKey: true }), "https://example.test/docs");
    osc8.activate(click({ ctrlKey: true }), "https://example.test/osc");
    expect(open.mock.calls).toEqual([["https://example.test/docs"], ["https://example.test/osc"]]);
  });

  it("opens http and https only, and never a URL carrying credentials", async () => {
    const open = vi.fn();
    const { detected, osc8 } = await terminalWithLinks(open);
    expect(osc8.allowNonHttpProtocols).toBe(false);
    for (const target of ["file:///etc/passwd", "javascript:alert(1)", "ave://settings", "https://user:secret@example.test/", "not a url"]) {
      detected.activate(click({ ctrlKey: true }), target);
      osc8.activate(click({ ctrlKey: true }), target);
    }
    expect(open).not.toHaveBeenCalled();
    osc8.activate(click({ ctrlKey: true }), "http://localhost:3000/");
    expect(open).toHaveBeenCalledExactlyOnceWith("http://localhost:3000/");
  });

  it("shows the real target and how it opens in the terminal's own tooltip, and removes it on leave", async () => {
    const { detected, osc8 } = await terminalWithLinks(vi.fn());
    // An OSC 8 link's visible text can claim any address: the tooltip names where it really goes.
    act(() => osc8.hover(click(), "https://tracker.example.test/redirect?to=evil"));
    const tip = screen.getByTestId("terminal-link-tooltip");
    expect(screen.getByTestId("terminal-xterm-host").contains(tip)).toBe(true);
    expect(tip).toHaveTextContent("https://tracker.example.test/redirect?to=evil");
    expect(tip).toHaveTextContent(t("ptyTerminal.linkOpenHint", { modifier: "Ctrl" }));
    act(() => osc8.leave(click(), "https://tracker.example.test/redirect?to=evil"));
    expect(screen.queryByTestId("terminal-link-tooltip")).toBeNull();
    act(() => detected.hover(click(), "file:///etc/passwd"));
    expect(screen.getByTestId("terminal-link-tooltip")).toHaveTextContent(t("ptyTerminal.linkBlocked"));
    expect(screen.getByTestId("terminal-link-tooltip").dataset.openable).toBe("false");
  });
});

describe("a link opens as a browser tab of the side panel", () => {
  it("adds an active browser tab at the link, and refuses what is not a web address", () => {
    const tabs = renderHook(() => useWorkspaceTabs());
    let id: string | null = null;
    act(() => { id = tabs.result.current.openBrowserTab("https://example.test/docs"); });
    expect(id).not.toBeNull();
    expect(tabs.result.current.activeTabId).toBe(id);
    expect(tabs.result.current.tabs.find((tab) => tab.id === id)).toMatchObject({ kind: "browser", mode: "pinned" });
    expect(tabs.result.current.browserUrlByTab[id!]).toBe("https://example.test/docs");
    act(() => { id = tabs.result.current.openBrowserTab("file:///etc/passwd"); });
    expect(id).toBeNull();
    expect(tabs.result.current.tabs).toHaveLength(1);
  });
});

describe("copy and paste keys off macOS", () => {
  const key = (name: string, modifiers: Partial<Pick<KeyboardEvent, "ctrlKey" | "shiftKey" | "altKey" | "metaKey">> = {}, type = "keydown") =>
    ({ type, key: name, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...modifiers });

  it("binds Windows Ctrl+C to copy only with a selection, and Ctrl+V to paste", () => {
    expect(terminalClipboardAction(key("c", { ctrlKey: true }), "win32", true)).toBe("copy");
    // Without a selection Ctrl+C is the shell's interrupt.
    expect(terminalClipboardAction(key("c", { ctrlKey: true }), "win32", false)).toBeNull();
    expect(terminalClipboardAction(key("v", { ctrlKey: true }), "win32", false)).toBe("paste");
    expect(terminalClipboardAction(key("C", { ctrlKey: true, shiftKey: true }), "win32", true)).toBe("copy");
    expect(terminalClipboardAction(key("V", { ctrlKey: true, shiftKey: true }), "win32", false)).toBe("paste");
    expect(terminalClipboardAction(key("v", { ctrlKey: true }, "keyup"), "win32", false)).toBeNull();
    expect(terminalClipboardAction(key("v", { ctrlKey: true, altKey: true }), "win32", false)).toBeNull();
  });

  it("binds Linux Ctrl+Shift+C / Ctrl+Shift+V and Shift+Insert, leaving Ctrl+C and Ctrl+V to the shell", () => {
    expect(terminalClipboardAction(key("C", { ctrlKey: true, shiftKey: true }), "linux", true)).toBe("copy");
    expect(terminalClipboardAction(key("C", { ctrlKey: true, shiftKey: true }), "linux", false)).toBeNull();
    expect(terminalClipboardAction(key("V", { ctrlKey: true, shiftKey: true }), "linux", false)).toBe("paste");
    expect(terminalClipboardAction(key("Insert", { shiftKey: true }), "linux", false)).toBe("paste");
    expect(terminalClipboardAction(key("c", { ctrlKey: true }), "linux", true)).toBeNull();
    expect(terminalClipboardAction(key("v", { ctrlKey: true }), "linux", false)).toBeNull();
    expect(terminalClipboardAction(key("Insert", { shiftKey: true }), "win32", false)).toBeNull();
  });

  it("binds nothing on macOS, where the Edit menu owns Cmd+C and Cmd+V", () => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }]) {
      expect(terminalClipboardAction(key("c", modifiers), "darwin", true)).toBeNull();
      expect(terminalClipboardAction(key("v", modifiers), "darwin", true)).toBeNull();
    }
  });

  it("copies the selection and clears it, pastes through xterm, and keeps the key from the shell", async () => {
    const writeText = vi.fn(async () => {});
    const readText = vi.fn(async () => "pasted text");
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", clipboard: { writeText, readText } });
    try {
      const { api } = makeMockAveApi();
      const terminal = terminalApi();
      render(<PtyTerminalView api={{ ...api, terminal } as never} location="pane:a" tabId="terminal:71" tabLabel="Terminal" />);
      await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(1));
      const xterm = fakeTerm();
      const press = (name: string) => {
        const event = new KeyboardEvent("keydown", { key: name, ctrlKey: true, cancelable: true });
        return { handled: offerKey(xterm, event), event };
      };
      // No selection: Ctrl+C stays the shell's.
      expect(press("c")).toMatchObject({ handled: true, event: { defaultPrevented: false } });
      expect(writeText).not.toHaveBeenCalled();
      xterm.selection = "selected output";
      expect(press("c")).toMatchObject({ handled: false, event: { defaultPrevented: true } });
      expect(writeText).toHaveBeenCalledExactlyOnceWith("selected output");
      expect(xterm.selection).toBe("");
      expect(press("v")).toMatchObject({ handled: false, event: { defaultPrevented: true } });
      await waitFor(() => expect(xterm.pasted).toEqual(["pasted text"]));
      // Nothing was written to the PTY by the key itself.
      expect(terminal.input).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
