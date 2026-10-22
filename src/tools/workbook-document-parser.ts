import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";
import type { PreviewDocumentLimits, PreviewTableDocument } from "../shared/preview-document.js";
import { errorMessage } from "../shared/error-message.js";
import { TableDocumentError } from "./table-document-error.js";
import { clipTableCell } from "./table-display.js";

XLSX.set_cptable(cptable);

function workbookError(err: unknown): TableDocumentError {
  const message = errorMessage(err);
  if (/out of memory|interrupted|stack overflow/i.test(message)) {
    return new TableDocumentError("parse-limit", "Workbook parsing exceeded its resource budget.");
  }
  if (/password|encrypt/i.test(message)) return new TableDocumentError("encrypted", message);
  return new TableDocumentError("corrupt-document", message);
}

export function readWorkbook(
  bytes: Uint8Array,
  sheetIndex: number,
  limits: Readonly<PreviewDocumentLimits>,
): Omit<PreviewTableDocument, "format"> {
  const common: XLSX.ParsingOptions = {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
  };
  let allNames: string[];
  try {
    allNames = XLSX.read(bytes, { ...common, bookSheets: true }).SheetNames;
  } catch (err) {
    throw workbookError(err);
  }
  const sheetNames = allNames.slice(0, limits.maxSheets).map((name) => clipTableCell(name, limits).text);
  const sourceName = allNames[sheetIndex];
  const name = sheetNames[sheetIndex];
  if (sourceName === undefined || name === undefined) {
    throw new TableDocumentError("sheet-not-found", `sheet ${sheetIndex} of ${sheetNames.length}`);
  }
  let worksheet: XLSX.WorkSheet | undefined;
  try {
    // Sparse storage avoids allocating empty rows before a late used range.
    // Absolute sheetRows would silently discard e.g. the only cell at A10001.
    // The fixed parser workspace contains the parse; the window below is relative.
    worksheet = XLSX.read(bytes, { ...common, dense: false, sheets: [sourceName] }).Sheets[sourceName];
  } catch (err) {
    throw workbookError(err);
  }
  if (!worksheet) throw new TableDocumentError("corrupt-document", `sheet "${name}" has no data part`);

  const shown = worksheet["!ref"];
  const full = worksheet["!fullref"] ?? shown;
  let rows: string[][] = [];
  let firstRow = 0;
  let firstColumn = 0;
  let totalRows = 0;
  let totalColumns = 0;
  let cellsTruncated = false;
  if (shown && full) {
    const fullRange = XLSX.utils.decode_range(full);
    const shownRange = XLSX.utils.decode_range(shown);
    firstRow = fullRange.s.r;
    firstColumn = fullRange.s.c;
    totalRows = fullRange.e.r - fullRange.s.r + 1;
    totalColumns = fullRange.e.c - fullRange.s.c + 1;
    const width = Math.min(totalColumns, limits.maxColumns);
    const rowLimit = Math.min(limits.maxRows, Math.floor(limits.maxReturnedCells / width));
    const range = {
      s: fullRange.s,
      e: {
        r: Math.min(shownRange.e.r, fullRange.s.r + rowLimit - 1),
        c: fullRange.s.c + width - 1,
      },
    };
    const raw = rowLimit > 0 ? XLSX.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
      range,
    }) : [];
    rows = raw.map((row) => {
      const cells: string[] = [];
      for (let c = 0; c < width; c += 1) {
        const value = row[c];
        const clipped = clipTableCell(value === undefined || value === null ? "" : String(value), limits);
        cellsTruncated ||= clipped.clipped;
        cells.push(clipped.text);
      }
      return cells;
    });
  }
  return {
    sheetNames,
    totalSheets: allNames.length,
    sheetsTruncated: allNames.length > sheetNames.length,
    sheet: {
      index: sheetIndex,
      name,
      rows,
      firstRow,
      firstColumn,
      totalRows,
      totalColumns,
      rowsTruncated: totalRows > rows.length,
      columnsTruncated: totalColumns > limits.maxColumns,
      cellsTruncated,
    },
  };
}
