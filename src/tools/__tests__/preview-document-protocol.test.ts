import { describe, expect, it } from "vitest";
import { PREVIEW_DOCUMENT_LIMITS, type PreviewTableDocument } from "../../shared/preview-document.js";
import { readDocumentResponse } from "../preview-document-protocol.js";

function model(): PreviewTableDocument {
  const width = PREVIEW_DOCUMENT_LIMITS.maxColumns;
  const height = Math.min(PREVIEW_DOCUMENT_LIMITS.maxRows, Math.floor(PREVIEW_DOCUMENT_LIMITS.maxReturnedCells / width));
  return {
    format: "xlsx", sheetNames: ["S"], totalSheets: 1, sheetsTruncated: false,
    sheet: {
      index: 0, name: "S", firstRow: 0, firstColumn: 0,
      rows: Array.from({ length: height }, () => Array<string>(width).fill("")),
      totalRows: height, totalColumns: width,
      rowsTruncated: false, columnsTruncated: false, cellsTruncated: false,
    },
  };
}

describe("bounded document model", () => {
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
