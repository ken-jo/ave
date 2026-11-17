/**
 * Output drawn as history, against the real terminal emulator: its parser works through writes asynchronously and answers the queries it meets,
 * which no stand-in does. The shell side is a recording double.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { LiveTerminal, type LiveTerminalStyle } from "../live-terminal.js";
import { DEFAULT_TERMINAL_BEHAVIOR } from "../../../../shared/appearance-settings.js";
import { resetMainLayoutRestoreForTest, stageRestoredLayout } from "../../preview/main-layout-restore.js";
import { terminalSessionFixture } from "../../../../__tests__/support/terminal-session-fixtures.js";
import type { TerminalDataEvent, TerminalExitEvent, TerminalSpawnResult } from "../../../../shared/terminal-session.js";
import { keptTerminalOutput } from "../terminal-serialize.js";

const STYLE: LiveTerminalStyle = { terminalPalette: {}, terminalFont: { family: "monospace", size: 12, lineHeight: 1.2 }, behavior: DEFAULT_TERMINAL_BEHAVIOR };
/** The emulator's answer to "where is the cursor". */
const isCursorReport = (sent: string | undefined): boolean => sent?.startsWith("\x1b[") === true && /^\d+;\d+R$/u.test(sent.slice(2));

function shellSide(tabId: string) {
  const session = terminalSessionFixture(tabId, "manual", "running-shell");
  let onData: (event: TerminalDataEvent) => void = () => { throw new Error("the terminal is not listening for output"); };
  let onExit: (event: TerminalExitEvent) => void = () => { throw new Error("the terminal is not listening for exits"); };
  let reply: (result: TerminalSpawnResult) => void = () => { throw new Error("no shell start is waiting"); };
  const input = vi.fn(async (_ref: unknown, _data: string) => ({ ok: true as const }));
  const api = {
    spawn: vi.fn(() => new Promise<TerminalSpawnResult>((resolve) => { reply = resolve; })),
    input,
    resize: vi.fn(async () => ({ ok: true as const })),
    keep: vi.fn(async (_tabId: string, _shown: string | null) => ({ ok: true as const })),
    control: vi.fn(async () => ({ ok: false as const, error: "not-needed" })),
    onData: (listener: typeof onData) => { onData = listener; return () => {}; },
    onExit: (listener: typeof onExit) => { onExit = listener; return () => {}; },
    onControl: () => () => {},
  };
  return {
    api, session, input,
    reply: (result: TerminalSpawnResult) => reply(result),
    output: (chunk: string, from = session) => onData({ ...from, chunk }),
    exit: () => onExit({ ...session, exitCode: 0 }),
    sent: () => input.mock.calls.map(([, data]) => data),
  };
}

async function mounted(tabId: string, openLink?: (url: string) => void) {
  const shell = shellSide(tabId);
  const live = new LiveTerminal(shell.api as never, tabId, STYLE, ((key: string) => key) as never);
  const host = document.createElement("div");
  document.body.appendChild(host);
  live.attach(host, { purpose: "workspace", initialCwd: null, t: ((key: string) => key) as never, attended: () => true, ...(openLink ? { openLink } : {}) });
  await vi.waitFor(() => expect(shell.api.spawn).toHaveBeenCalled());
  const term = (live as unknown as { term: Terminal }).term;
  /** Everything written so far has been parsed. */
  const drawn = (): Promise<void> => new Promise((resolve) => term.write("", resolve));
  const screen = (): string => {
    const lines: string[] = [];
    for (let row = 0; row < term.buffer.active.length; row++) lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? "");
    return lines.join("\n");
  };
  return { ...shell, live, term, drawn, screen, dispose: () => { live.dispose(); host.remove(); } };
}

// The emulator watches the display's pixel ratio through a media query and the view watches its host's size; this DOM implements neither,
// and nothing here depends on a size.
beforeAll(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterAll(() => { vi.unstubAllGlobals(); });

/** What a tab whose terminal drew `output` at this size keeps. */
function keptOf(output: string, cols: number, rows: number): Promise<string> {
  const source = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  return new Promise((resolve) => source.write(output, () => {
    resolve(keptTerminalOutput(source));
    source.dispose();
  }));
}

/** The text `output` draws in a terminal of this size, its nonblank lines. */
function linesOf(output: string, cols: number, rows: number): Promise<string[]> {
  const target = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  return new Promise((resolve) => target.write(output, () => {
    const buffer = target.buffer.normal;
    resolve(Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "").filter((line) => line.trim() !== ""));
    target.dispose();
  }));
}

