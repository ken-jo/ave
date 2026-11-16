/**
 * What a host tab keeps of its terminal for a restart, against the real terminal emulator: the screen it serializes draws back, in a terminal
 * of the same size, as the one it was taken from.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { TERMINAL_SCROLLBACK_RESET, keptTerminalOutput } from "../terminal-serialize.js";
import { TERMINAL_REPLAY_MAX_BYTES } from "../../../../shared/terminal-session.js";

const terminals: Terminal[] = [];
afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

/** A terminal as a tab's view sets one up: Unicode 11 widths, a scrollback this long. */
function terminal(cols = 80, rows = 24, scrollback = 1_000_000): Terminal {
  const created = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  created.loadAddon(new Unicode11Addon());
  created.unicode.activeVersion = "11";
  terminals.push(created);
  return created;
}

const written = (target: Terminal, output: string): Promise<void> => new Promise((resolve) => target.write(output, resolve));

/** The text a terminal shows, line by line, without trailing blank lines. */
function linesOf(target: Terminal): string[] {
  const buffer = target.buffer.normal;
  const lines = Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "");
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

async function screenOf(output: string, cols = 80, rows = 24): Promise<string[]> {
  const target = terminal(cols, rows);
  await written(target, output);
  return linesOf(target);
}

/** What is kept of a terminal that drew `output`, and the screen that draws back as against the screen the output drew. */
async function kept(output: string, cols = 80, rows = 24) {
  const source = terminal(cols, rows);
  await written(source, output);
  const snapshot = keptTerminalOutput(source);
  return { snapshot, restored: await screenOf(snapshot, cols, rows), original: linesOf(source) };
}

/** The emulator's hyperlink registry and a cell's link, read the way the emulator's own link provider reads them. */
function linkAt(target: Terminal, row: number, col: number): { id?: string; uri: string } | undefined {
  const registry = (target as unknown as { _core: { _oscLinkService: { getLinkData(id: number): { id?: string; uri: string } | undefined } } })._core._oscLinkService;
  const cell = target.buffer.normal.getLine(row)?.getCell(col) as unknown as { hasExtendedAttrs(): number; extended: { urlId: number } } | undefined;
  return cell?.hasExtendedAttrs() ? registry.getLinkData(cell.extended.urlId) : undefined;
}

