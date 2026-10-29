// @vitest-environment jsdom
/** Retint the existing terminal from root theme values; recreating it would discard screen and scrollback. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render as renderUnwrapped, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import type { TerminalSessionInfo, TerminalSpawnRequest, TerminalDataEvent, TerminalExitEvent } from "../../../../shared/terminal-session.js";
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
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { setInstalledThemeBundles } from "../../theme/bundles/index.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../../installed-content.js";
import { installedTheme, installedThemeContent, NO_LANGUAGE_BRIDGE } from "../../../../../test/renderer/installed-theme.js";

/** The app renders every terminal under its root TooltipProvider; the terminal's header chip needs one. */
const render = (ui: ReactElement) => renderUnwrapped(ui, { wrapper: TooltipProvider });

interface FakeMarker { line: number; isDisposed: boolean; onDispose: () => { dispose(): void }; dispose(): void }
interface FakeTerminal {
  options: { theme?: unknown };
  commandRow: string;
  oscHandlers: Map<number, (data: string) => boolean>;
  dataHandler: ((data: string) => void) | null;
  written: string[];
  cursorLine: number;
  focusCount: number;
  markers: { offset: number; marker: FakeMarker }[];
  decorations: { options: { marker: FakeMarker; x?: number; width?: number; height?: number }; element: HTMLElement }[];
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
    buffer = { active: { getLine: (_line: number) => {
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
    loadAddon() {}
    open(host: HTMLElement) { this.host = host; }
    onData(handler: (data: string) => void) {
      this.dataHandler = handler;
      return { dispose: () => { this.dataHandler = null; } };
    }
    written: string[] = [];
    write(text: string) {
      this.written.push(text);
    }
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => {
  terminals.length = 0;
  resetInstalledContentForTests();
  setInstalledThemeBundles([]);
});

function terminalApi() {
  return {
    spawn: vi.fn(async (payload: TerminalSpawnRequest) => ({ ok: true as const, tabId: payload.tabId, replayed: false, session: { ...terminalSessionFixture(payload.tabId, payload.lane), initialCwd: payload.cwd ?? "/workspace" }, blockMarkerToken: "view-token" })),
    input: vi.fn(async () => ({ ok: true as const })),
    resize: vi.fn(async () => ({ ok: true as const })),
    kill: vi.fn(async () => ({ ok: true as const })),
    onData: vi.fn((_handler: (event: TerminalDataEvent) => void) => () => {}),
    onExit: vi.fn((_handler: (event: TerminalExitEvent) => void) => () => {}),
    listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot: { cwd: "/", latestBlockId: null, files: [], warnings: [] } })),
    listBlocks: vi.fn(async (session: TerminalSessionInfo) => ({ ok: true as const, session, integrated: session.shellIntegration, blocks: [] as unknown[] })),
    getBlock: vi.fn(async (_session: TerminalSessionInfo, _id: number) => ({ ok: false as const, error: "block-not-found" })),
  };
}