/** Let the code waiting on the spawn reply run, without giving the emulator a turn to parse what it was handed. */
async function replyTaken(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
}

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  resetMainLayoutRestoreForTest();
  document.body.replaceChildren();
});

describe("output drawn as history", () => {
  it("answers none of the queries in a reloaded view's replay, and answers the running shell's next one", async () => {
    const terminal = await mounted("terminal:0000aaaa-1");
    disposers.push(terminal.dispose);
    // The shell has been running; this view is new. Its output so far holds a query a program asked a while ago.
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: true, session: terminal.session, blockMarkerToken: "view-token", scrollback: "OLD\x1b[6n\r\n" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    await terminal.drawn();
    expect(terminal.screen()).toContain("OLD");
    expect(terminal.sent()).toEqual([]);
    terminal.output("\x1b[6n");
    await terminal.drawn();
    expect(terminal.sent()).toHaveLength(1);
    expect(isCursorReport(terminal.sent()[0])).toBe(true);
  });

  it("loses nothing the new shell prints while a restored tab's old output is still being drawn, and hears its exit", async () => {
    const tabId = "terminal:0000bbbb-1";
    stageRestoredLayout({ sideTabs: {}, terminals: [{ kind: "terminal", tabId, ordinal: 1, cwd: null, url: null }] });
    const terminal = await mounted(tabId);
    disposers.push(terminal.dispose);
    // Enough old output that the emulator takes more than one turn to draw it.
    const old = Array.from({ length: 20_000 }, (_, row) => `old-row-${row}\x1b[6n`).join("\r\n");
    terminal.reply({ ok: true, tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token", scrollback: `${old}\r\n` });
    // The reply has been taken, and the old output is not drawn to its end yet, when the shell's first bytes and then its end arrive.
    await replyTaken();
    expect(terminal.live.getState().session).not.toBeNull();
    expect(terminal.screen()).not.toContain("old-row-19999");
    terminal.output("NEW-SHELL-WELCOME\r\n");
    terminal.exit();
    await terminal.drawn();
    const screen = terminal.screen();
    const at = ["old-row-19999", "ptyTerminal.restored", "NEW-SHELL-WELCOME"].map((text) => screen.indexOf(text));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(terminal.live.getState().ended).toEqual({ kind: "exited", code: 0 });
  });

  it("delivers what the user types while old output is being drawn", async () => {
    const terminal = await mounted("terminal:0000cccc-1");
    disposers.push(terminal.dispose);
    const old = Array.from({ length: 20_000 }, (_, row) => `old-row-${row}\x1b[6n`).join("\r\n");
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: true, session: terminal.session, blockMarkerToken: "view-token", scrollback: old });
    await replyTaken();
    expect(terminal.live.getState().session).not.toBeNull();
    expect(terminal.screen()).not.toContain("old-row-19999");
    terminal.term.input("ls\r", true);
    await terminal.drawn();
    expect(terminal.sent()).toEqual(["ls\r"]);
  });

  it("cannot be told by a program's output that what follows is history", async () => {
    const terminal = await mounted("terminal:0000dddd-1");
    disposers.push(terminal.dispose);
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    terminal.output("\x1b]7373;00000000-0000-4000-8000-000000000000;begin\x07\x1b]7373;begin\x07\x1b[6n");
    await terminal.drawn();
    expect(terminal.sent()).toHaveLength(1);
    expect(isCursorReport(terminal.sent()[0])).toBe(true);
  });
});

