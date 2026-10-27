import {
  PREVIEW_DOCUMENT_LIMITS,
  previewDocumentFormatOf,
  type PreviewDocumentError,
  type PreviewTableDocument,
  type PreviewTableWindow,
} from "../shared/preview-document.js";
import { isPlainRecord } from "../shared/is-record.js";

type ParseError = Exclude<PreviewDocumentError,
  "unauthorized" | "path-not-allowed" | "sensitive-path" | "not-a-file" | "unsupported-format">;

export const DOCUMENT_PARSE_MESSAGES: Readonly<Record<ParseError, string>> = Object.freeze({
  "too-large": "Document exceeds the file size limit.",
  "archive-too-large": "Document expansion exceeds the preview limits.",
  "invalid-index": "Document index must be a non-negative integer.",
  "sheet-not-found": "Requested sheet does not exist.",
  "page-not-found": "Requested page does not exist.",
  "renderer-unavailable": "The PDF page renderer is unavailable in this installation.",
  "engine-unavailable": "The optional document engine is not installed.",
  "engine-integrity-failed": "Document engine integrity verification failed.",
  "engine-confinement-unavailable": "Document engine confinement is unavailable.",
  "engine-runtime-unavailable": "The document importer requires a verified Java runtime.",
  "engine-failed": "The document engine failed to convert the document.",
  encrypted: "Encrypted documents cannot be previewed.",
  "unsupported-encoding": "Document encoding is not supported.",
  "corrupt-document": "Document is malformed or has the wrong container type.",
  busy: "Another document preview is active. Try again shortly.",
  superseded: "A newer document preview replaced this request.",
  "parse-limit": "Document parsing exceeded its resource budget.",
  "read-failed": "Document parser failed its internal contract.",
});

export const DOCUMENT_PARSE_READY = "ave-document-ready\n";

export function isDocumentParseError(value: unknown): value is Exclude<ParseError, "busy" | "superseded"> {
  return typeof value === "string" && value !== "busy" && value !== "superseded"
    && Object.hasOwn(DOCUMENT_PARSE_MESSAGES, value);
}

const DOCUMENT_FIELDS = ["format", "needsRecalculation", "sheetNames", "totalSheets", "sheetsTruncated", "sheet"] as const;
const SHEET_FIELDS = [
  "index", "name", "rows", "firstRow", "firstColumn", "totalRows", "totalColumns",
  "rowsTruncated", "columnsTruncated", "cellsTruncated", "clippedCells",
] as const;

function hasExactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDisplayString(value: unknown): value is string {
  return typeof value === "string" && value.length <= PREVIEW_DOCUMENT_LIMITS.maxCellChars + 1;
}

function invalidResponse(): never {
  throw new Error("Document result violates the preview contract.");
}

