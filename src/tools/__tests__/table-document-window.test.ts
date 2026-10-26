import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { parseTableDocument } from "../table-document-reader.js";
import { readDocumentResponse } from "../preview-document-protocol.js";

function sparseWorkbook(bookType: XLSX.BookType): Buffer {
  const sheet: XLSX.WorkSheet = {
    C10001: { t: "s", v: "origin" },
    [XLSX.utils.encode_cell({ r: 10002, c: 207 })]: { t: "s", v: "late" },
    [XLSX.utils.encode_cell({ r: 10003, c: 208 })]: { t: "s", v: "end" },
    "!ref": XLSX.utils.encode_range({ r: 10000, c: 2 }, { r: 10003, c: 208 }),
  };
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Sparse");
  return XLSX.write(book, { type: "buffer", bookType }) as Buffer;
}

describe("source table windows", () => {
  it.each(["xlsx", "biff8", "ods"] as const)("tracks clipped workbook coordinates in %s", async (bookType) => {
    const maxCellChars = 20;
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
      ["header"], ["unchanged", `${"a".repeat(maxCellChars)}tail`, "a".repeat(maxCellChars)],
    ]), "Cells");
    const bytes = XLSX.write(book, { type: "buffer", bookType }) as Buffer;
    const window = { rowOffset: 1, columnOffset: 1, rowCount: 1, columnCount: 2 };
    const document = await parseTableDocument(bytes, bookType === "biff8" ? "xls" : bookType, 0,
      { ...PREVIEW_DOCUMENT_LIMITS, maxCellChars }, window);
    expect(document.sheet.clippedCells).toEqual([{ row: 1, column: 1 }]);
    expect(readDocumentResponse(document, window)).toBe(document);
  });
  it.each(["xlsx", "biff8", "ods"] as const)("reads late rows and columns from %s with the used-range origin", async (bookType) => {
    const format = bookType === "biff8" ? "xls" : bookType;
    const document = await parseTableDocument(sparseWorkbook(bookType), format, 0, PREVIEW_DOCUMENT_LIMITS,
      { rowOffset: 10002, columnOffset: 207, rowCount: 2, columnCount: 2 });
    expect(document.sheet).toMatchObject({
      rows: [["late", ""], ["", "end"]], firstRow: 10002, firstColumn: 207,
      sourceRange: { firstRow: 10000, firstColumn: 2 }, totalRows: 4, totalColumns: 207,
      rowsTruncated: true, columnsTruncated: true,
    });
    expect(readDocumentResponse(document)).toBe(document);
  });

  it.each([
    [{ rowOffset: 1, rowCount: 10, columnCount: 1 }, true],
    [{ rowOffset: 0, rowCount: 1, columnCount: 1 }, false],
  ] as const)("distinguishes fully inspected delimited totals from a look-ahead lower bound: %j", async (window, totalsExact) => {
    const document = await parseTableDocument(Buffer.from("a,b\n1,2\n3,4"), "csv", 0, PREVIEW_DOCUMENT_LIMITS, window);
    expect(document.sheet.sourceRange?.totalsExact).toBe(totalsExact);
    expect(document.sheet.rowsTruncated).toBe(true);
    expect(document.sheet.columnsTruncated).toBe(true);
    expect(readDocumentResponse(document, window)).toBe(document);
  });

  it("resolves omitted offsets to the source used-range origin", async () => {
    const document = await parseTableDocument(sparseWorkbook("xlsx"), "xlsx", 0, PREVIEW_DOCUMENT_LIMITS,
      { rowCount: 1, columnCount: 1 });
    expect(document.sheet).toMatchObject({ firstRow: 10000, firstColumn: 2, rows: [["origin"]],
      sourceRange: { firstRow: 10000, firstColumn: 2 } });
  });

  it("intersects a partially overlapping window and returns an empty disjoint window", async () => {
    const bytes = sparseWorkbook("xlsx");
    const partial = await parseTableDocument(bytes, "xlsx", 0, PREVIEW_DOCUMENT_LIMITS,
      { rowOffset: 9999, columnOffset: 1, rowCount: 2, columnCount: 2 });
    expect(partial.sheet).toMatchObject({ firstRow: 10000, firstColumn: 2, rows: [["origin"]] });
    const empty = await parseTableDocument(bytes, "xlsx", 0, PREVIEW_DOCUMENT_LIMITS,
      { rowOffset: 20000, columnOffset: 500, rowCount: 1, columnCount: 1 });
    expect(empty.sheet.rows).toEqual([]);
    expect(readDocumentResponse(empty)).toBe(empty);
  });

  it.each([
    { rowOffset: 20000, columnOffset: 2, rowCount: 1, columnCount: 1 },
    { rowOffset: 10000, columnOffset: 500, rowCount: 1, columnCount: 1 },
  ])("validates a window disjoint on one axis: %j", async (window) => {
    const document = await parseTableDocument(sparseWorkbook("xlsx"), "xlsx", 0, PREVIEW_DOCUMENT_LIMITS, window);
    expect(document.sheet.rows).toEqual([]);
    expect(readDocumentResponse(document, window)).toBe(document);
  });

  it("validates a delimited window past the final row", async () => {
    const window = { rowOffset: 10, rowCount: 1, columnCount: 2 };
    const document = await parseTableDocument(Buffer.from("a,b"), "csv", 0, PREVIEW_DOCUMENT_LIMITS, window);
    expect(document.sheet.rows).toEqual([]);
    expect(readDocumentResponse(document, window)).toBe(document);
  });

  it("skips quoted multiline and empty records without changing source coordinates", async () => {
    const csv = 'a,b,c\n"one\nline","said ""hi""",x\n\n3,"x,y",\n4,end,z\n';
    const document = await parseTableDocument(Buffer.from(csv), "csv", 0,
      { ...PREVIEW_DOCUMENT_LIMITS, delimitedChunkChars: 8 },
      { rowOffset: 2, columnOffset: 1, rowCount: 2, columnCount: 2 });
    expect(document.sheet).toMatchObject({ rows: [["", ""], ["x,y", ""]], firstRow: 2, firstColumn: 1,
      sourceRange: { firstRow: 0, firstColumn: 0 }, totalRows: 5, totalColumns: 3, rowsTruncated: true });
    expect(readDocumentResponse(document)).toBe(document);
  });

  it("scans to a row after the preview prefix with bounded retained output", async () => {
    const bytes = Buffer.from(`${"prefix,a,b\n".repeat(10001)}late,c,d\nlast,e,f\n`);
    const document = await parseTableDocument(bytes, "csv", 0, PREVIEW_DOCUMENT_LIMITS,
      { rowOffset: 10001, columnOffset: 1, rowCount: 1, columnCount: 2 });
    expect(document.sheet).toMatchObject({ rows: [["c", "d"]], firstRow: 10001, firstColumn: 1,
      totalRows: 10003, sourceRange: { firstRow: 0, firstColumn: 0 } });
  });

  it("does not retain a fake cell for empty delimited input", async () => {
    const document = await parseTableDocument(Buffer.alloc(0), "csv", 0, PREVIEW_DOCUMENT_LIMITS,
      { rowCount: 2, columnCount: 2 });
    expect(document.sheet).toMatchObject({ rows: [], totalRows: 0, totalColumns: 0,
      sourceRange: { firstRow: 0, firstColumn: 0 } });
    expect(readDocumentResponse(document)).toBe(document);
  });

  it.each([
    { rowOffset: -1, rowCount: 1, columnCount: 1 },
    { rowCount: 0, columnCount: 1 },
    { rowCount: 1, columnCount: 1.5 },
    { rowOffset: Number.MAX_SAFE_INTEGER, rowCount: 2, columnCount: 1 },
    { rowCount: 1, columnCount: 1, extra: true },
    { rowCount: 10001, columnCount: 1 },
    { rowCount: 1000, columnCount: 200 },
  ])("refuses malformed or over-budget windows before parsing: %j", async (window) => {
    await expect(parseTableDocument(Buffer.from("a,b"), "csv", 0, PREVIEW_DOCUMENT_LIMITS, window))
      .rejects.toMatchObject({ code: "invalid-index" });
  });
});
