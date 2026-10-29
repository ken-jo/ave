// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { XtermBlockAnchors, viewBlockId } from "../terminal-block-anchors.js";

function fakeTerm(commandRow: string, cols = 80) {
  const disposeMarker: Array<() => void> = [];
  const decorations: { options: Record<string, unknown>; disposed: boolean }[] = [];
  const term = {
    cols,
    buffer: { active: { getLine: () => ({ translateToString: () => commandRow }) } },
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
  it("reads only a positive integer block id from a C marker", () => {
    expect(viewBlockId("C;ave-block=12")).toBe(12);
    expect(viewBlockId("C")).toBeNull();
    expect(viewBlockId("C;ave-block=0")).toBeNull();
    expect(viewBlockId("C;ave-block=1e3x")).toBeNull();
    expect(viewBlockId("D;ave-block=3")).toBeNull();
  });

  it("marks the command row and decorates after the command text without touching the buffer", () => {
    const { term, raw, decorations } = fakeTerm("~/demo ❯ make build");
    const anchors = new XtermBlockAnchors(term);
    anchors.noteCommandStart(7);
    anchors.noteCommandStart(7);
    expect(raw.registerMarker).toHaveBeenCalledTimes(1);
    expect(raw.registerMarker).toHaveBeenCalledWith(-1);
    const container = anchors.attach(7);
    expect(container).not.toBeNull();
    expect(anchors.attach(7)).toBe(container);
    expect(decorations).toHaveLength(1);
    expect(decorations[0]!.options).toMatchObject({ x: 21, width: 59, height: 1, layer: "top" });
    expect(anchors.attach(8)).toBeNull();
  });

  it("keeps a minimum annotation width on a long command row", () => {
    const { term, decorations } = fakeTerm("x".repeat(78));
    const anchors = new XtermBlockAnchors(term);
    anchors.noteCommandStart(1);
    anchors.attach(1);
    expect(decorations[0]!.options).toMatchObject({ x: 56, width: 24 });
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