/** Validate in place: copying a large grid would allocate it again in the host. */
export function readDocumentResponse(value: unknown, window?: PreviewTableWindow): PreviewTableDocument {
  if (!hasExactFields(value, DOCUMENT_FIELDS)
      || typeof value.needsRecalculation !== "boolean" || (value.format !== "xlsx" && value.needsRecalculation)
      || typeof value.format !== "string" || previewDocumentFormatOf(`document.${value.format}`) !== value.format
      || !Array.isArray(value.sheetNames) || value.sheetNames.length === 0
      || value.sheetNames.length > PREVIEW_DOCUMENT_LIMITS.maxSheets
      || !value.sheetNames.every(isDisplayString)
      || !isCount(value.totalSheets) || value.totalSheets < value.sheetNames.length
      || value.sheetsTruncated !== (value.totalSheets > value.sheetNames.length)
      || !(hasExactFields(value.sheet, SHEET_FIELDS)
        || hasExactFields(value.sheet, [...SHEET_FIELDS, "sourceRange"]))) invalidResponse();
  const sheet = value.sheet;
  if (!isCount(sheet.index) || value.sheetNames[sheet.index] !== sheet.name || !isDisplayString(sheet.name)
      || !isCount(sheet.firstRow) || !isCount(sheet.firstColumn)
      || !isCount(sheet.totalRows) || !isCount(sheet.totalColumns)
      || typeof sheet.cellsTruncated !== "boolean" || !Array.isArray(sheet.rows)
      || sheet.rows.length > PREVIEW_DOCUMENT_LIMITS.maxRows || sheet.totalRows < sheet.rows.length
      || sheet.rowsTruncated !== (sheet.totalRows > sheet.rows.length)) invalidResponse();
  const origin = sheet.sourceRange;
  let width = Math.min(sheet.totalColumns, PREVIEW_DOCUMENT_LIMITS.maxColumns);
  if (origin !== undefined) {
    if (!hasExactFields(origin, ["firstRow", "firstColumn", "totalsExact"])
        || !isCount(origin.firstRow) || !isCount(origin.firstColumn) || typeof origin.totalsExact !== "boolean"
        || ((value.format !== "csv" && value.format !== "tsv") && origin.totalsExact !== true)
        || sheet.firstRow < origin.firstRow || sheet.firstColumn < origin.firstColumn
        || !Number.isSafeInteger(origin.firstRow + sheet.totalRows)
        || !Number.isSafeInteger(origin.firstColumn + sheet.totalColumns)) invalidResponse();
    width = sheet.rows.length === 0 ? 0 : (Array.isArray(sheet.rows[0]) ? sheet.rows[0].length : -1);
    if (width < 0 || width > PREVIEW_DOCUMENT_LIMITS.maxColumns
        || (sheet.rows.length > 0 && (width === 0
          || sheet.firstRow + sheet.rows.length > origin.firstRow + sheet.totalRows
          || sheet.firstColumn + width > origin.firstColumn + sheet.totalColumns))) invalidResponse();
    if (window) {
      const firstRow = Math.max(origin.firstRow, window.rowOffset ?? origin.firstRow);
      const firstColumn = Math.max(origin.firstColumn, window.columnOffset ?? origin.firstColumn);
      const height = Math.max(0, Math.min(origin.firstRow + sheet.totalRows,
        (window.rowOffset ?? origin.firstRow) + window.rowCount) - firstRow);
      const expectedWidth = Math.max(0, Math.min(origin.firstColumn + sheet.totalColumns,
        (window.columnOffset ?? origin.firstColumn) + window.columnCount) - firstColumn);
      if (sheet.firstRow !== firstRow || sheet.firstColumn !== firstColumn
          || sheet.rows.length !== (expectedWidth === 0 ? 0 : height)
          || width !== (height === 0 ? 0 : expectedWidth)) invalidResponse();
    }
  } else if (window) invalidResponse();
  if (sheet.columnsTruncated !== (sheet.totalColumns > width)
      || sheet.rows.length * width > PREVIEW_DOCUMENT_LIMITS.maxReturnedCells) invalidResponse();
  for (const row of sheet.rows) {
    if (!Array.isArray(row) || row.length !== width) invalidResponse();
    for (const cell of row) if (!isDisplayString(cell)) invalidResponse();
  }
  if (!Array.isArray(sheet.clippedCells) || sheet.clippedCells.length > sheet.rows.length * width
      || sheet.cellsTruncated !== (sheet.clippedCells.length > 0)) invalidResponse();
  const clippedCoordinates = new Set<string>();
  for (const cell of sheet.clippedCells) {
    if (!hasExactFields(cell, ["row", "column"]) || !isCount(cell.row) || !isCount(cell.column)
        || cell.row < sheet.firstRow || cell.row - sheet.firstRow >= sheet.rows.length
        || cell.column < sheet.firstColumn || cell.column - sheet.firstColumn >= width) invalidResponse();
    const key = `${cell.row}:${cell.column}`;
    if (clippedCoordinates.has(key)) invalidResponse();
    clippedCoordinates.add(key);
  }
  return value as unknown as PreviewTableDocument;
}
