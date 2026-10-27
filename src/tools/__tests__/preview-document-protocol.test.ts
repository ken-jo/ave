import { describe, expect, it } from "vitest";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewTableDocument } from "../../shared/preview-document.js";
import { readDocumentResponse } from "../preview-document-protocol.js";

function model(): PreviewTableDocument {
  const width = PREVIEW_DOCUMENT_LIMITS.maxColumns;
  const height = Math.min(PREVIEW_DOCUMENT_LIMITS.maxRows, Math.floor(PREVIEW_DOCUMENT_LIMITS.maxReturnedCells / width));
  return {
    format: "xlsx", needsRecalculation: false, sheetNames: ["S"], totalSheets: 1, sheetsTruncated: false,
    sheet: {
      index: 0, name: "S", firstRow: 0, firstColumn: 0,
      rows: Array.from({ length: height }, () => Array<string>(width).fill("")),
      totalRows: height, totalColumns: width,
      rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [],
    },
  };
}

describe("bounded document model", () => {
  it("requires a boolean recalculation field and rejects it on non-XLSX documents", () => {
    expect(() => readDocumentResponse({ ...model(), needsRecalculation: "true" })).toThrow("preview contract");
    expect(() => readDocumentResponse({ ...model(), format: "csv", needsRecalculation: true })).toThrow("preview contract");
  });
  it("validates the largest returned grid without cloning it in the parent", () => {
    const wire = JSON.stringify(model());
    const before = process.memoryUsage();
    const started = performance.now();
    const parsed: unknown = JSON.parse(wire);
    const validated = readDocumentResponse(parsed);
    const elapsedMs = performance.now() - started;
    const after = process.memoryUsage();
    console.info("parent model validation measurement", {
      bytes: Buffer.byteLength(wire), elapsedMs, rssDeltaBytes: after.rss - before.rss,
    });
    expect(validated).toBe(parsed);
    expect(validated.sheet.rows[0]).toBe((parsed as PreviewTableDocument).sheet.rows[0]);
    expect(elapsedMs).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.parseTimeoutMs / 10);
    expect(after.rss - before.rss).toBeLessThan(PREVIEW_DOCUMENT_LIMITS.maxOldSpaceMb * 1024 * 1024 / 4);
  });

  it("refuses a contract-shaped grid beyond the returned-cell ceiling", () => {
    const document = model();
    document.sheet.rows.push(Array<string>(document.sheet.totalColumns).fill(""));
    document.sheet.totalRows += 1;
    expect(() => readDocumentResponse(document)).toThrow("preview contract");
  });

  it.each([
    (document: PreviewTableDocument) => { document.sheet.rowsTruncated = true; },
    (document: PreviewTableDocument) => { document.sheet.columnsTruncated = true; },
    (document: PreviewTableDocument) => { document.sheet.index = 1; },
    (document: PreviewTableDocument) => { document.sheet.rows[0]!.pop(); },
    (document: PreviewTableDocument) => { document.sheet.rows[0]![0] = "x".repeat(PREVIEW_DOCUMENT_LIMITS.maxCellChars + 2); },
  ])("refuses an inconsistent internal model", (mutate) => {
    const document = model();
    mutate(document);
    expect(() => readDocumentResponse(document)).toThrow("preview contract");
  });
});

describe("window response boundaries", () => {
  function windowModel(): PreviewTableDocument {
    return {
      format: "xlsx", needsRecalculation: false, sheetNames: ["S"], totalSheets: 1, sheetsTruncated: false,
      sheet: {
        index: 0, name: "S", firstRow: 10002, firstColumn: 257,
        sourceRange: { firstRow: 10000, firstColumn: 2, totalsExact: true },
        totalRows: 4, totalColumns: 257, rows: [["late", ""], ["", "end"]],
        rowsTruncated: true, columnsTruncated: true, cellsTruncated: false, clippedCells: [],
      },
    };
  }

  it("accepts a bounded source rectangle with its separate used-range origin", () => {
    const document = windowModel();
    expect(readDocumentResponse(document)).toBe(document);
  });

  it("preserves explicit clipping coordinates without inferring from the display length", () => {
    const document = windowModel();
    document.sheet.rows[0]![0] = `${"a".repeat(1999)}…`;
    document.sheet.cellsTruncated = true;
    document.sheet.clippedCells = [{ row: 10002, column: 257 }];
    expect(readDocumentResponse(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });

  it.each([
    (document: PreviewTableDocument) => { Reflect.deleteProperty(document.sheet, "clippedCells"); },
    (document: PreviewTableDocument) => { document.sheet.cellsTruncated = true; },
    (document: PreviewTableDocument) => { document.sheet.clippedCells = [{ row: 10002, column: 257 }]; },
    (document: PreviewTableDocument) => { document.sheet.cellsTruncated = true; document.sheet.clippedCells = [{ row: 10004, column: 257 }]; },
    (document: PreviewTableDocument) => { document.sheet.cellsTruncated = true; document.sheet.clippedCells = [{ row: 10002, column: 259 }]; },
    (document: PreviewTableDocument) => { document.sheet.cellsTruncated = true; document.sheet.clippedCells = [{ row: 10002.5, column: 257 }]; },
    (document: PreviewTableDocument) => { document.sheet.cellsTruncated = true; document.sheet.clippedCells = [{ row: 10002, column: 257 }, { row: 10002, column: 257 }]; },
    (document: PreviewTableDocument) => { document.sheet.cellsTruncated = true; document.sheet.clippedCells = [Object.assign({ row: 10002, column: 257 }, { extra: true })]; },
  ])("refuses malformed or inconsistent cell clipping provenance", (mutate) => {
    const document = windowModel();
    mutate(document);
    expect(() => readDocumentResponse(document)).toThrow("preview contract");
  });

  it.each([
    (document: PreviewTableDocument) => { document.sheet.sourceRange!.firstRow = -1; },
    (document: PreviewTableDocument) => { Reflect.deleteProperty(document.sheet.sourceRange!, "totalsExact"); },
    (document: PreviewTableDocument) => { document.sheet.sourceRange!.totalsExact = false; },
    (document: PreviewTableDocument) => { document.sheet.sourceRange!.firstColumn = 258; },
    (document: PreviewTableDocument) => { document.sheet.totalRows = 3; },
    (document: PreviewTableDocument) => { document.sheet.firstColumn = Number.MAX_SAFE_INTEGER; },
    (document: PreviewTableDocument) => { Object.assign(document.sheet.sourceRange!, { extra: true }); },
    (document: PreviewTableDocument) => { document.sheet.rows[1]!.push("extra"); },
  ])("refuses malformed window geometry and origin", (mutate) => {
    const document = windowModel();
    mutate(document);
    expect(() => readDocumentResponse(document)).toThrow("preview contract");
  });
});