describe("what a host tab keeps of its terminal", () => {
  it("draws back a DCS whose payload spans lines as the screen showed it: none of the payload", async () => {
    const { restored, original } = await kept("BEFORE\r\n\x1bPq\nDCS-PAYLOAD\x1b\\VISIBLE\r\nAFTER\r\n");
    expect(original).toEqual(["BEFORE", "VISIBLE", "AFTER"]);
    expect(restored).toEqual(original);
  });

  it("draws back a string introducer an ignored byte-order mark sits inside, without its payload", async () => {
    for (const introducer of ["P", "_", "]8;;"]) {
      const { restored, original } = await kept(`BEFORE\r\n\x1b﻿${introducer}q\nPAYLOAD\x1b\\VISIBLE\r\n`);
      expect(restored).toEqual(original);
      expect(restored.join("\n")).not.toContain("PAYLOAD");
    }
  });

  it("keeps text an escape with intermediates or a malformed sequence left on the screen", async () => {
    for (const output of ["BEFORE\r\n\x1b PAFTER\r\n", "BEFORE\r\n\x1b XAFTER\r\n", "BEFORE\r\n\x1b[é123\r\n", "BEFORE\r\n\x1bPéDCS\x1b\\AFTER\r\n"]) {
      const { restored, original } = await kept(output);
      expect(restored).toEqual(original);
    }
  });

  it("keeps a hyperlink's text, colours, wide characters and emoji where they were drawn", async () => {
    const { snapshot, restored, original } = await kept("\x1b]8;;https://example.test/\x07LINK\x1b]8;;\x07 \x1b[31m한국어\x1b[0m 😀 end\r\n", 20, 5);
    expect(original).toEqual(["LINK 한국어 😀 end"]);
    expect(restored).toEqual(original);
    expect(snapshot).toContain("\x1b[31m");
  });

  it("draws back as the terminal shows it after it was resized and cleared, whatever the output was drawn at", async () => {
    const source = terminal(10, 5);
    await written(source, "ABCDEFGHIJ\r123\r\n");
    source.resize(5, 5);
    await written(source, "after the resize\r\n");
    const resized = keptTerminalOutput(source);
    expect(await screenOf(resized, 5, 5)).toEqual(linesOf(source));
    source.clear();
    await written(source, "");
    expect(keptTerminalOutput(source)).toBe("");
  });

  it("leaves what follows it below every row it kept, wherever the cursor was", async () => {
    const source = terminal();
    // A program moved the cursor up over rows it had drawn before the app quit.
    await written(source, "TOP\r\nMIDDLE\r\nBOTTOM\r\n\x1b[3A");
    expect(await screenOf(`${keptTerminalOutput(source)}NOTICE\r\nPROMPT>`)).toEqual(["TOP", "MIDDLE", "BOTTOM", "NOTICE", "PROMPT>"]);
  });

  it("keeps a hyperlink's target with its text, and its id, though the text says something else", async () => {
    const source = terminal(40, 5);
    await written(source, "see \x1b]8;id=doc;https://example.test/real-target\x07LABEL\x1b]8;;\x07 and \x1b[4mplain\x1b[0m\r\n");
    const restored = terminal(40, 5);
    await written(restored, keptTerminalOutput(source));
    const line = restored.buffer.normal.getLine(0);
    expect(line?.translateToString(true)).toBe("see LABEL and plain");
    for (const col of [4, 8]) expect(linkAt(restored, 0, col)).toEqual({ id: "doc", uri: "https://example.test/real-target" });
    expect(linkAt(restored, 0, 3)).toBeUndefined();
    expect(linkAt(restored, 0, 9)).toBeUndefined();
    // The plain text's own underline is kept; the link's text is not given one of its own on top of the link's.
    expect(line?.getCell(14)?.isUnderline()).toBeTruthy();
    const linkCell = line?.getCell(4) as unknown as { fg: number } | undefined;
    if (!linkCell) throw new Error("no cell under the link");
    expect(linkCell.fg & 0x10000000).toBe(0);
  });

  it("keeps none of the control strings that would act again in a later run", async () => {
    const { snapshot, restored } = await kept("\x1b]0;window title\x07one\r\n\x1b]133;C\x07\x1b]9;build done\x07\x1b]7;file://host/tmp\x1b\\two\r\n");
    expect(restored).toEqual(["one", "two"]);
    for (const acting of ["\x1b]0;", "\x1b]133;", "\x1b]9;", "\x1b]7;"]) expect(snapshot).not.toContain(acting);
    // Whatever full-screen program was running, the new shell starts on the normal screen with the pointer and paste modes off; not with the
    // variant that also moves the cursor to a saved position, so the new shell starts below the old output, not over it.
    expect(snapshot.endsWith(TERMINAL_SCROLLBACK_RESET)).toBe(true);
    expect(TERMINAL_SCROLLBACK_RESET).toContain("\x1b[?1047l");
    expect(TERMINAL_SCROLLBACK_RESET).not.toContain("\x1b[?1049l");
    expect(TERMINAL_SCROLLBACK_RESET).toContain("\x1b[?1000l");
    expect(TERMINAL_SCROLLBACK_RESET).toContain("\x1b[?2004l");
  });

  it("keeps the newest whole lines of a tab that showed more than a replay holds, within the replay", async () => {
    const lines = Array.from({ length: 40_000 }, (_, row) => `${row} 한국어 😀 ${"가".repeat(10)}`);
    const { snapshot, restored, original } = await kept(`${lines.join("\r\n")}\r\n`);
    expect(Buffer.byteLength(original.join("\n"), "utf-8")).toBeGreaterThan(TERMINAL_REPLAY_MAX_BYTES);
    expect(Buffer.byteLength(snapshot, "utf-8")).toBeLessThanOrEqual(TERMINAL_REPLAY_MAX_BYTES);
    expect(restored.length).toBeGreaterThan(1000);
    expect(restored.length).toBeLessThan(original.length);
    expect(restored).toEqual(original.slice(-restored.length));
  });

  it("keeps the newest rows of a wide, densely coloured tab at the longest scrollback, with work that does not grow with the scrollback", async () => {
    const cols = 320;
    /** A row with a colour of its own in every cell: some 20 bytes a cell, so a few hundred rows fill a replay. */
    const dense = (row: number): string => {
      let text = "";
      for (let col = 0; col < cols; col++) text += `\x1b[38;2;${(row + col) % 256};${col % 256};${row % 256}m${String.fromCharCode(65 + ((row + col) % 26))}`;
      return `${text}\x1b[0m\r\n`;
    };
    const keptOfRows = async (count: number) => {
      const source = terminal(cols, 50, 100_000);
      let output = "";
      for (let row = 0; row < count; row++) output += dense(row);
      await written(source, output);
      // How much of the buffer the serialization reads: every attempt reads rows through this.
      const buffer = source.buffer.normal;
      const getLine = buffer.getLine.bind(buffer);
      let reads = 0;
      (buffer as { getLine: typeof buffer.getLine }).getLine = (row) => { reads += 1; return getLine(row); };
      const snapshot = keptTerminalOutput(source);
      return { snapshot, reads, original: linesOf(source) };
    };
    const small = await keptOfRows(1_000);
    const large = await keptOfRows(4_000);
    for (const { snapshot, original } of [small, large]) {
      expect(Buffer.byteLength(snapshot, "utf-8")).toBeLessThanOrEqual(TERMINAL_REPLAY_MAX_BYTES);
      // Nearly full: the most rows that fit, not some safe few.
      expect(Buffer.byteLength(snapshot, "utf-8")).toBeGreaterThan(TERMINAL_REPLAY_MAX_BYTES - 2 * dense(0).length);
      const restored = await screenOf(snapshot, cols, 50);
      expect(restored.length).toBeGreaterThan(40);
      expect(restored.length).toBeLessThan(original.length);
      expect(restored).toEqual(original.slice(-restored.length));
    }
    // Four times the scrollback, the same work: it is bounded by the replay, not by what is above it.
    expect(large.reads).toBeLessThan(small.reads * 1.2);
  });

  it("reads a long scrollback that fits once", async () => {
    const source = terminal(320, 50, 100_000);
    await written(source, "x\r\n".repeat(100_000));
    const buffer = source.buffer.normal;
    const getLine = buffer.getLine.bind(buffer);
    let reads = 0;
    (buffer as { getLine: typeof buffer.getLine }).getLine = (row) => { reads += 1; return getLine(row); };
    const snapshot = keptTerminalOutput(source);
    // One pass reads each row for its cells and up to three times at its end (the row, the next one, and the cell whose colour an erase uses).
    expect(reads).toBeLessThanOrEqual(4 * buffer.length);
    const restored = await screenOf(snapshot, 320, 50);
    expect(restored).toHaveLength(100_000);
  });

  it("keeps only the reset when not even the screen fits", async () => {
    // A screen this size with every cell in a colour of its own serializes to more than a replay.
    const cell = (index: number): string => `\x1b[38;2;${index % 256};${(index >> 8) % 256};7mx`;
    const screen = Array.from({ length: 200 * 500 }, (_, index) => cell(index)).join("");
    const { snapshot } = await kept(screen, 500, 200);
    expect(snapshot).toBe(TERMINAL_SCROLLBACK_RESET);
  });

  it("refuses a terminal whose hyperlink registry is not the one it reads, rather than keep its links some other way", async () => {
    const source = terminal();
    await written(source, "\x1b]8;;https://example.test/\x07LINK\x1b]8;;\x07\r\n");
    const core = (source as unknown as { _core: { _oscLinkService: { getLinkData?: unknown } } })._core;
    const registry = core._oscLinkService;
    const { getLinkData } = registry;
    registry.getLinkData = undefined;
    try {
      expect(() => keptTerminalOutput(source)).toThrow(/hyperlink registry/u);
    } finally {
      registry.getLinkData = getLinkData;
    }
  });
});
