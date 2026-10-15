// @vitest-environment jsdom
/**
 * PtyTerminalView paints xterm with concrete colors read off :root (its canvas
 * cannot resolve CSS custom properties). Those colors must follow the applied
 * theme while the terminal lives: re-tinted in place through
 * `terminal.options.theme`, never by re-creating the terminal (which would
 * drop the shell's screen and scrollback).
 */
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PtyTerminalView } from "../PtyTerminalView.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
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
    spawn: vi.fn(async (_payload: { tabId: string; cwd?: string; cols?: number; rows?: number }) => ({ ok: true })),
    input: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listBlocks: vi.fn(async () => ({ ok: true as const, integrated: true, blocks: [] as unknown[] })),
    getBlock: vi.fn(async () => ({ ok: false as const, error: "block-not-found" })),
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
    // The same terminal, re-tinted: the shell and its scrollback are untouched.
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
    expect(terminal.listBlocks).toHaveBeenLastCalledWith("terminal:1");
  });

  it("attaches the latest block to chat as a fenced block naming the tab", async () => {
    const onAttachText = vi.fn(() => true);
    const terminal = renderView(onAttachText);
    fireEvent.click(await screen.findByTestId("terminal-blocks-attach-last"));
    await waitFor(() => expect(onAttachText).toHaveBeenCalledTimes(1));
    expect(terminal.getBlock).toHaveBeenCalledWith("terminal:1", 2);
    const text = (onAttachText.mock.calls[0] as unknown as [string])[0];
    expect(text).toContain("Terminal 1 · terminal:1 · #2");
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
    // Each chat group mounts its own tab store; both open their first terminal.
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

    // Moving the tab: the side-panel view unmounts and the pane view takes over.
    rerender(<>{view("pane:main")}</>);
    await waitFor(() => expect(surfaceMountLocation("terminal:7")).toBe("pane:main"));
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("pty-terminal-mounted-elsewhere")).toBeNull();
    expect(terminal.spawn).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: "terminal:7" }));

    rerender(<></>);
    expect(surfaceMountLocation("terminal:7")).toBeNull();
  });
});

describe("PtyTerminalView working directory", () => {
  const block = (id: number, cwd: string | null) => ({
    id, command: "ls", cwd, exitCode: 0, startedAt: 1_000, endedAt: 2_000,
    status: "done", source: "osc133", outputChars: 1, truncated: false,
  });

  it("starts a new shell at the given directory and reports the newest one the shell gave", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    // Newest first: the newest block with a directory is the one reported.
    terminal.listBlocks.mockResolvedValue({ ok: true, integrated: true, blocks: [block(3, null), block(2, "/repo/app"), block(1, "/repo")] });
    const onCwd = vi.fn();
    render(
      <PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:11" tabLabel="Terminal 11" initialCwd="/repo/app" onCwd={onCwd} />,
    );
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:11", cwd: "/repo/app" })));
    await waitFor(() => expect(onCwd).toHaveBeenCalledWith("/repo/app"));
    expect(onCwd).toHaveBeenCalledTimes(1);
  });

  it("starts at the workspace root, saying so, when the remembered directory is refused", async () => {
    const { api } = makeMockAveApi();
    const terminal = terminalApi();
    terminal.spawn
      .mockResolvedValueOnce({ ok: false, reason: "bad-request", message: "terminal cwd must be within the workspace root" } as never)
      .mockResolvedValueOnce({ ok: true });
    render(<PtyTerminalView api={{ ...api, terminal } as never} location="side-panel" tabId="terminal:12" tabLabel="Terminal 12" initialCwd="/elsewhere" />);
    await waitFor(() => expect(terminal.spawn).toHaveBeenCalledTimes(2));
    expect(terminal.spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ cwd: "/elsewhere" }));
    expect(terminal.spawn.mock.calls[1]![0]).not.toHaveProperty("cwd");
    expect(terminals[0]!.written.join("")).toContain("[starting in the workspace root: terminal cwd must be within the workspace root]");
    expect(terminals[0]!.written.join("")).not.toContain("[terminal unavailable]");
  });
});
