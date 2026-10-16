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
      rowHeight={24}
      headerRowHeight={26}
      style={{ blockSize: "min(70vh, 640px)", inlineSize: "100%" }}
    />
  );
}
