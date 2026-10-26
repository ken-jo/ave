import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument } from "../shared/preview-page-document.js";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewTableDocument } from "../shared/preview-document.js";
import { estimateTokens } from "../shared/token-estimate.js";
import { DOCUMENT_TOOL_LIMITS, type ReadDocumentSelection } from "./document-tool-input.js";
import type { ToolExecutionResult } from "./types.js";

interface DocumentWindow {
  rowOffset: number;
  columnOffset: number;
  rowCount: number;
  columnCount: number;
}

function fits(output: string): boolean {
  return output.length <= DOCUMENT_TOOL_LIMITS.maxOutputChars
    && Buffer.byteLength(output, "utf8") <= DOCUMENT_TOOL_LIMITS.maxOutputBytes
    && estimateTokens(output) <= DOCUMENT_TOOL_LIMITS.maxEstimatedTokens
    && output.split("\n").length <= DOCUMENT_TOOL_LIMITS.maxOutputLines;
}

export function documentToolFailure(error: string, message = "Document request failed"): ToolExecutionResult {
  const output = JSON.stringify({ ok: false, error, message, retryable: error === "busy" });
  return { output: fits(output) ? output : '{"ok":false,"error":"parse-limit","message":"Document result exceeds the context budget","retryable":false}', isError: true };
}

function success(value: unknown): ToolExecutionResult {
  const output = JSON.stringify(value);
  return fits(output) ? { output, isError: false } : documentToolFailure("parse-limit", "Document metadata exceeds the context budget");
}

function safeEnd(text: string, end: number): number {
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) return end - 1;
  return end;
}

function label(name: string): { name: string; nameTruncated: boolean } {
  const end = safeEnd(name, Math.min(name.length, DOCUMENT_TOOL_LIMITS.maxLabelChars));
  return { name: name.slice(0, end), nameTruncated: end < name.length };
}

function remainingWindows(window: DocumentWindow, rows: number, columns: number): DocumentWindow[] {
  const remaining: DocumentWindow[] = [];
  if (rows > 0 && columns < window.columnCount) remaining.push({
    rowOffset: window.rowOffset, columnOffset: window.columnOffset + columns,
    rowCount: rows, columnCount: window.columnCount - columns,
  });
  if (rows < window.rowCount && window.columnCount > 0) remaining.push({
    rowOffset: window.rowOffset + rows, columnOffset: window.columnOffset,
    rowCount: window.rowCount - rows, columnCount: window.columnCount,
  });
  return remaining;
}

function formatSheet(path: string, document: PreviewTableDocument, selection: Extract<ReadDocumentSelection, { kind: "sheet" }>): ToolExecutionResult {
  const sheet = document.sheet;
  const source = sheet.sourceRange ?? { firstRow: sheet.firstRow, firstColumn: sheet.firstColumn };
  const delimited = document.format === "csv" || document.format === "tsv";
  const totalsExact = sheet.sourceRange?.totalsExact ?? !(delimited && (sheet.rowsTruncated || sheet.columnsTruncated));
  const sourceUninspected = delimited && !totalsExact;
  const requestedWindow: DocumentWindow = {
    rowOffset: selection.rowOffset ?? source.firstRow,
    columnOffset: selection.columnOffset ?? source.firstColumn,
    rowCount: selection.rowCount,
    columnCount: selection.columnCount,
  };
  const rowOffset = Math.max(requestedWindow.rowOffset, sheet.firstRow);
  const columnOffset = Math.max(requestedWindow.columnOffset, sheet.firstColumn);
  const rowEnd = Math.min(requestedWindow.rowOffset + requestedWindow.rowCount, sheet.firstRow + sheet.rows.length);
  const columnEnd = Math.min(requestedWindow.columnOffset + requestedWindow.columnCount, sheet.firstColumn + (sheet.rows[0]?.length ?? 0));
  const available: DocumentWindow = { rowOffset, columnOffset, rowCount: Math.max(0, rowEnd - rowOffset), columnCount: Math.max(0, columnEnd - columnOffset) };
  if (available.rowCount === 0 || available.columnCount === 0) { available.rowCount = 0; available.columnCount = 0; }
  let rows = available.rowCount;
  let columns = available.columnCount;
  let cellLimit = PREVIEW_DOCUMENT_LIMITS.maxCellChars + 1;
  const build = (): string => {
    const clippedCells: { row: number; column: number }[] = [];
    let contextClipped = false;
    const cells = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => {
      const cell = sheet.rows[rowOffset - sheet.firstRow + r]![columnOffset - sheet.firstColumn + c]!;
      const end = safeEnd(cell, Math.min(cell.length, cellLimit));
      const clipped = end < cell.length || (sheet.cellsTruncated && cell.length > PREVIEW_DOCUMENT_LIMITS.maxCellChars);
      if (end < cell.length) contextClipped = true;
      if (clipped) clippedCells.push({ row: rowOffset + r, column: columnOffset + c });
      return end < cell.length ? `${cell.slice(0, end)}…` : cell;
    }));
    const remaining = remainingWindows(available, rows, columns);
    return JSON.stringify({ ok: true, path, format: document.format,
      sheet: { index: sheet.index, ...label(sheet.name) },
      usedRange: { firstRow: source.firstRow, firstColumn: source.firstColumn,
        totalRows: sheet.totalRows, totalColumns: sheet.totalColumns, totalsExact },
      requestedWindow, returnedWindow: { rowOffset, columnOffset, rowCount: rows, columnCount: columns }, cells,
      truncation: { context: remaining.length > 0 || contextClipped,
        parser: sheet.cellsTruncated || sourceUninspected || (!sheet.sourceRange && (sheet.rowsTruncated || sheet.columnsTruncated)),
        sourceUninspected, clippedCells },
      remainingWindows: remaining });
  };
  let output = build();
  while (!fits(output) && columns > 1) { columns--; output = build(); }
  while (!fits(output) && rows > 1) { rows--; output = build(); }
  if (!fits(output) && rows === 1 && columns === 1) {
    let low = 0;
    let high = cellLimit;
    while (low < high) {
      cellLimit = Math.ceil((low + high) / 2);
      if (fits(build())) low = cellLimit; else high = cellLimit - 1;
    }
    cellLimit = low;
    output = build();
  }
  return fits(output) ? { output, isError: false } : documentToolFailure("parse-limit", "Document metadata exceeds the context budget");
}

