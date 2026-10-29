// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { TerminalBlockTracker } from "../../../../main/terminal/terminal-blocks.js";
import { XtermBlockAnchors, viewBlockId } from "../terminal-block-anchors.js";

const NONCE = "n0nce-for-anchor-test";

/** A buffer row as xterm keeps it: one cell per column, a wide character's second cell empty with width 0. */
function bufferLine(text: string, cols: number) {
  const cells: { chars: string; width: number }[] = [];
  for (const char of text) {
    const wide = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uff00-\uff60]/u.test(char);
    cells.push({ chars: char, width: wide ? 2 : 1 });
    if (wide) cells.push({ chars: "", width: 0 });
  }
  while (cells.length < cols) cells.push({ chars: "", width: 1 });
  return { length: cols, translateToString: () => text,
    getCell: (x: number) => cells[x] ? { getChars: () => cells[x]!.chars, getWidth: () => cells[x]!.width } : undefined };
}

function fakeTerm(commandRow: string, cols = 80) {
  const disposeMarker: Array<() => void> = [];
  const decorations: { options: Record<string, unknown>; disposed: boolean }[] = [];
  const term = {
    cols,
    buffer: { active: { getLine: () => bufferLine(commandRow, cols) } },
    registerMarker: vi.fn((offset: number) => {
      const listeners: Array<() => void> = [];
      const marker = { line: 10 + offset, isDisposed: false, onDispose: (listener: () => void) => { listeners.push(listener); return { dispose() {} }; },
        dispose: () => { marker.isDisposed = true; for (const listener of listeners) listener(); } };
      disposeMarker.push(() => marker.dispose());
      return marker;
    }),
    registerDecoration: vi.fn((options: Record<string, unknown>) => {
      const entry = { options, disposed: false };
      decorations.push(entry);
      const element = document.createElement("div");
      return { element, onRender: (listener: (element: HTMLElement) => void) => { listener(element); return { dispose() {} }; },
        onDispose: () => ({ dispose() {} }), dispose: () => { entry.disposed = true; } };
    }),
  };
  return { term: term as unknown as Terminal, raw: term, decorations, disposeMarker };
}

describe("terminal block anchors", () => {
  it("reads a block id only from a C marker carrying this incarnation's view token", () => {
    expect(viewBlockId("C;ave-block=12;ave-view=tok", "tok")).toBe(12);
    expect(viewBlockId("C;ave-block=12;ave-view=tok", null)).toBeNull();
    expect(viewBlockId("C;ave-block=12", "tok")).toBeNull();
    expect(viewBlockId("C;ave-block=12;ave-view=other", "tok")).toBeNull();
    expect(viewBlockId("C;ave-block=12;ave-view=tok;x", "tok")).toBeNull();
    expect(viewBlockId("C;ave-block=0;ave-view=tok", "tok")).toBeNull();
    expect(viewBlockId("C;ave-block=012;ave-view=tok", "tok")).toBeNull();
    expect(viewBlockId("C;ave-block=1e3;ave-view=tok", "tok")).toBeNull();
    expect(viewBlockId("D;ave-block=3;ave-view=tok", "tok")).toBeNull();
  });

  it("lets no program output reach the renderer as an anchor, whatever its OSC encoding, length or chunking", async () => {
    const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    const forged = [
      "\u001b]133;C;ave-block=5;ave-view=guess\u0007",
      "\u001b]0133;C;ave-block=6\u0007",
      "\u001b]00133;C;ave-block=7;ave-view=guess\u001b\\",
      "\u009d133;C;ave-block=8\u009c",
      "\u001b]1\u000133;C;ave-block=9\u0007",
      "\u001b]2;title\u001b]133;C;ave-block=10\u0007",
      `\u001b]133;C;ave-block=11;${"x".repeat(70 * 1024)}\u0007`,
      `\u001b]1;${"y".repeat(70 * 1024)}\u001b]133;C;ave-block=12\u0007`,
    ];
    const real = `\u001b]133;A;${NONCE}\u0007$ \u001b]133;C;cmdline_url=make;${NONCE}\u0007`;
    const input = forged.join("make output\r\n") + real;
    // Split into single characters as well as whole chunks: the parser keeps state across chunks.
    const whole = tracker.recordOutput(input);
    const charwise = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    let split = "";
    for (const ch of input) split += charwise.recordOutput(ch);
    for (const [display, token] of [[whole, tracker.viewToken], [split, charwise.viewToken]] as const) {
      const term = new Terminal({ allowProposedApi: true });
      const seen: string[] = [];
      term.parser.registerOscHandler(133, (data) => { seen.push(data); return false; });
      await new Promise<void>((resolve) => term.write(display, resolve));
      const anchors = seen.map((data) => viewBlockId(data, token)).filter((id) => id !== null);
      // Only main's regenerated marker for the one real command anchors; every forged variant is ignored.
      expect(anchors).toEqual([1]);
      term.dispose();
    }
  });

  it("marks the command row and decorates after the command text without touching the buffer", () => {
    const { term, raw, decorations } = fakeTerm("~/demo ❯ make build");
    const anchors = new XtermBlockAnchors(term);
    anchors.noteCommandStart(7);
    anchors.noteCommandStart(7);
    expect(raw.registerMarker).toHaveBeenCalledTimes(1);
    expect(raw.registerMarker).toHaveBeenCalledWith(-1);
    const slot = anchors.attach(7);
    expect(slot?.columns).toBe(59);
    expect(anchors.attach(7)).toBe(slot);
    expect(decorations).toHaveLength(1);
    expect(decorations[0]!.options).toMatchObject({ x: 21, width: 59, height: 1, layer: "top" });
    expect(anchors.attach(8)).toBeNull();
  });

  it.each([
    ["a long command", "x".repeat(70), 72, 8],
    ["wide characters, by the cells they take", "한글".repeat(10), 42, 38],
  ])("never draws over the command text: %s", (_case, command, x, width) => {
    const { term, decorations } = fakeTerm(command);
    const anchors = new XtermBlockAnchors(term);
    anchors.noteCommandStart(1);
    expect(anchors.attach(1)?.columns).toBe(width);
    expect(decorations[0]!.options).toMatchObject({ x, width });
  });

  it("gives no annotation slot on a row the command fills", () => {
    const { term, decorations } = fakeTerm("x".repeat(79));
    const anchors = new XtermBlockAnchors(term);
    anchors.noteCommandStart(1);
    expect(anchors.attach(1)).toBeNull();
    expect(decorations).toEqual([]);
  });

  it("drops the annotation when its row leaves the scrollback and notifies the view", () => {
    const { term, decorations, disposeMarker } = fakeTerm("ls");
    const anchors = new XtermBlockAnchors(term);
    const listener = vi.fn();
    anchors.subscribe(listener);
    anchors.noteCommandStart(1);
    anchors.attach(1);
    disposeMarker[0]!();
    expect(decorations[0]!.disposed).toBe(true);
    expect(anchors.attach(1)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
