/**
 * Table-document reader (CSV / TSV / XLSX / XLS / ODS → bounded display grid).
 *
 * A disposable child parses; the renderer only ever receives the
 * {@link PreviewTableDocument} this returns. Every cap comes from
 * {@link PREVIEW_DOCUMENT_LIMITS}; a cap that cuts data sets a truncation flag
 * the viewer shows, and a cap that cannot be honoured safely (file size, zip
 * bomb) refuses the document with a {@link TableDocumentError}.
 *
 * This module belongs to the child entry, outside the host's execution graph.
 *
 * Formulas are never evaluated: the workbook parser returns cached values only
 * (`cellFormula: false`), macros are not read (`bookVBA: false`), and every
 * value leaves as plain text.
 */
import { Readable } from "node:stream";
import Papa from "papaparse";
import * as XLSX from "xlsx";
import * as cptable from "xlsx/dist/cpexcel.full.mjs";

import {
  PREVIEW_DOCUMENT_LIMITS,
  type PreviewDocumentFormat,
  type PreviewDocumentLimits,
  type PreviewTableDocument,
  type PreviewTableSheet,
} from "../shared/preview-document.js";
import { errorMessage } from "../shared/error-message.js";
import { prepareWorkbookContainer } from "./workbook-container.js";
import { TableDocumentError } from "./table-document-error.js";

export { TableDocumentError } from "./table-document-error.js";

// Legacy .xls stores text in Windows code pages (cp949, cp1252, …).
XLSX.set_cptable(cptable);

export type TableDocumentLimits = Readonly<PreviewDocumentLimits>;

function clipCell(value: string, limits: TableDocumentLimits): { text: string; clipped: boolean } {
  if (value.length <= limits.maxCellChars) return { text: value, clipped: false };
  return { text: `${value.slice(0, limits.maxCellChars)}…`, clipped: true };
}

/** Decode only requested chunks; an aborted preview leaves the suffix untouched. */
function* decodeDelimitedChunks(bytes: Uint8Array, chunkBytes: number): Generator<string> {
  let encoding = "utf-8";
  let firstByte = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) firstByte = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = "utf-16le";
    firstByte = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = "utf-16be";
    firstByte = 2;
  }
  const decoder = new TextDecoder(encoding, { fatal: true });
  try {
    for (let offset = firstByte; offset < bytes.length; offset += chunkBytes) {
      const text = decoder.decode(bytes.subarray(offset, offset + chunkBytes), { stream: true });
      if (text.length > 0) yield text;
    }
    const text = decoder.decode();
    if (text.length > 0) yield text;
  } catch {
    throw new TableDocumentError(
      "unsupported-encoding",
      "Text does not match its UTF-8 or byte-order-mark encoding.",
    );
  }
}

function readDelimitedSample(decoded: Generator<string>, maxChars: number): {
  text: string;
  chunks: string[];
  continues: boolean;
} {
  let text = "";
  const chunks: string[] = [];
  while (text.length < maxChars) {
    const next = decoded.next();
    if (next.done) return { text, chunks, continues: false };
    chunks.push(next.value);
    const remaining = maxChars - text.length;
    text += next.value.slice(0, remaining);
    if (next.value.length > remaining) return { text, chunks, continues: true };
  }
  // Preserve one bounded peek so exact-boundary EOF is distinguishable.
  const next = decoded.next();
  if (!next.done) chunks.push(next.value);
  return { text, chunks, continues: !next.done };
}

/** Validate only complete inspected records, before permissive field decoding. */
function validateDelimitedRecord(record: string, delimiter: string, newline: string, format: "csv" | "tsv"): void {
  if (record.endsWith(newline)) record = record.slice(0, -newline.length);
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  for (const character of record) {
    if (state === "quoted") {
      if (character === '"') state = "closed";
    } else if (state === "closed") {
      if (character === '"') state = "quoted";
      else if (character === delimiter) state = "start";
      else throw new TableDocumentError("corrupt-document", "Unexpected text after a quoted field.");
    } else if (character === delimiter) state = "start";
    else if (character === "\r" || character === "\n") {
      throw new TableDocumentError("corrupt-document", "Unexpected line break inside a field.");
    } else if (character === '"') {
      // IANA text/tab-separated-values defines no quoting, so a mid-field quote is literal text.
      if (state === "start") state = "quoted";
      else if (format === "csv") throw new TableDocumentError("corrupt-document", "Quote inside an unquoted field.");
    } else state = "plain";
  }
  if (state === "quoted") throw new TableDocumentError("corrupt-document", "Unterminated quoted field.");
}

