import { isPlainRecord } from "../shared/is-record.js";
import { crc32 } from "node:zlib";
import { PAGE_PREVIEW_LIMITS, previewPageFormatOf, type PreviewPageDocument } from "../shared/preview-page-document.js";

function invalid(): never { throw new Error("Invalid page preview response."); }

const PNG_METADATA_LENGTHS = Object.freeze({ sRGB: 1, gAMA: 4, pHYs: 9, cICP: 4 });

function validateStaticPng(png: Buffer): void {
  if (png[24] !== 8 || (png[25] !== 2 && png[25] !== 6)
    || png[26] !== 0 || png[27] !== 0 || png[28] !== 0) invalid();
  let offset = 8;
  let chunks = 0;
  let dataBytes = 0;
  let dataStarted = false;
  let dataEnded = false;
  let ended = false;
  const metadata = new Set<string>();
  while (offset < png.length) {
    if (++chunks > PAGE_PREVIEW_LIMITS.maxPngChunks || offset + 12 > png.length) invalid();
    const length = png.readUInt32BE(offset);
    const end = offset + 8 + length;
    if (end + 4 > png.length) invalid();
    const kind = png.toString("latin1", offset + 4, offset + 8);
    if (crc32(png.subarray(offset + 4, end)) !== png.readUInt32BE(end)) invalid();
    if (offset === 8 && kind !== "IHDR") invalid();
    if (kind === "IHDR") {
      if (offset !== 8 || length !== 13) invalid();
    } else if (kind === "IDAT") {
      if (dataEnded) invalid();
      dataStarted = true;
      dataBytes += length;
    } else if (kind === "IEND") {
      if (length !== 0 || dataBytes === 0 || end + 4 !== png.length) invalid();
      ended = true;
      break;
    } else {
      if (metadata.has(kind)) invalid();
      metadata.add(kind);
      if (dataStarted) dataEnded = true;
      const fixedLength = PNG_METADATA_LENGTHS[kind as keyof typeof PNG_METADATA_LENGTHS];
      if (fixedLength !== undefined) {
        if (length !== fixedLength) invalid();
      } else if (kind === "sBIT") {
        if (length !== (png[25] === 6 ? 4 : 3) || png.subarray(offset + 8, end).some((bits) => bits < 1 || bits > 8)) invalid();
      } else if (kind === "PLTE") {
        if (length === 0 || length > 768 || length % 3 !== 0) invalid();
      } else if (kind === "tRNS") {
        if (png[25] !== 2 || length !== 6) invalid();
      } else if (kind !== "tEXt" || length > PAGE_PREVIEW_LIMITS.maxPngMetadataBytes) invalid();
    }
    offset = end + 4;
  }
  if (!ended) invalid();
}

function isIndex(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

function validateElements(value: unknown, format: string, selectionIndex: number): void {
  if (!Array.isArray(value) || value.length > PAGE_PREVIEW_LIMITS.maxParagraphs || format === "pdf") invalid();
  let characters = 0;
  const addresses = new Set<string>();
  for (const entry of value) {
    if (!isPlainRecord(entry) || Object.keys(entry).length !== 2 || typeof entry.text !== "string"
      || !isPlainRecord(entry.element)) invalid();
    characters += entry.text.length;
    if (characters > PAGE_PREVIEW_LIMITS.maxTextChars) invalid();
    const element = entry.element;
    let address: string;
    if (element.kind === "paragraph") {
      if (format === "pptx" || !isIndex(element.paragraph)
        || Object.keys(element).some((key) => !["kind", "paragraph", "run"].includes(key))
        || (Object.hasOwn(element, "run") && !isIndex(element.run))) invalid();
      address = `paragraph\0${element.paragraph}\0${element.run ?? ""}`;
    } else if (element.kind === "shape") {
      if (format !== "pptx" || Object.keys(element).length !== 3 || !isIndex(element.slide) || element.slide !== selectionIndex
        || typeof element.shapeId !== "string" || !/^[^\u0000-\u001f\u007f]{1,128}$/.test(element.shapeId)) invalid();
      address = `shape\0${element.slide}\0${element.shapeId}`;
    } else return invalid();
    if (addresses.has(address)) invalid();
    addresses.add(address);
  }
}

export function readPageDocumentResponse(value: unknown): PreviewPageDocument {
  if (!isPlainRecord(value) || ![4, 5].includes(Object.keys(value).length)
    || Object.keys(value).some((key) => !["format", "totalPages", "pagesTruncated", "page", "elements"].includes(key))
    || typeof value.format !== "string" || previewPageFormatOf(`input.${value.format}`) !== value.format
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
  if (Object.hasOwn(value, "elements")) validateElements(value.elements, value.format, page.index as number);
  if (page.png === null) {
    if (value.format === "pdf" || page.width !== 0 || page.height !== 0) invalid();
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
    validateStaticPng(png);
  }
  return value as unknown as PreviewPageDocument;
}
