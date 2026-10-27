import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PreviewTableDocument } from "../../shared/preview-document.js";
import type { PreviewPageDocument } from "../../shared/preview-page-document.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import { OpenDocumentInputSchema, ReadDocumentInputSchema } from "../document-tool-input.js";
import { formatDocumentToolOutput } from "../document-tool-output.js";

function table(rows: string[][], firstRow = 0, firstColumn = 0): PreviewTableDocument {
  return { format: "xlsx", needsRecalculation: false, sheetNames: ["Sheet"], totalSheets: 1, sheetsTruncated: false,
    sheet: { index: 0, name: "Sheet", rows, firstRow, firstColumn, totalRows: rows.length,
      totalColumns: rows[0]?.length ?? 0, rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [] } };
}

function page(text: string): PreviewPageDocument {
  return { format: "pdf", totalPages: 2, pagesTruncated: false,
    page: { index: 0, paragraphs: [text], textTruncated: false, png: "iVBORw0KGgo=", width: 3, height: 4 } };
}

function bounded(output: string): void {
  expect(output.length).toBeLessThanOrEqual(6000);
  expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024);
  expect(estimateTokens(output)).toBeLessThanOrEqual(1800);
  expect(output.split("\n").length).toBeLessThanOrEqual(100);
  expect(() => JSON.parse(output)).not.toThrow();
}

describe("document tool schemas", () => {
  it("defaults each selector and rejects aliases, extra keys and invalid windows", () => {
    expect(ReadDocumentInputSchema.parse({ path: "book.xlsx", selection: { kind: "sheet" } }).selection)
      .toEqual({ kind: "sheet", sheet: 0, rowCount: 20, columnCount: 10 });
    expect(ReadDocumentInputSchema.parse({ path: "book.pdf", selection: { kind: "page" } }).selection)
      .toEqual({ kind: "page", page: 1, textOffset: 0, includeImage: false });
    expect(ReadDocumentInputSchema.parse({ path: "book.xlsx", selection: { kind: "info" } }).selection)
      .toEqual({ kind: "info", sheetOffset: 0 });
    for (const selection of [{ kind: "sheet", rowCount: 101 }, { kind: "sheet", columnCount: 51 },
      { kind: "sheet", rowCount: 100, columnCount: 6 }, { kind: "sheet", rowOffset: -1 },
      { kind: "sheet", columnOffset: Number.MAX_SAFE_INTEGER + 1 }, { kind: "sheet", rowCount: 1.5 },
      { kind: "sheet", rowOffset: Number.MAX_SAFE_INTEGER },
      { kind: "sheet", range: "A1:B2" }, { kind: "page", page: 0 }]) {
      expect(ReadDocumentInputSchema.safeParse({ path: "book.xlsx", selection }).success).toBe(false);
    }
    expect(ReadDocumentInputSchema.safeParse({ path: "a", unknown: true }).success).toBe(false);
    expect(OpenDocumentInputSchema.safeParse({ path: "a", selection: {} }).success).toBe(false);
  });

  it("projects a strict tool schema while retaining runtime cell-count validation", () => {
    const schema = z.toJSONSchema(ReadDocumentInputSchema);
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toHaveProperty("selection");
    expect(z.toJSONSchema(OpenDocumentInputSchema).required).toEqual(["path"]);
  });
});

