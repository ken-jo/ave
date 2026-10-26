import { expect, it } from "vitest";
import { parseTableDocument } from "../table-document-reader.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { parsePageDocument } from "../page-document-reader.js";
import { presentationFixture } from "../../__tests__/support/page-document-fixtures.js";

it("clips a document cell without introducing an unpaired surrogate", async () => {
  const result = await parseTableDocument(Buffer.from(`${"a".repeat(1999)}😀tail`), "csv", 0,
    PREVIEW_DOCUMENT_LIMITS, { rowCount: 1, columnCount: 1 });
  const cell = result.sheet.rows[0]![0]!;
  expect(cell).toBe(`${"a".repeat(1999)}…`);
  expect(Buffer.from(cell, "utf8").toString("utf8")).toBe(cell);
});

it("clips page text without introducing an unpaired surrogate", async () => {
  const result = await parsePageDocument(presentationFixture(`${"a".repeat(49999)}😀tail`), "pptx", 0);
  const text = result.page.paragraphs.join("\n");
  expect(Buffer.from(text, "utf8").toString("utf8")).toBe(text);
  expect(result.page.textTruncated).toBe(true);
});
