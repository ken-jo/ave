/*
 * Portions adapted from xtermjs/xterm.js addons/addon-fit/src/FitAddon.ts @ @xterm/addon-fit 0.11.0,
 * Copyright (c) 2017 The xterm.js authors, MIT License.
 */
// The adapted part measures columns the way the fit addon this application bundles does.
import type { Terminal } from "@xterm/xterm";

/** The width the terminal reserves for its scrollbar when it keeps scrollback and has no overview ruler. */
const DEFAULT_SCROLL_BAR_WIDTH = 14;
const MINIMUM_COLS = 2;

/** The part of the terminal's render dimensions this reads. The fit addon reads the same object; the package is pinned. */
interface RenderDimensions {
  readonly device: { readonly cell: { readonly width: number } };
}

/**
 * How many columns the terminal's host holds.
 *
 * The fit addon divides the host's width by the cell width the renderer reports in CSS pixels, and that number is the drawn width of the
 * whole grid, rounded to a pixel, over the column count the terminal has at that moment. It is therefore a slightly different number at every
 * column count, and a host on the boundary holds 66 columns when measured from a terminal that has 80 and 67 when measured from one that has
 * 45 — and each answer, once applied, confirms itself. A terminal squeezed and widened again came back one column wider than it started.
 *
 * This divides by the width of one cell instead, which does not depend on the column count, so the same host width always holds the same
 * columns. The measuring of the host is the addon's.
 */
export function terminalColumnsFor(term: Terminal): number | null {
  const element = term.element;
  const parent = element?.parentElement;
  const view = element?.ownerDocument.defaultView;
  if (!element || !parent || !view) return null;
  const dimensions = (term as unknown as { _core?: { _renderService?: { dimensions?: RenderDimensions } } })._core?._renderService?.dimensions;
  if (!dimensions) throw new Error("the terminal's render dimensions are not where the bundled xterm keeps them");
  const cellWidth = dimensions.device.cell.width / view.devicePixelRatio;
  // Not measured yet (the terminal was opened while hidden).
  if (!(cellWidth > 0)) return null;
  const scrollbarWidth = term.options.scrollback === 0 ? 0 : term.options.overviewRuler?.width || DEFAULT_SCROLL_BAR_WIDTH;
  const parentWidth = Math.max(0, Number.parseInt(view.getComputedStyle(parent).getPropertyValue("width"), 10));
  const style = view.getComputedStyle(element);
  const padding = Number.parseInt(style.getPropertyValue("padding-left"), 10) + Number.parseInt(style.getPropertyValue("padding-right"), 10);
  const columns = Math.floor((parentWidth - padding - scrollbarWidth) / cellWidth);
  return Number.isFinite(columns) ? Math.max(MINIMUM_COLS, columns) : null;
}
