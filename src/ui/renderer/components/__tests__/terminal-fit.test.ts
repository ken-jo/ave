// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { terminalColumnsFor } from "../terminal-fit.js";

/** A terminal in a host of `hostWidth` pixels, as the renderer describes it while it has `cols` columns. */
function terminalIn(hostWidth: number, cols: number, options: { scrollback?: number; padding?: number; deviceCellWidth?: number; dimensions?: boolean } = {}): Terminal {
  const host = document.createElement("div");
  host.style.width = `${hostWidth}px`;
  const element = document.createElement("div");
  if (options.padding) element.style.padding = `0 ${options.padding}px`;
  host.appendChild(element);
  document.body.appendChild(host);
  const deviceCellWidth = options.deviceCellWidth ?? 7.224609375;
  // What the renderer reports: the grid's drawn width rounded to a pixel, and the CSS cell width derived from it.
  const canvasWidth = Math.round(cols * deviceCellWidth);
  const dimensions = { device: { cell: { width: deviceCellWidth } }, css: { canvas: { width: canvasWidth }, cell: { width: canvasWidth / cols } } };
  return {
    cols, element, options: { scrollback: options.scrollback ?? 5000 },
    ...(options.dimensions === false ? {} : { _core: { _renderService: { dimensions } } }),
  } as unknown as Terminal;
}

afterEach(() => { document.body.replaceChildren(); });

describe("the columns a host holds", () => {
  it("are the same whatever column count the terminal has when it is measured", () => {
    // 498 px less the 14 px scrollbar is 484 px; one cell is 7.2246 px, so 66 cells fit and a 67th would overflow by a twentieth of a pixel.
    // Dividing by the renderer's per-count CSS cell width instead gives 67 when measured from 45 columns and 66 from 80.
    const addonAnswer = (cols: number): number => Math.floor(484 / (Math.round(cols * 7.224609375) / cols));
    expect([45, 66, 67, 80].map(addonAnswer)).toEqual([67, 66, 67, 66]);
    expect([45, 66, 67, 80].map((cols) => terminalColumnsFor(terminalIn(498, cols)))).toEqual([66, 66, 66, 66]);
  });

  it("leave room for the scrollbar only when there is scrollback, and for the terminal's own padding", () => {
    expect(terminalColumnsFor(terminalIn(498, 80, { deviceCellWidth: 8 }))).toBe(60);
    expect(terminalColumnsFor(terminalIn(498, 80, { deviceCellWidth: 8, scrollback: 0 }))).toBe(62);
    expect(terminalColumnsFor(terminalIn(498, 80, { deviceCellWidth: 8, padding: 10 }))).toBe(58);
  });

  it("never go below two, and are not given before the cells are measured or without a host", () => {
    expect(terminalColumnsFor(terminalIn(7, 80))).toBe(2);
    expect(terminalColumnsFor(terminalIn(498, 80, { deviceCellWidth: 0 }))).toBeNull();
    expect(terminalColumnsFor({ element: undefined, options: {} } as unknown as Terminal)).toBeNull();
  });

  it("fail loudly when the bundled terminal no longer keeps its dimensions where they are read", () => {
    expect(() => terminalColumnsFor(terminalIn(498, 80, { dimensions: false }))).toThrow(/render dimensions/u);
  });
});