async function parseDelimited(
  bytes: Uint8Array,
  format: "csv" | "tsv",
  limits: TableDocumentLimits,
): Promise<PreviewTableSheet> {
  const kept: { cells: string[]; clipped: boolean }[] = [];
  let totalRows = 0;
  let totalColumns = 0;
  const sampleChars = Math.max(1, limits.delimitedChunkChars);
  const decoded = decodeDelimitedChunks(bytes, sampleChars);
  let buffered: string[];
  let newline: NonNullable<Papa.ParseConfig["newline"]>;
  let delimiter: string;
  try {
    const sample = readDelimitedSample(decoded, sampleChars);
    buffered = sample.chunks;
    if (sample.continues && sample.text.endsWith("\r")) {
      throw new TableDocumentError("parse-limit", "Initial record boundary exceeds the detection budget.");
    }
    const detectedNewline = Papa.parse<string[]>(sample.text, { delimiter: "\t", preview: 1 }).meta.linebreak;
    if (detectedNewline !== "\n" && detectedNewline !== "\r" && detectedNewline !== "\r\n") {
      throw new TableDocumentError("read-failed", "Parser returned an unsupported line ending.");
    }
    newline = detectedNewline;
    // Detection ignores a terminal separator without removing any source record.
    delimiter = format === "tsv" ? "\t" : Papa.parse<string[]>(sample.text.replace(/\r\n$|[\r\n]$/, ""), {
      newline,
      preview: 1,
    }).meta.delimiter;
    if (sample.continues) {
      let initialRecordComplete = false;
      Papa.parse<string[]>(sample.text, {
        delimiter,
        newline,
        step: (result, parser) => {
          if (result.errors.some((error) => error.code !== "UndetectableDelimiter" && error.code !== "MissingQuotes")) {
            throw new TableDocumentError("corrupt-document", "Malformed delimited document.");
          }
          const end = result.meta.cursor;
          initialRecordComplete = result.errors.every((error) => error.code === "UndetectableDelimiter")
            && sample.text.slice(end - newline.length, end) === newline;
          parser.abort();
        },
      });
      if (!initialRecordComplete) {
        throw new TableDocumentError("parse-limit", "Initial record exceeds the detection budget.");
      }
    }
  } catch (error) {
    decoded.return(undefined);
    throw error;
  }
  let inspectionBuffer = "";
  let inspectedCharacters = 0;
  function* chunks(): Generator<string> {
    try {
      for (const chunk of buffered) {
        inspectionBuffer += chunk;
        yield chunk;
      }
      for (const chunk of decoded) {
        inspectionBuffer += chunk;
        yield chunk;
      }
    } finally {
      decoded.return(undefined);
    }
  }
  const source = Readable.from(chunks(), {
    objectMode: false,
    encoding: "utf8",
    // At most one decoded chunk is buffered ahead of the active parse.
    highWaterMark: 1,
  });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      if (error !== undefined) reject(error);
      else resolve();
    };
    try {
      Papa.parse<string[]>(source, {
        delimiter,
        newline,
        skipEmptyLines: false,
        step: (result, parser) => {
          // A one-column document need not have a detectable delimiter.
          if (result.errors.some((error) => error.code !== "UndetectableDelimiter")) {
            finish(new TableDocumentError("corrupt-document", "Malformed delimited document."));
            parser.abort();
            return;
          }
          const consumed = result.meta.cursor - inspectedCharacters;
          try {
            if (consumed < 0 || consumed > inspectionBuffer.length) {
              throw new TableDocumentError("read-failed", "Delimited record cursor is invalid.");
            }
            validateDelimitedRecord(inspectionBuffer.slice(0, consumed), delimiter, newline, format);
            inspectionBuffer = inspectionBuffer.slice(consumed);
            inspectedCharacters = result.meta.cursor;
          } catch (error) {
            finish(error);
            parser.abort();
            return;
          }
          const row = result.data;
          totalRows += 1;
          totalColumns = Math.max(totalColumns, row.length);
          const width = Math.min(totalColumns, limits.maxColumns);
          const rowLimit = Math.min(limits.maxRows, Math.floor(limits.maxReturnedCells / width));
          // A wider observed record can shrink the retained prefix.
          if (kept.length > rowLimit) kept.length = rowLimit;
          if (totalRows > rowLimit) {
            finish();
            parser.abort();
            return;
          }
          let clipped = false;
          const cells = row.slice(0, limits.maxColumns).map((cell) => {
            const value = clipCell(cell, limits);
            clipped ||= value.clipped;
            return value.text;
          });
          kept.push({ cells, clipped });
        },
        complete: () => finish(),
        error: (error) => finish(error),
      });
    } catch (error) {
      finish(error);
    }
  });
  const width = Math.min(totalColumns, limits.maxColumns);
  const rows = kept.map(({ cells }) => (cells.length < width ? [...cells, ...Array<string>(width - cells.length).fill("")] : cells));
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
    cellsTruncated: kept.some((row) => row.clipped),
  };
}