describe("document context output", () => {
  it("preserves sparse coordinates and intersects a requested window", () => {
    const document = table([["a", "", "c"], ["d", "e", "f"]], 40, 8);
    const result = formatDocumentToolOutput("/book.xlsx", document);
    expect(result.isError).toBe(false);
    const envelope = JSON.parse(result.output);
    expect(envelope.usedRange).toMatchObject({ firstRow: 40, firstColumn: 8 });
    expect(envelope.returnedWindow).toEqual({ rowOffset: 40, columnOffset: 8, rowCount: 2, columnCount: 3 });
    expect(envelope.cells).toEqual(document.sheet.rows);
    bounded(result.output);
  });

  it("provides disjoint continuations that cover every omitted cell", () => {
    const rows = Array.from({ length: 20 }, (_, r) => Array.from({ length: 10 }, (_, c) => `${r}:${c} ${"x".repeat(600)}`));
    const result = formatDocumentToolOutput("/book.xlsx", table(rows));
    const value = JSON.parse(result.output);
    const windows = [value.returnedWindow, ...value.remainingWindows];
    const counts = new Map<string, number>();
    for (const w of windows) for (let r = w.rowOffset; r < w.rowOffset + w.rowCount; r++) {
      for (let c = w.columnOffset; c < w.columnOffset + w.columnCount; c++) {
        const key = `${r}:${c}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    expect(counts.size).toBe(200);
    expect([...counts.values()].every(count => count === 1)).toBe(true);
    expect(value.remainingWindows.length).toBeLessThanOrEqual(2);
    expect(value.truncation.context).toBe(true);
    bounded(result.output);
  });

  it("uses original used-range coordinates on explicit parser windows", () => {
    const document = table([["a", "b"]], 44, 9);
    document.sheet.sourceRange = { firstRow: 40, firstColumn: 8, totalsExact: true };
    document.sheet.totalRows = 50;
    document.sheet.totalColumns = 20;
    const result = formatDocumentToolOutput("/book.xlsx", document, { kind: "sheet", sheet: 0, rowOffset: 44, columnOffset: 9, rowCount: 1, columnCount: 2 });
    const value = JSON.parse(result.output);
    expect(value.usedRange).toEqual({ firstRow: 40, firstColumn: 8, totalRows: 50, totalColumns: 20, totalsExact: true });
    expect(value.returnedWindow).toEqual({ rowOffset: 44, columnOffset: 9, rowCount: 1, columnCount: 2 });
    expect(value.remainingWindows).toEqual([]);
  });

  it("distinguishes ordinary window omission from uninspected delimited source", () => {
    const document = table([["value"]], 40, 8);
    document.format = "csv";
    document.sheet.rowsTruncated = true;
    document.sheet.columnsTruncated = true;
    document.sheet.sourceRange = { firstRow: 0, firstColumn: 0, totalsExact: true };
    const selection = { kind: "sheet" as const, sheet: 0, rowOffset: 40, columnOffset: 8, rowCount: 1, columnCount: 1 };
    const complete = JSON.parse(formatDocumentToolOutput("/book.csv", document, selection).output);
    expect(complete.usedRange.totalsExact).toBe(true);
    expect(complete.truncation).toMatchObject({ parser: false, sourceUninspected: false });
    document.sheet.sourceRange.totalsExact = false;
    const incomplete = JSON.parse(formatDocumentToolOutput("/book.csv", document, selection).output);
    expect(incomplete.usedRange.totalsExact).toBe(false);
    expect(incomplete.truncation).toMatchObject({ parser: true, sourceUninspected: true });
  });

  it("keeps empty windows successful and records parser clipping separately", () => {
    const document = table([[`${"a".repeat(2000)}…`]]);
    document.sheet.cellsTruncated = true;
    document.sheet.clippedCells = [{ row: 0, column: 0 }];
    const value = JSON.parse(formatDocumentToolOutput("/book.xlsx", document).output);
    expect(value.truncation).toMatchObject({ context: false, parser: true, clippedCells: [{ row: 0, column: 0 }] });
    const empty = JSON.parse(formatDocumentToolOutput("/book.xlsx", document,
      { kind: "sheet", sheet: 0, rowOffset: 10, rowCount: 20, columnCount: 10 }).output);
    expect(empty.cells).toEqual([]);
    expect(empty.remainingWindows).toEqual([]);
  });

  it("bounds escaped multiline cells, Unicode and huge paths while retaining valid JSON", () => {
    for (const text of ["한".repeat(2000), "😀".repeat(1000), '"\\\n'.repeat(700)]) {
      const result = formatDocumentToolOutput("/book.xlsx", table([[text]]));
      expect(result.isError).toBe(false);
      bounded(result.output);
    }
    const result = formatDocumentToolOutput("x".repeat(10000), table([["value"]]));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toBe("parse-limit");
    bounded(result.output);
    const clipped = JSON.parse(formatDocumentToolOutput("/book.xlsx", table([['"'.repeat(5000)]])).output);
    expect(clipped.truncation.clippedCells).toEqual([{ row: 0, column: 0 }]);
    expect(clipped.cells[0][0].endsWith("…")).toBe(true);
  });

  it("paginates text without splitting surrogate pairs or skipping text", () => {
    const text = "😀한\n\"".repeat(2000);
    let offset = 0;
    let restored = "";
    do {
      const result = formatDocumentToolOutput("/book.pdf", page(text), { kind: "page", page: 1, textOffset: offset, includeImage: false });
      const value = JSON.parse(result.output);
      expect(value.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      restored += value.text;
      if (value.nextTextOffset === null) break;
      expect(value.nextTextOffset).toBeGreaterThan(offset);
      expect(value.nextPage).toBeNull();
      offset = value.nextTextOffset;
      bounded(result.output);
    } while (offset < text.length);
    expect(restored).toBe(text);
    const invalid = formatDocumentToolOutput("/book.pdf", page("😀"), { kind: "page", page: 1, textOffset: 1, includeImage: false });
    expect(JSON.parse(invalid.output).error).toBe("invalid-index");
  });

  it("carries existing page PNG through typed image content only on request", () => {
    const document = page("text");
    expect(formatDocumentToolOutput("/book.pdf", document).image).toBeUndefined();
    const result = formatDocumentToolOutput("/book.pdf", document, { kind: "page", page: 1, textOffset: 0, includeImage: true });
    expect(result.image).toEqual({ data: document.page.png, mimeType: "image/png", bytes: 8, width: 3, height: 4 });
    expect(result.output).not.toContain(document.page.png);
    expect(JSON.parse(result.output).image).toMatchObject({ bytes: 8, maxBytes: 2 * 1024 * 1024 });
    document.page.png = Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64");
    expect(formatDocumentToolOutput("/book.pdf", document, { kind: "page", page: 1, textOffset: 0, includeImage: true }).isError).toBe(true);
  });

  it("paginates ten sheet names and exposes lower-bound counts", () => {
    const document = table([["value"]]);
    document.sheetNames = Array.from({ length: 24 }, (_, i) => `Sheet ${i}`);
    document.totalSheets = 30;
    document.sheetsTruncated = true;
    const result = formatDocumentToolOutput("/book.xlsx", document, { kind: "info", sheetOffset: 10 });
    const value = JSON.parse(result.output);
    expect(value.sheets).toHaveLength(10);
    expect(value.sheets[0]).toEqual({ index: 10, name: "Sheet 10", nameTruncated: false });
    expect(value.nextSheetOffset).toBe(20);
    expect(value.accessibleSheets).toBe(24);
    expect(value.sheetsTruncated).toBe(true);
    bounded(result.output);
    document.sheetNames = ["😀".repeat(500)];
    const longName = JSON.parse(formatDocumentToolOutput("/book.xlsx", document, { kind: "info", sheetOffset: 0 }).output);
    expect(longName.sheets[0].nameTruncated).toBe(true);
    expect(longName.sheets[0].name).not.toMatch(/[\uD800-\uDBFF]$/u);
    const pageInfo = formatDocumentToolOutput("/book.pdf", page("text"), { kind: "info", sheetOffset: 0 });
    expect(pageInfo.image).toBeUndefined();
    expect(JSON.parse(pageInfo.output)).toMatchObject({ totalPages: 2, accessiblePages: 2 });
  });
});
