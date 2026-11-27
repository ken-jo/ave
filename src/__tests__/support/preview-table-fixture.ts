import type { PreviewTableDocument } from "../../shared/preview-document.js";

export function table(value: string): PreviewTableDocument {
  return {
    format: "csv",
    needsRecalculation: false,
    sheetNames: ["Sheet1"],
    totalSheets: 1,
    sheetsTruncated: false,
    sheet: {
      index: 0,
      name: "Sheet1",
      rows: [[value]],
      firstRow: 0,
      firstColumn: 0,
      totalRows: 1,
      totalColumns: 1,
      rowsTruncated: false,
      columnsTruncated: false,
      cellsTruncated: false,
      clippedCells: [],
    },
  };
}