describe("PtyTerminalView theme", () => {
  it("re-tints the live terminal in place when the shown theme is updated (same id)", async () => {
    const harbor = installedTheme("harbor", "dark", { background: "210 40% 12%", foreground: "0 0% 100%" });
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: "harbor" } } });
    const ave = { ...api, terminal: terminalApi() };
    act(() => { applyInstalledContent(installedThemeContent([harbor]), NO_LANGUAGE_BRIDGE); });

    render(
      <ThemeProvider api={api as never} initialBundleId="harbor">
        <PtyTerminalView api={ave as never} location="side-panel" tabId="tab-1" tabLabel="Terminal 1" />
      </ThemeProvider>,
    );
    await waitFor(() => expect(terminals).toHaveLength(1));
    await waitFor(() => expect(terminals[0]!.options.theme).toEqual({ background: "hsl(210 40% 12%)", foreground: "hsl(0 0% 100%)" }));

    await act(async () => {
      applyInstalledContent(installedThemeContent([{ ...harbor, tokens: { ...harbor.tokens, background: "210 40% 18%" } }]), NO_LANGUAGE_BRIDGE);
    });

    await waitFor(() => expect(terminals[0]!.options.theme).toEqual({ background: "hsl(210 40% 18%)", foreground: "hsl(0 0% 100%)" }));
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
    const handler = terminals[0]!.oscHandlers.get(133)!;
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
    // Both read "Terminal 1" to the user, but main keys PTYs by id window-wide.
    expect(tabA.ordinal).toBe(1);
    expect(tabB.ordinal).toBe(1);
    expect(tabA.id).not.toBe(tabB.id);

    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const ave = { ...api, terminal };
    render(
      <>
        <PtyTerminalView api={ave as never} location="pane:a" tabId={tabA.id} tabLabel="Terminal 1" />
        <PtyTerminalView api={ave as never} location="pane:b" tabId={tabB.id} tabLabel="Terminal 1" />
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
    await waitFor(() => expect(terminals[0]!.written.join("")).toContain(t("ptyTerminal.manualUnavailable")));
    expect(terminal.spawn).toHaveBeenCalledTimes(1);
  });

  it("identifies a retiring shell and starts nowhere else", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.spawn.mockResolvedValueOnce({ ok: false, reason: "still-closing", message: "still closing" } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:13" tabLabel="Terminal 13" initialCwd="/repo/app" />);
    await waitFor(() => expect(terminals[0]!.written.join("")).toContain(t("ptyTerminal.stillClosing")));
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
    await waitFor(() => expect(terminals[0]!.written.join("")).toBe("MANUAL"));
    act(() => terminal.onData.mock.calls.at(-1)![0]({ ...manual, terminalSessionId: "old-manual", chunk: "LATE" }));
    expect(terminals[0]!.written.join("")).toBe("MANUAL");
    act(() => terminals[0]!.dataHandler!("user"));
    expect(terminal.input).toHaveBeenCalledWith(manual, "user");
  });

  it("explains unavailable integration without blocking the native host shell", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    const session = { ...terminalSessionFixture("terminal:16", "manual"), shellIntegration: false, integrationUnavailableReason: "unsupported-shell" as const };
    terminal.spawn.mockResolvedValue({ ok: true, tabId: session.tabId, replayed: false, session, blockMarkerToken: "view-token" });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId={session.tabId} tabLabel="Terminal 16" />);
    expect(await screen.findByTestId("terminal-integration-unavailable")).toHaveTextContent(t("ptyTerminal.integrationUnsupportedShell"));
    act(() => terminals[0]!.dataHandler!("user-command\r"));
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
    expect(chip.textContent).toBe(t("ptyTerminal.hostChipAgentless"));
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
    const term = terminals[0]!;
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    await act(async () => {});
    // Main forwards an authenticated C with its block id and this incarnation's view token while the cursor sits just
    // below the entered command. Copies without the token, as a program could print, are ignored.
    act(() => {
      term.oscHandlers.get(133)!("C;ave-block=1;ave-view=forged");
      term.oscHandlers.get(133)!("C;ave-block=1");
      term.oscHandlers.get(133)!("C;ave-block=1;ave-view=view-token");
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
    const term = terminals[0]!;
    term.commandRow = `~/demo ❯ make build ${"VERBOSE=1 ".repeat(4)}`.trimEnd();
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalled());
    await act(async () => {});
    act(() => { term.oscHandlers.get(133)!("C;ave-block=1;ave-view=view-token"); });
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
      for (const data of ["C", "C;ave-block=x;ave-view=view-token", "C;ave-block=3", "C;ave-block=3;ave-view=other"]) terminals[0]!.oscHandlers.get(133)!(data);
    });
    expect(terminals[0]!.markers).toEqual([]);
  });
});

describe("PtyTerminalView keyboard focus", () => {
  it("focuses the terminal when it opens attended, so keystrokes reach the shell without a click", async () => {
    const { api } = makeMockAveApi();
    render(<PtyTerminalView api={{ ...api, terminal: terminalApi() } as never} location="side-panel" tabId="terminal:focus" tabLabel="Terminal 1" />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    expect(terminals[0]!.focusCount).toBe(1);
  });

  it("focuses when its pane becomes attended, and not while unattended", async () => {
    const { api } = makeMockAveApi();
    const ave = { ...api, terminal: terminalApi() };
    const view = render(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:pane" tabLabel="Terminal 1" attended={false} />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    expect(terminals[0]!.focusCount).toBe(0);
    view.rerender(<PtyTerminalView api={ave as never} location="pane:a" tabId="terminal:pane" tabLabel="Terminal 1" attended />);
    expect(terminals[0]!.focusCount).toBe(1);
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
      expect(terminals[0]!.focusCount).toBe(0);
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
      expect(terminals[0]!.focusCount).toBe(0);
      expect(document.activeElement).toBe(allow);
    } finally { card.remove(); }
  });

  it("takes focus from the tab the user selected to show it, and from its own controls", async () => {
    const { api } = makeMockAveApi();
    const ave = { ...api, terminal: terminalApi() };
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "true");
    document.body.appendChild(tab);
    tab.focus();
    try {
      const view = render(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended={false} />);
      await waitFor(() => expect(terminals).toHaveLength(1));
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended />);
      expect(terminals[0]!.focusCount).toBe(1);
      tab.setAttribute("aria-selected", "false");
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended={false} />);
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended />);
      expect(terminals[0]!.focusCount).toBe(1);
      const own = view.getByTestId("terminal-pane-header");
      own.tabIndex = -1;
      own.focus();
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended={false} />);
      view.rerender(<PtyTerminalView api={ave as never} location="side-panel" tabId="terminal:tab" tabLabel="Terminal 1" attended />);
      expect(terminals[0]!.focusCount).toBe(2);
    } finally { tab.remove(); }
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
    expect(terminals[0]!.focusCount).toBe(2);
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
