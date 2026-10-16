/**
 * Table-document reader (CSV / TSV / XLSX / XLS / ODS → bounded display grid).
 *
 * The main process parses; the renderer only ever receives the
 * {@link PreviewTableDocument} this returns. Every cap comes from
 * {@link PREVIEW_DOCUMENT_LIMITS}; a cap that cuts data sets a truncation flag
 * the viewer shows, and a cap that cannot be honoured safely (file size, zip
 * bomb) refuses the document with a {@link TableDocumentError}.
 *
 * Loaded lazily by the preview IPC (`await import(...)`) so SheetJS and
 * Papa Parse stay out of the main process's startup graph.
 *
 * Formulas are never evaluated: SheetJS is asked for cached values only
 * (`cellFormula: false`), macros are not read (`bookVBA: false`), and every
 * value leaves as plain text.
 */
import Papa from "papaparse";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

import {
  PREVIEW_DOCUMENT_LIMITS,
  type PreviewDocumentError,
  type PreviewDocumentFormat,
  type PreviewDocumentLimits,
  type PreviewTableDocument,
  type PreviewTableSheet,
} from "../shared/preview-document.js";
import { hasZipMagic, verifyZipInflateLimits } from "./zip-inflate-guard.js";

// Legacy .xls stores text in Windows code pages (cp949, cp1252, …).
XLSX.set_cptable(cptable);

export type TableDocumentLimits = Readonly<PreviewDocumentLimits>;

export class TableDocumentError extends Error {
  constructor(readonly code: PreviewDocumentError, message: string) {
    super(message);
    this.name = "TableDocumentError";
  }
}

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

function hasCfbMagic(bytes: Uint8Array): boolean {
  return CFB_MAGIC.every((byte, i) => bytes[i] === byte);
}

function clipCell(value: string, limits: TableDocumentLimits): { text: string; clipped: boolean } {
  if (value.length <= limits.maxCellChars) return { text: value, clipped: false };
  return { text: `${value.slice(0, limits.maxCellChars)}…`, clipped: true };
}

/**
 * Decode CSV/TSV bytes. A BOM selects UTF-8 / UTF-16LE / UTF-16BE and is
 * stripped; without one the text must be valid UTF-8, otherwise the document is
 * refused as `unsupported-encoding` rather than shown with replacement marks.
 */
export function decodeDelimitedText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TableDocumentError(
      "unsupported-encoding",
      "text is not UTF-8 and carries no UTF-8/UTF-16 byte-order mark",
    );
  }
}

function parseDelimited(
  bytes: Uint8Array,
  format: "csv" | "tsv",
  limits: TableDocumentLimits,
): PreviewTableSheet {
  // The line terminator after the last record is not an empty record. Dropping
  // it also keeps Papa's delimiter detection from seeing a 1-field row.
  const text = decodeDelimitedText(bytes).replace(/\r?\n$/, "");
  const kept: string[][] = [];
  let totalRows = 0;
  let totalColumns = 0;
  let cellsTruncated = false;
  Papa.parse<string[]>(text, {
    // TSV is always tab-separated; CSV lets Papa detect `,` `;` `|` or tab.
    delimiter: format === "tsv" ? "\t" : "",
    skipEmptyLines: false,
    step: (result) => {
      const row = result.data;
      totalRows += 1;
      totalColumns = Math.max(totalColumns, row.length);
      if (kept.length >= limits.maxRows) return;
      kept.push(row.slice(0, limits.maxColumns).map((cell) => {
        const clipped = clipCell(cell, limits);
        cellsTruncated ||= clipped.clipped;
        return clipped.text;
      }));
    },
  });
  const width = Math.min(totalColumns, limits.maxColumns);
  const rows = kept.map((row) => (row.length < width ? [...row, ...Array<string>(width - row.length).fill("")] : row));
  return {
    index: 0,
    name: format.toUpperCase(),
    rows,
    firstRow: 0,
    firstColumn: 0,
    totalRows,
    totalColumns,
    rowsTruncated: totalRows > rows.length,
    columnsTruncated: totalColumns > width,
    cellsTruncated,
  };
}

