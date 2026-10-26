import { expect, it } from "vitest";
import { parseTableDocument } from "../table-document-reader.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { parsePageDocument } from "../page-document-reader.js";
import { presentationFixture } from "../../__tests__/support/page-document-fixtures.js";
import { formatDocumentToolOutput } from "../document-tool-output.js";
import { readDocumentResponse } from "../preview-document-protocol.js";

it("clips a document cell without introducing an unpaired surrogate", async () => {
  const result = await parseTableDocument(Buffer.from(`${"a".repeat(1999)}😀tail`), "csv", 0,
    PREVIEW_DOCUMENT_LIMITS, { rowCount: 1, columnCount: 1 });
  const cell = result.sheet.rows[0]![0]!;
  expect(cell).toBe(`${"a".repeat(1999)}…`);
  expect(Buffer.from(cell, "utf8").toString("utf8")).toBe(cell);
});

it.each([
  { suffix: "😀tail", clipped: true },
  { suffix: "…", clipped: false },
])("preserves parser clipping provenance across a Unicode boundary ($clipped)", async ({ suffix, clipped }) => {
  const window = { rowOffset: 1, columnOffset: 0, rowCount: 1, columnCount: 1 };
  const parsed = await parseTableDocument(Buffer.from(`h\n${"a".repeat(1999)}${suffix}`), "csv", 0,
    PREVIEW_DOCUMENT_LIMITS, window);
  const document = readDocumentResponse(JSON.parse(JSON.stringify(parsed)), window);
  expect(document.sheet.rows[0]![0]!).toHaveLength(2000);
  const result = formatDocumentToolOutput("/document.csv", document, { kind: "sheet", sheet: 0, ...window });
  expect(result.isError).toBe(false);
  const value = JSON.parse(result.output);
  expect(value.truncation.clippedCells).toEqual(clipped ? [{ row: 1, column: 0 }] : []);
  expect(value.truncation.parser).toBe(clipped);
});

it("distinguishes a limit-length cell beside a parser-clipped cell", async () => {
  const window = { rowOffset: 1, columnOffset: 0, rowCount: 1, columnCount: 2 };
  const parsed = await parseTableDocument(Buffer.from(`h,h\n${"a".repeat(1999)}😀tail,${"a".repeat(1999)}…`), "csv", 0,
    PREVIEW_DOCUMENT_LIMITS, window);
  const document = readDocumentResponse(JSON.parse(JSON.stringify(parsed)), window);
  expect(document.sheet.rows[0]!.map((cell) => cell.length)).toEqual([2000, 2000]);
  const value = JSON.parse(formatDocumentToolOutput("/document.csv", document, { kind: "sheet", sheet: 0, ...window }).output);
  expect(value.truncation.clippedCells).toEqual([{ row: 1, column: 0 }]);
});

it("clips page text without introducing an unpaired surrogate", async () => {
  const result = await parsePageDocument(presentationFixture(`${"a".repeat(49999)}😀tail`), "pptx", 0);
  const text = result.page.paragraphs.join("\n");
  expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  expect(result.page.textTruncated).toBe(true);
});
