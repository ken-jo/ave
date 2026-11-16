/*
 * Portions adapted from microsoft/vscode src/vs/workbench/contrib/terminal/browser/terminalResizeDebouncer.ts @ 6659689e6b03ec062f5b7bcea9850b4c59045807,
 * Copyright (c) Microsoft Corporation, MIT License.
 */

/** The buffer length from which a width change waits; a shorter buffer reflows at no cost worth sparing. */
const START_DEBOUNCING_THRESHOLD = 200;
/** How long the width must hold before the columns follow it. */
const DEBOUNCE_RESIZE_COLS_DELAY_MS = 100;

/**
 * Applies a terminal's new size in two parts. Rows follow at once: a row change only moves the viewport. Columns reflow every wrapped line, so
 * with a long buffer, while a window or a divider is being dragged, they wait until the width has held for
 * {@link DEBOUNCE_RESIZE_COLS_DELAY_MS} and the buffer reflows once instead of at every width of the drag. A short buffer takes each size as it
 * comes.
 *
 * The wait spares work; it is not what keeps a width from the shell. A width the terminal should never take (a layout on its way somewhere
 * else) must not reach its host in the first place.
 */
export class TerminalResizeDebouncer {
  private latestCols = 0;
  private latestRows = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    /** Lines in the terminal's normal buffer. */
    private readonly bufferLength: () => number,
    private readonly resizeBoth: (cols: number, rows: number) => void,
    private readonly resizeCols: (cols: number) => void,
    private readonly resizeRows: (rows: number) => void,
  ) {}

  /** `immediate`: both parts apply now whatever the buffer holds (a first layout, a font change). */
  resize(cols: number, rows: number, immediate: boolean): void {
    if (this.disposed) return;
    this.latestCols = cols;
    this.latestRows = rows;
    if (immediate || this.bufferLength() < START_DEBOUNCING_THRESHOLD) {
      this.cancel();
      this.resizeBoth(cols, rows);
      return;
    }
    this.resizeRows(rows);
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.resizeCols(this.latestCols);
    }, DEBOUNCE_RESIZE_COLS_DELAY_MS);
  }

  /** Apply a waiting column change now. */
  flush(): void {
    if (this.disposed || this.timer === null) return;
    this.cancel();
    this.resizeBoth(this.latestCols, this.latestRows);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  /** Forget a column change that is still waiting: the width it was measured at is no longer the terminal's to take. */
  cancel(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
