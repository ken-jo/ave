import { isPlainRecord } from "../shared/is-record.js";
import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument } from "../shared/preview-page-document.js";

function invalid(): never { throw new Error("Invalid page preview response."); }

export function readPageDocumentResponse(value: unknown): PreviewPageDocument {
  if (!isPlainRecord(value) || Object.keys(value).length !== 4
    || (value.format !== "pdf" && value.format !== "pptx")
    || !Number.isSafeInteger(value.totalPages) || (value.totalPages as number) < 1
    || value.pagesTruncated !== ((value.totalPages as number) > PAGE_PREVIEW_LIMITS.maxPages)
    || !isPlainRecord(value.page) || Object.keys(value.page).length !== 6) invalid();
  const page = value.page;
  if (!Number.isSafeInteger(page.index) || (page.index as number) < 0
    || (page.index as number) >= Math.min(value.totalPages as number, PAGE_PREVIEW_LIMITS.maxPages)
    || !Array.isArray(page.paragraphs) || page.paragraphs.length > PAGE_PREVIEW_LIMITS.maxParagraphs
    || !page.paragraphs.every((text) => typeof text === "string")
    || page.paragraphs.reduce((sum, text: string) => sum + text.length, 0) > PAGE_PREVIEW_LIMITS.maxTextChars
    || typeof page.textTruncated !== "boolean"
    || !Number.isSafeInteger(page.width) || !Number.isSafeInteger(page.height)) invalid();
  if (value.format === "pptx") {
    if (page.png !== null || page.width !== 0 || page.height !== 0) invalid();
  } else {
    if (typeof page.png !== "string" || page.png.length > Math.ceil(PAGE_PREVIEW_LIMITS.maxPngBytes / 3) * 4
      || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(page.png)
      || (page.width as number) < 1 || (page.width as number) > PAGE_PREVIEW_LIMITS.maxSide
      || (page.height as number) < 1 || (page.height as number) > PAGE_PREVIEW_LIMITS.maxSide
      || (page.width as number) * (page.height as number) > PAGE_PREVIEW_LIMITS.maxPixels) invalid();
    const png = Buffer.from(page.png, "base64");
    if (png.length > PAGE_PREVIEW_LIMITS.maxPngBytes || png.toString("base64") !== page.png
      || png.length < 33 || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR"
      || png.readUInt32BE(16) !== page.width || png.readUInt32BE(20) !== page.height) invalid();
  }
  return value as unknown as PreviewPageDocument;
}
