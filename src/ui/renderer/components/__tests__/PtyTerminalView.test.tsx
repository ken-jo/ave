// @vitest-environment jsdom
/** Retint the existing terminal from root theme values; recreating it would discard screen and scrollback. */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import type { TerminalSessionInfo, TerminalSpawnRequest, TerminalDataEvent, TerminalExitEvent } from "../../../../shared/terminal-session.js";
import { PtyTerminalView } from "../PtyTerminalView.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import { t } from "../../../../i18n/index.js";
import { terminalCwd } from "../../preview/main-layout-restore.js";
import { surfaceMountLocation } from "../../preview/surface-mounts.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import { setInstalledThemeBundles } from "../../theme/bundles/index.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../../installed-content.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { installedTheme, installedThemeContent, NO_LANGUAGE_BRIDGE } from "../../../../../test/renderer/installed-theme.js";

interface FakeTerminal {
  options: { theme?: unknown };
  oscHandlers: Map<number, (data: string) => boolean>;
  dataHandler: ((data: string) => void) | null;
  written: string[];
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
    loadAddon() {}
    open() {}
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
    spawn: vi.fn(async (payload: TerminalSpawnRequest) => ({ ok: true as const, tabId: payload.tabId, replayed: false, session: { ...terminalSessionFixture(payload.tabId, payload.lane), initialCwd: payload.cwd ?? "/workspace" } })),
    input: vi.fn(async () => ({ ok: true as const })),
    resize: vi.fn(async () => ({ ok: true as const })),
    kill: vi.fn(async () => ({ ok: true as const })),
    onData: vi.fn((_handler: (event: TerminalDataEvent) => void) => () => {}),
    onExit: vi.fn((_handler: (event: TerminalExitEvent) => void) => () => {}),
    listFileReviews: vi.fn(async () => ({ ok: true as const, snapshot: { cwd: "/", latestBlockId: null, files: [], warnings: [] } })),
    reviewFiles: vi.fn(async () => ({ ok: true as const })),
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
    expect(await screen.findByText(t("ptyTerminal.initialCwd", { cwd: "/repo/app" }))).toBeTruthy();
    expect(terminalCwd("terminal:11")).toBeNull();
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
      return { ok: true, tabId, replayed: true, session: manual };
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
    terminal.spawn.mockResolvedValue({ ok: true, tabId: session.tabId, replayed: false, session });
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
    expect(screen.getByTestId("terminal-host-badge").textContent).toBe(t("ptyTerminal.hostBadge"));
    expect(screen.queryAllByRole("button", { pressed: true })).toHaveLength(0);
    expect(terminals).toHaveLength(1);
    view.unmount();
    expect(terminal.kill).not.toHaveBeenCalled();
  });
});

describe("PtyTerminalView changed-file banner layout", () => {
  it("overlays the one-line banner on the output area without taking space from the xterm host", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.listFileReviews.mockResolvedValue({ ok: true as const, snapshot: {
      cwd: "/workspace",
      latestBlockId: 1,
      files: [{ path: "/workspace/Makefile", hash: "a".repeat(64), sessionIds: ["conversation"], reviewed: false, lastUsed: { command: "make build", when: 1_000 } }],
      warnings: [{ blockId: 1, command: "make build", files: ["/workspace/Makefile"] }],
    } } as never);
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:banner" tabLabel="Terminal 1" />);
    const banner = await screen.findByTestId("terminal-file-warning");
    const outputArea = screen.getByTestId("terminal-output-area");
    const xtermHost = screen.getByTestId("terminal-xterm-host");
    expect(banner.parentElement).toBe(outputArea);
    expect(outputArea).toHaveClass("relative", "flex-1");
    expect(banner).toHaveClass("absolute", "h-8");
    // The xterm host is the only in-flow child, so FitAddon measures the full output area with or without a banner.
    const inFlow = [...outputArea.children].filter((child) => !child.classList.contains("absolute"));
    expect(inFlow).toEqual([xtermHost]);
    expect(xtermHost).toHaveClass("flex-1");
    expect(screen.getByTestId("chat-side-panel-pty-terminal").lastElementChild).toBe(outputArea);
  });
});
