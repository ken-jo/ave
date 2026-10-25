/**
 * Virtualized grid for the side-panel table preview. Loaded only through
 * `React.lazy` (see `table-document-preview.tsx`) so react-data-grid lives in
 * its own renderer chunk instead of the startup bundle.
 *
 * Read-only: no editors, no paste/fill handlers. Every cell is rendered as a
 * React text node (react-data-grid's default `renderValue`), so a cell that
 * looks like markup or a formula is shown verbatim.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { DataGrid, type Column, type DataGridHandle } from "react-data-grid";
import type { PreviewTableSheet } from "../../../shared/preview-document.js";

type GridRow = readonly string[];

/** 0-based column index → spreadsheet letters (0 → A, 25 → Z, 26 → AA). */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ROW_NUMBER_KEY = "__row";
const ROW_HEIGHT = 24;
const HEADER_ROW_HEIGHT = 26;
/** react-data-grid draws a 1px border on each block edge of its root. */
const GRID_BORDER_BLOCK = 2;
/**
 * Below the header and two rows the grid stops shrinking and the panel scrolls
 * instead. Kept small so the file browser's default split (a ~320px preview
 * pane holding the header, path, sheet tabs and a notice) still fits whole.
 */
const GRID_MIN_BLOCK_PX = HEADER_ROW_HEIGHT + 2 * ROW_HEIGHT + GRID_BORDER_BLOCK;

/**
 * Block-axis sizing for the grid inside the side panel's flex column. The flex
 * basis is 0, so the grid adds nothing to the column's own height and takes the
 * height the panel has left; it never grows past its rows, so a short sheet
 * keeps its natural height and shows no scrollbar.
 *
 * `horizontalScrollbarPx` is the height of the grid's own horizontal scrollbar
 * when its columns overflow (0 for overlay scrollbars or when they fit). A
 * classic scrollbar takes that height out of the rows' space, so both bounds
 * make room for it — otherwise a short wide sheet would scroll vertically and
 * a one-row sheet would hide its row behind the bar.
 */
export function tableGridBlockStyle(rowCount: number, horizontalScrollbarPx: number): {
  flex: string;
  minBlockSize: string;
  maxBlockSize: string;
} {
  const contentBlock = HEADER_ROW_HEIGHT + rowCount * ROW_HEIGHT + GRID_BORDER_BLOCK;
  return {
    flex: "1 1 0",
    minBlockSize: `${Math.min(contentBlock, GRID_MIN_BLOCK_PX) + horizontalScrollbarPx}px`,
    maxBlockSize: `${contentBlock + horizontalScrollbarPx}px`,
  };
}

/** Height the element's horizontal scrollbar takes from its padding box (0 when there is none). */
export function horizontalScrollbarBlockPx(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  return Math.max(0, Math.round(element.offsetHeight - element.clientHeight - borders));
}

export function TableDocumentGrid({ sheet, label }: { sheet: PreviewTableSheet; label: string }) {
  const columns = useMemo<readonly Column<GridRow>[]>(() => {
    const width = sheet.rows[0]?.length ?? 0;
    const rowNumberWidth = Math.max(36, String(sheet.firstRow + sheet.rows.length).length * 8 + 16);
    return [
      {
        key: ROW_NUMBER_KEY,
        name: "",
        frozen: true,
        width: rowNumberWidth,
        minWidth: rowNumberWidth,
        resizable: false,
        cellClass: "ave-table-grid-rownum",
        renderCell: ({ rowIdx }) => sheet.firstRow + rowIdx + 1,
      },
      ...Array.from({ length: width }, (_, c): Column<GridRow> => ({
        key: String(c),
        name: columnLetters(sheet.firstColumn + c),
        resizable: true,
        minWidth: 48,
        width: 120,
        renderCell: ({ row }) => row[c],
      })),
    ];
  }, [sheet]);

  // A classic horizontal scrollbar appears or goes away as the grid's width or
  // its column widths change; either changes the grid's content-box height, so
  // the ResizeObserver sees it. jsdom has no ResizeObserver (react-data-grid
  // guards the same way); there is no scrollbar to measure there either.
  const gridRef = useRef<DataGridHandle>(null);
  const [horizontalScrollbarPx, setHorizontalScrollbarPx] = useState(0);
  useLayoutEffect(() => {
    const element = gridRef.current?.element;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setHorizontalScrollbarPx(horizontalScrollbarBlockPx(element));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <DataGrid<GridRow>
      ref={gridRef}
      className="ave-table-grid"
      aria-label={label}
      data-testid="chat-side-panel-table-grid"
      columns={columns}
      rows={sheet.rows}
      rowHeight={ROW_HEIGHT}
      headerRowHeight={HEADER_ROW_HEIGHT}
      style={{ ...tableGridBlockStyle(sheet.rows.length, horizontalScrollbarPx), inlineSize: "100%" }}
    />
  );
}