function workbookError(err: unknown): TableDocumentError {
  const message = err instanceof Error ? err.message : String(err);
  if (/password|encrypt/i.test(message)) return new TableDocumentError("encrypted", message);
  return new TableDocumentError("corrupt-document", message);
}

function assertWorkbookContainer(bytes: Buffer, format: "xlsx" | "xls" | "ods", limits: TableDocumentLimits): void {
  const zip = hasZipMagic(bytes);
  // xlsx/ods are zip packages; an encrypted xlsx is a CFB envelope (SheetJS
  // reports it as password-protected). Anything else is not that format.
  if ((format === "xlsx" && !zip && !hasCfbMagic(bytes)) || (format === "ods" && !zip)) {
    throw new TableDocumentError("corrupt-document", `not a ${format} container`);
  }
  if (!zip) return;
  const verdict = verifyZipInflateLimits(bytes, limits);
  if (verdict.ok) return;
  switch (verdict.reason) {
    case "corrupt":
      throw new TableDocumentError("corrupt-document", verdict.detail);
    case "encrypted":
      throw new TableDocumentError("encrypted", verdict.detail);
    case "too-many-entries":
    case "too-large":
    case "compression-ratio":
    case "size-mismatch":
      throw new TableDocumentError("archive-too-large", `${verdict.reason}: ${verdict.detail}`);
  }
}

function parseWorkbook(
  bytes: Buffer,
  format: "xlsx" | "xls" | "ods",
  sheetIndex: number,
  limits: TableDocumentLimits,
): Omit<PreviewTableDocument, "format"> {
  assertWorkbookContainer(bytes, format, limits);
  const common: XLSX.ParsingOptions = {
    type: "buffer",
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
  const sheetNames = allNames.slice(0, limits.maxSheets);
  const name = sheetNames[sheetIndex];
  if (name === undefined) {
    throw new TableDocumentError("sheet-not-found", `sheet ${sheetIndex} of ${sheetNames.length}`);
  }
  let worksheet: XLSX.WorkSheet | undefined;
  try {
    worksheet = XLSX.read(bytes, { ...common, dense: true, sheets: [name], sheetRows: limits.maxRows }).Sheets[name];
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
    const range = {
      s: fullRange.s,
      e: {
        r: Math.min(shownRange.e.r, fullRange.s.r + limits.maxRows - 1),
        c: Math.min(fullRange.e.c, fullRange.s.c + limits.maxColumns - 1),
      },
    };
    const width = range.e.c - range.s.c + 1;
    const raw = XLSX.utils.sheet_to_json<string[]>(worksheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: true,
      range,
    });
    rows = raw.map((row) => {
      const cells: string[] = [];
      for (let c = 0; c < width; c += 1) {
        const value = row[c];
        const clipped = clipCell(value === undefined || value === null ? "" : String(value), limits);
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

/**
 * Parse `bytes` as `format` and return sheet `sheetIndex` as a bounded grid.
 * Throws {@link TableDocumentError} for every refusal; the caller maps
 * `code` onto its IPC result.
 */
export function parseTableDocument(
  bytes: Buffer,
  format: PreviewDocumentFormat,
  sheetIndex: number,
  limits: TableDocumentLimits = PREVIEW_DOCUMENT_LIMITS,
): PreviewTableDocument {
  if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0) {
    throw new TableDocumentError("sheet-not-found", `sheet index ${String(sheetIndex)} is not a non-negative integer`);
  }
  if (bytes.length > limits.maxFileBytes) {
    throw new TableDocumentError("too-large", `${bytes.length} bytes exceeds ${limits.maxFileBytes}`);
  }
  if (format === "csv" || format === "tsv") {
    if (sheetIndex !== 0) throw new TableDocumentError("sheet-not-found", `${format} has one sheet`);
    const sheet = parseDelimited(bytes, format, limits);
    return { format, sheetNames: [sheet.name], totalSheets: 1, sheetsTruncated: false, sheet };
  }
  return { format, ...parseWorkbook(bytes, format, sheetIndex, limits) };
}