describe("a tab's kept output", () => {
  it("draws in the view what the tab showed, and none of a control string's payload", async () => {
    const tabId = "terminal:0000dddd-1";
    stageRestoredLayout({ sideTabs: {}, terminals: [{ kind: "terminal", tabId, ordinal: 1, cwd: null, url: null }] });
    const terminal = await mounted(tabId);
    disposers.push(terminal.dispose);
    // As the shell printed it: a DCS whose payload spans a line, one behind an ignored byte-order mark, then a hyperlink and text in several scripts.
    const source = "\x1bPq\nDCS-PAYLOAD\x1b\\VISIBLE\r\n\x1b\ufeffPq\nBOM-PAYLOAD\x1b\\SHOWN\r\n\x1b]8;;https://example.test/\x07LINK\x1b]8;;\x07 한국어 😀\r\n";
    const kept = await keptOf(source, terminal.term.cols, terminal.term.rows);
    terminal.reply({ ok: true, tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token", scrollback: kept });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    await terminal.drawn();
    const screen = terminal.screen();
    expect(screen).toContain("VISIBLE");
    expect(screen).toContain("SHOWN");
    expect(screen).toContain("LINK 한국어 😀");
    expect(screen).not.toContain("PAYLOAD");
  });
});

describe("what a host tab's view keeps for a restart", () => {
  /** What the view sent to be kept, each time. */
  const keptBy = (api: { keep: { mock: { calls: Array<[string, string | null]> } } }) => api.keep.mock.calls.map(([, shown]) => shown);
  const leave = (): void => { window.dispatchEvent(new Event("pagehide")); };

  it("keeps its own screen as the window's document goes, at the size it shows it now, after the output it drew before and after a resize", async () => {
    const terminal = await mounted("terminal:0000eeee-1");
    disposers.push(terminal.dispose);
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    terminal.output("ABCDEFGHIJ\r123\r\n");
    await terminal.drawn();
    terminal.term.resize(5, terminal.term.rows);
    terminal.output("after\r\n");
    await terminal.drawn();
    leave();
    const shown = keptBy(terminal.api).at(-1);
    if (typeof shown !== "string") throw new Error("nothing was kept");
    expect(await linesOf(shown, 5, terminal.term.rows)).toEqual(terminal.screen().split("\n").filter((line) => line.trim() !== ""));
  });

  it("keeps a cleared screen cleared at once, the output still being parsed included, and an ended shell's last line cleared with it", async () => {
    const terminal = await mounted("terminal:0000eeee-2");
    disposers.push(terminal.dispose);
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    // Printed without a newline, then the shell ended: the exit is kept as the view shows it, and so is the screen the user clears after it.
    terminal.output("SECRET");
    terminal.exit();
    await terminal.drawn();
    expect(keptBy(terminal.api).at(-1)).toContain("SECRET");
    terminal.live.clear();
    await terminal.drawn();
    expect(keptBy(terminal.api).at(-1)).toBe("");
    // With output still being parsed when the user clears, what is kept is what the view shows once it is drawn.
    const busy = await mounted("terminal:0000eeee-5");
    disposers.push(busy.dispose);
    busy.reply({ ok: true, tabId: busy.session.tabId, replayed: false, session: busy.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(busy.api.control).toHaveBeenCalled());
    busy.output(`${Array.from({ length: 20_000 }, (_, row) => `row-${row}`).join("\r\n")}\r\n`);
    busy.live.clear();
    await busy.drawn();
    const shown = keptBy(busy.api).at(-1);
    if (typeof shown !== "string") throw new Error("nothing was kept");
    expect(await linesOf(shown, busy.term.cols, busy.term.rows)).toEqual(busy.screen().split("\n").filter((line) => line.trim() !== ""));
  });

  it("keeps the next shell's output after a shell that ended inside an unfinished control string", async () => {
    const terminal = await mounted("terminal:0000eeee-6");
    disposers.push(terminal.dispose);
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    terminal.output("\x1bPq unfinished payload");
    terminal.exit();
    await terminal.drawn();
    terminal.live.restart();
    await vi.waitFor(() => expect(terminal.api.spawn).toHaveBeenCalledTimes(2));
    const next = terminalSessionFixture(terminal.session.tabId, "manual", "next-shell");
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: next, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.live.getState().session).toEqual(next));
    terminal.output("NEW-SHELL-PROMPT>", next);
    await terminal.drawn();
    leave();
    const shown = keptBy(terminal.api).at(-1);
    if (typeof shown !== "string") throw new Error("nothing was kept");
    expect((await linesOf(shown, terminal.term.cols, terminal.term.rows)).at(-1)).toContain("NEW-SHELL-PROMPT>");
    expect(shown).not.toContain("unfinished payload");
  });

  it("keeps nothing before the output its tab came back with is drawn, so what was kept stays", async () => {
    const tabId = "terminal:0000eeee-7";
    stageRestoredLayout({ sideTabs: {}, terminals: [{ kind: "terminal", tabId, ordinal: 1, cwd: null, url: null }] });
    const terminal = await mounted(tabId);
    disposers.push(terminal.dispose);
    // The window goes while the shell is still starting.
    leave();
    expect(terminal.api.keep).not.toHaveBeenCalled();
    const old = Array.from({ length: 20_000 }, (_, row) => `old-row-${row}`).join("\r\n");
    terminal.reply({ ok: true, tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token", scrollback: `${old}\r\n` });
    // Or while that output is still being drawn.
    await replyTaken();
    expect(terminal.screen()).not.toContain("old-row-19999");
    leave();
    expect(terminal.api.keep).not.toHaveBeenCalled();
    await terminal.drawn();
    leave();
    expect(keptBy(terminal.api).at(-1)).toContain("old-row-19999");
  });

  it("says it could not keep what it shows when its terminal cannot be serialized, and keeps it in no other form", async () => {
    const terminal = await mounted("terminal:0000eeee-8");
    disposers.push(terminal.dispose);
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    terminal.output("shown\r\n");
    await terminal.drawn();
    const registry = (terminal.term as unknown as { _core: { _oscLinkService: { getLinkData?: unknown } } })._core._oscLinkService;
    const { getLinkData } = registry;
    registry.getLinkData = undefined;
    try {
      leave();
    } finally {
      registry.getLinkData = getLinkData;
    }
    expect(terminal.api.keep.mock.calls.at(-1)).toEqual([terminal.session.tabId, null]);
  });

  it("keeps nothing once its tab is closed", async () => {
    const terminal = await mounted("terminal:0000eeee-9");
    terminal.reply({ ok: true, tabId: terminal.session.tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token" });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    terminal.dispose();
    leave();
    expect(terminal.api.keep).not.toHaveBeenCalled();
  });

  it("draws a kept tab back with the notice and the new shell below every kept row, wherever the cursor was left", async () => {
    const tabId = "terminal:0000eeee-3";
    stageRestoredLayout({ sideTabs: {}, terminals: [{ kind: "terminal", tabId, ordinal: 1, cwd: null, url: null }] });
    const terminal = await mounted(tabId);
    disposers.push(terminal.dispose);
    const kept = await keptOf("TOP\r\nMIDDLE\r\nBOTTOM\r\n\x1b[3A", terminal.term.cols, terminal.term.rows);
    terminal.reply({ ok: true, tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token", scrollback: kept });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    terminal.output("NEW-SHELL-PROMPT>");
    await terminal.drawn();
    const lines = terminal.screen().split("\n").map((line) => line.trim()).filter((line) => line !== "");
    expect(lines).toEqual(["TOP", "MIDDLE", "BOTTOM", "ptyTerminal.restored", "NEW-SHELL-PROMPT>"]);
  });

  it("opens a kept hyperlink at its own target, not its text, the way any terminal link opens", async () => {
    const tabId = "terminal:0000eeee-4";
    stageRestoredLayout({ sideTabs: {}, terminals: [{ kind: "terminal", tabId, ordinal: 1, cwd: null, url: null }] });
    const openLink = vi.fn();
    const terminal = await mounted(tabId, openLink);
    disposers.push(terminal.dispose);
    const kept = await keptOf("\x1b]8;;https://example.test/real-target\x07LABEL\x1b]8;;\x07\r\n\x1b]8;;file:///etc/passwd\x07LOCAL\x1b]8;;\x07\r\n", terminal.term.cols, terminal.term.rows);
    terminal.reply({ ok: true, tabId, replayed: false, session: terminal.session, blockMarkerToken: "view-token", scrollback: kept });
    await vi.waitFor(() => expect(terminal.api.control).toHaveBeenCalled());
    await terminal.drawn();
    // The target of the restored cell, as the emulator's link provider reads it when the text is clicked.
    const core = (terminal.term as unknown as { _core: { _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } } })._core;
    const targetAt = (row: number): string | undefined => {
      const buffer = terminal.term.buffer.active;
      const line = buffer.getLine([...Array(buffer.length).keys()].filter((index) => (buffer.getLine(index)?.translateToString(true) ?? "") !== "")[row] ?? -1);
      const cell = line?.getCell(0) as unknown as { hasExtendedAttrs(): number; extended: { urlId: number } } | undefined;
      return cell?.hasExtendedAttrs() ? core._oscLinkService.getLinkData(cell.extended.urlId)?.uri : undefined;
    };
    expect(targetAt(0)).toBe("https://example.test/real-target");
    expect(targetAt(1)).toBe("file:///etc/passwd");
    const activate = terminal.term.options.linkHandler?.activate;
    if (!activate) throw new Error("the terminal has no link handler");
    const click = new MouseEvent("click", { ctrlKey: true, metaKey: true });
    activate(click, targetAt(0) ?? "", { start: { x: 1, y: 1 }, end: { x: 5, y: 1 } });
    activate(click, targetAt(1) ?? "", { start: { x: 1, y: 2 }, end: { x: 5, y: 2 } });
    // Only an http or https target opens, in an Ave tab.
    expect(openLink.mock.calls).toEqual([["https://example.test/real-target"]]);
  });
});