function formatPage(path: string, document: PreviewPageDocument, selection: Extract<ReadDocumentSelection, { kind: "page" }>): ToolExecutionResult {
  const text = document.page.paragraphs.join("\n");
  const offset = selection.textOffset;
  if (offset > text.length || safeEnd(text, offset) !== offset) return documentToolFailure("invalid-index", "Text offset is outside a Unicode text boundary");
  const imageData = selection.includeImage ? document.page.png : null;
  const imageBytes = imageData ? Buffer.byteLength(imageData, "base64") : 0;
  if (imageBytes > PAGE_PREVIEW_LIMITS.maxPngBytes) return documentToolFailure("parse-limit", "Page image exceeds the image budget");
  const build = (length: number): string => {
    const end = safeEnd(text, Math.min(text.length, offset + length));
    return JSON.stringify({ ok: true, path, format: document.format, page: document.page.index + 1,
      totalPages: document.totalPages, pagesTruncated: document.pagesTruncated,
      text: text.slice(offset, end), textAvailable: text.length > 0, textOffset: offset,
      nextTextOffset: end < text.length ? end : null,
      nextPage: end === text.length && document.page.index + 1 < Math.min(document.totalPages, PAGE_PREVIEW_LIMITS.maxPages) ? document.page.index + 2 : null,
      textTruncated: document.page.textTruncated,
      ...(selection.includeImage ? { image: { available: imageData !== null, bytes: imageBytes, maxBytes: PAGE_PREVIEW_LIMITS.maxPngBytes } } : {}) });
  };
  let low = 0;
  let high = Math.min(text.length - offset, DOCUMENT_TOOL_LIMITS.maxOutputChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(build(middle))) low = middle; else high = middle - 1;
  }
  const output = build(low);
  if (!fits(output) || (offset < text.length && safeEnd(text, offset + low) === offset)) return documentToolFailure("parse-limit", "Document metadata exceeds the context budget");
  return { output, isError: false, ...(imageData ? { image: { data: imageData, mimeType: "image/png", bytes: imageBytes, width: document.page.width, height: document.page.height } } : {}) };
}

export function formatDocumentToolOutput(path: string, document: PreviewTableDocument | PreviewPageDocument, selection?: ReadDocumentSelection): ToolExecutionResult {
  if (selection?.kind === "info") {
    if ("sheet" in document) {
      const end = Math.min(document.sheetNames.length, selection.sheetOffset + DOCUMENT_TOOL_LIMITS.maxSheetNames);
      return success({ ok: true, path, format: document.format, totalSheets: document.totalSheets,
        accessibleSheets: document.sheetNames.length, sheetsTruncated: document.sheetsTruncated,
        sheets: document.sheetNames.slice(selection.sheetOffset, end).map((name, i) => ({ index: selection.sheetOffset + i, ...label(name) })),
        nextSheetOffset: end < document.sheetNames.length ? end : null });
    }
    return success({ ok: true, path, format: document.format, totalPages: document.totalPages,
      accessiblePages: Math.min(document.totalPages, PAGE_PREVIEW_LIMITS.maxPages), pagesTruncated: document.pagesTruncated });
  }
  if ("sheet" in document) {
    if (selection?.kind === "page") return documentToolFailure("invalid-arguments", "Page selection requires a page document");
    return formatSheet(path, document, selection ?? { kind: "sheet", sheet: 0, rowCount: DOCUMENT_TOOL_LIMITS.defaultRows, columnCount: DOCUMENT_TOOL_LIMITS.defaultColumns });
  }
  if (selection?.kind === "sheet") return documentToolFailure("invalid-arguments", "Sheet selection requires a table document");
  return formatPage(path, document, selection ?? { kind: "page", page: 1, textOffset: 0, includeImage: false });
}