function workbookError(err: unknown): TableDocumentError {
  const message = errorMessage(err);
  if (/password|encrypt/i.test(message)) return new TableDocumentError("encrypted", message);
  return new TableDocumentError("corrupt-document", message);
}

function parseWorkbook(
  bytes: Buffer,
  format: "xlsx" | "xls" | "ods",
  sheetIndex: number,
  limits: TableDocumentLimits,
): Omit<PreviewTableDocument, "format"> {
  const checkedBytes = prepareWorkbookContainer(bytes, format, limits, sheetIndex);
  const common: XLSX.ParsingOptions = {
    type: "buffer",
    cellFormula: false,
    cellHTML: false,
    cellStyles: false,
    bookVBA: false,
  };
  let allNames: string[];
  try {
    allNames = XLSX.read(checkedBytes, { ...common, bookSheets: true }).SheetNames;
  } catch (err) {
    throw workbookError(err);
  }
  const sheetNames = allNames.slice(0, limits.maxSheets).map((name) => clipCell(name, limits).text);
  const sourceName = allNames[sheetIndex];
  const name = sheetNames[sheetIndex];
  if (sourceName === undefined || name === undefined) {
    throw new TableDocumentError("sheet-not-found", `sheet ${sheetIndex} of ${sheetNames.length}`);
  }
  let worksheet: XLSX.WorkSheet | undefined;
  try {
    // Sparse storage avoids allocating empty rows before a late used range.
    // Absolute sheetRows would silently discard e.g. the only cell at A10001.
    // The child heap/deadline contains the parse; the window below is relative.
    // An index selects exactly the worksheet the container scan checked; a
    // name would also select any case-insensitive duplicate.
    worksheet = XLSX.read(checkedBytes, { ...common, dense: false, sheets: [sheetIndex] }).Sheets[sourceName];
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
export async function parseTableDocument(
  bytes: Buffer,
  format: PreviewDocumentFormat,
  sheetIndex: number,
  limits: TableDocumentLimits = PREVIEW_DOCUMENT_LIMITS,
): Promise<PreviewTableDocument> {
  if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0) {
    throw new TableDocumentError("invalid-index", `sheet index ${String(sheetIndex)} is not a non-negative integer`);
  }
  if (bytes.length > limits.maxFileBytes) {
    throw new TableDocumentError("too-large", `${bytes.length} bytes exceeds ${limits.maxFileBytes}`);
  }
  if (format === "csv" || format === "tsv") {
    if (sheetIndex !== 0) throw new TableDocumentError("sheet-not-found", `${format} has one sheet`);
    const sheet = await parseDelimited(bytes, format, limits);
    return { format, sheetNames: [sheet.name], totalSheets: 1, sheetsTruncated: false, sheet };
  }
  return { format, ...parseWorkbook(bytes, format, sheetIndex, limits) };
}
