/**
 * Table-document preview contract (CSV / TSV / XLSX / XLS / ODS), shared by the
 * isolated reader (`src/tools/table-document-reader.ts`), the
 * `ave:preview:read-document` IPC handler, and the side-panel renderer.
 *
 * The renderer never receives document bytes: a child parses and returns a
 * bounded grid of display strings. The limits below are the ONE place each cap
 * is written, so the banner the renderer shows quotes the same number the
 * reader enforced.
 */

import type { PreviewPageDocument } from "./preview-page-document.js";

export type PreviewDocumentFormat = "csv" | "tsv" | "xlsx" | "xls" | "ods";

const FORMAT_BY_EXTENSION: ReadonlyMap<string, PreviewDocumentFormat> = new Map([
  ["csv", "csv"],
  ["tsv", "tsv"],
  ["xlsx", "xlsx"],
  ["xls", "xls"],
  ["ods", "ods"],
]);

/**
 * The single path → table-format classifier. The renderer uses it to route a
 * file target to the table viewer; main uses it to pick the parser. `null`
 * means "not a table document" (the text preview path owns it).
 */
export function previewDocumentFormatOf(path: string): PreviewDocumentFormat | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return FORMAT_BY_EXTENSION.get(base.slice(dot + 1).toLowerCase()) ?? null;
}

export interface PreviewDocumentLimits {
  maxFileBytes: number;
  maxUncompressedBytes: number;
  maxArchiveEntries: number;
  maxCompressionRatio: number;
  ratioCheckMinBytes: number;
  maxRows: number;
  maxColumns: number;
  maxReturnedCells: number;
  maxCellChars: number;
  maxSheets: number;
  startupTimeoutMs: number;
  parseTimeoutMs: number;
  maxOldSpaceMb: number;
  maxResponseBytes: number;
  maxConcurrentParses: number;
  frameCheckIntervalMs: number;
  busyRetryDelaysMs: readonly number[];
  maxOdsExpandedRows: number;
  maxOdsExpandedCells: number;
  delimitedChunkChars: number;
}

export const PREVIEW_DOCUMENT_LIMITS: Readonly<PreviewDocumentLimits> = Object.freeze({
  /** On-disk size cap; larger files are refused before any byte is parsed. */
  maxFileBytes: 20 * 1024 * 1024,
  /** Zip containers (xlsx/ods): total inflated bytes across all entries. */
  maxUncompressedBytes: 200 * 1024 * 1024,
  /** Zip containers: entry count. */
  maxArchiveEntries: 10_000,
  /** Zip containers: inflated/compressed ratio for any entry above {@link ratioCheckMinBytes}. */
  maxCompressionRatio: 200,
  ratioCheckMinBytes: 1024 * 1024,
  /** Rows / columns of one sheet returned to the renderer. */
  maxRows: 10_000,
  maxColumns: 200,
  /** Total returned cells, bounding the host's result object graph. */
  maxReturnedCells: 100_000,
  /** Characters kept per cell. */
  maxCellChars: 2_000,
  /** Sheets listed as tabs. */
  maxSheets: 100,
  /** Child startup through the ready marker, before any source is sent. */
  startupTimeoutMs: 5_000,
  /** Parsing and response transport after the child is ready. */
  parseTimeoutMs: 3_000,
  /** Child managed old-space limit; native buffers are bounded separately. */
  maxOldSpaceMb: 256,
  /** Serialized child response; larger grids are refused. */
  maxResponseBytes: 4 * 1024 * 1024,
  maxConcurrentParses: 1,
  /** Observe frame detachment while a document request is active. */
  frameCheckIntervalMs: 100,
  /** Automatic retries after the initial busy response. */
  busyRetryDelaysMs: Object.freeze([250, 500, 1_000]),
  /** Refuse excessive ODF expansion before either workbook pass. */
  maxOdsExpandedRows: 100_000,
  maxOdsExpandedCells: 2_000_000,
  /** Bound delimiter/line detection and eager per-chunk record splitting. */
  delimitedChunkChars: 64 * 1024,
});

/** An absolute source rectangle. Omitted offsets use the used-range origin. */
export interface PreviewTableWindow {
  rowOffset?: number;
  columnOffset?: number;
  rowCount: number;
  columnCount: number;
}

/** Window validation shared by the host, child and parser boundaries. */
export function isPreviewTableWindow(value: unknown, limits: Readonly<PreviewDocumentLimits> = PREVIEW_DOCUMENT_LIMITS): value is PreviewTableWindow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["rowOffset", "columnOffset", "rowCount", "columnCount"].includes(key))) return false;
  for (const key of ["rowOffset", "columnOffset"] as const) {
    if (record[key] !== undefined && (!Number.isSafeInteger(record[key]) || (record[key] as number) < 0)) return false;
  }
  const { rowCount, columnCount } = record;
  return typeof rowCount === "number" && typeof columnCount === "number"
    && Number.isSafeInteger(rowCount) && Number.isSafeInteger(columnCount)
    && rowCount > 0 && rowCount <= limits.maxRows && columnCount > 0 && columnCount <= limits.maxColumns
    && rowCount * columnCount <= limits.maxReturnedCells
    && Number.isSafeInteger(((record.rowOffset as number | undefined) ?? 0) + rowCount)
    && Number.isSafeInteger(((record.columnOffset as number | undefined) ?? 0) + columnCount);
}

/** One sheet's bounded grid. Every cell is a display string. */
export interface PreviewTableSheet {
  index: number;
  name: string;
  /** `rows[r][c]`; every row has exactly `rows[0].length` cells (ragged rows padded). */
  rows: string[][];
  /** 0-based row/column of `rows[0][0]` in the source sheet (for A1 labels). */
  firstRow: number;
  firstColumn: number;
  /** Used-range size; truncated delimited input reports an inspected lower bound. */
  totalRows: number;
  totalColumns: number;
  /** Source used-range origin and count certainty, only for explicit window reads. */
  sourceRange?: { firstRow: number; firstColumn: number; totalsExact: boolean };
  rowsTruncated: boolean;
  columnsTruncated: boolean;
  /** At least one cell was cut to `maxCellChars`. */
  cellsTruncated: boolean;
  /** Absolute source coordinates of returned cells shortened by the parser. */
  clippedCells: { row: number; column: number }[];
}

export interface PreviewTableDocument {
  format: PreviewDocumentFormat;
  /** Workbook requests recalculation; displayed formula caches may be stale. */
  needsRecalculation: boolean;
  /** Sheet tab names, at most `maxSheets` (CSV/TSV: one entry). */
  sheetNames: string[];
  /** Sheets in the source workbook, before the tab cap. */
  totalSheets: number;
  sheetsTruncated: boolean;
  /** The sheet that was requested. */
  sheet: PreviewTableSheet;
}

export type PreviewDocumentError =
  | "unauthorized"
  | "path-not-allowed"
  | "sensitive-path"
  | "not-a-file"
  | "unsupported-format"
  | "too-large"
  | "archive-too-large"
  | "invalid-index"
  | "sheet-not-found"
  | "page-not-found"
  | "renderer-unavailable"
  | "encrypted"
  | "unsupported-encoding"
  | "corrupt-document"
  | "busy"
  | "superseded"
  | "parse-limit"
  | "read-failed";

export type PreviewReadDocumentResult =
  | { ok: true; path: string; bytes: number; document: PreviewTableDocument | PreviewPageDocument;
      editToken?: string; editEnabled?: boolean }
  | { ok: false; error: PreviewDocumentError; path?: string; bytes?: number; message: string };
