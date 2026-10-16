/**
 * Virtualized grid for the side-panel table preview. Loaded only through
 * `React.lazy` (see `table-document-preview.tsx`) so react-data-grid lives in
 * its own renderer chunk instead of the startup bundle.
 *
 * Read-only: no editors, no paste/fill handlers. Every cell is rendered as a
 * React text node (react-data-grid's default `renderValue`), so a cell that
 * looks like markup or a formula is shown verbatim.
 */
import { useMemo } from "react";
import { DataGrid, type Column } from "react-data-grid";
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
 */
export function tableGridBlockStyle(rowCount: number): {
  flex: string;
  minBlockSize: string;
  maxBlockSize: string;
} {
  const contentBlock = HEADER_ROW_HEIGHT + rowCount * ROW_HEIGHT + GRID_BORDER_BLOCK;
  return {
    flex: "1 1 0",
    minBlockSize: `${Math.min(contentBlock, GRID_MIN_BLOCK_PX)}px`,
    maxBlockSize: `${contentBlock}px`,
  };
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

  return (
    <DataGrid<GridRow>
      className="ave-table-grid"
      aria-label={label}
      data-testid="chat-side-panel-table-grid"
      columns={columns}
      rows={sheet.rows}
      rowHeight={ROW_HEIGHT}
      headerRowHeight={HEADER_ROW_HEIGHT}
      style={{ ...tableGridBlockStyle(sheet.rows.length), inlineSize: "100%" }}
    />
  );
}
