import JSZip from "jszip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { fileURLToPath } from "node:url";
import { isPlainRecord } from "../shared/is-record.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { PAGE_PREVIEW_LIMITS, type PreviewPageDocument, type PreviewPageFormat } from "../shared/preview-page-document.js";
import { TableDocumentError } from "./table-document-error.js";
import { verifyZipInflateLimits } from "./zip-inflate-guard.js";

const RELATIONSHIP_BASES = [
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/",
] as const;
const PRESENTATION_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

function corrupt(): never { throw new TableDocumentError("corrupt-document", "Invalid document package."); }
function limit(): never { throw new TableDocumentError("parse-limit", "Document exceeds the page preview budget."); }

function array(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function record(value: unknown): Record<string, unknown> { if (!isPlainRecord(value)) corrupt(); return value; }

function assertXmlDepth(text: string): void {
  let depth = 0;
  let offset = 0;
  while ((offset = text.indexOf("<", offset)) >= 0) {
    const terminator = text.startsWith("<!--", offset) ? "-->"
      : text.startsWith("<![CDATA[", offset) ? "]]>" : text.startsWith("<?", offset) ? "?>" : null;
    if (terminator) {
      const end = text.indexOf(terminator, offset + 2);
      if (end < 0) corrupt();
      offset = end + terminator.length;
      continue;
    }
    let end = offset + 1;
    let quote = "";
    for (; end < text.length; end += 1) {
      const character = text[end]!;
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === text.length || quote) corrupt();
    if (text[offset + 1] === "/") depth -= 1;
    else if (text[end - 1] !== "/") depth += 1;
    if (depth > PAGE_PREVIEW_LIMITS.maxXmlDepth) limit();
    offset = end + 1;
  }
}

function xml(bytes: Buffer): Record<string, unknown> {
  if (bytes.length > PAGE_PREVIEW_LIMITS.maxXmlBytes) limit();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return corrupt(); }
  if (/<!DOCTYPE|<!ENTITY|\0/i.test(text)) corrupt();
  assertXmlDepth(text);
  if (XMLValidator.validate(text) !== true) corrupt();
  return record(new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: "@",
    transformTagName: (name) => name.slice(name.lastIndexOf(":") + 1),
    parseTagValue: false, parseAttributeValue: false, trimValues: false,
    processEntities: true,
  }).parse(text));
}

interface Relationship { type: string; target: string; internal: boolean }
function relationships(bytes: Buffer): Map<string, Relationship> {
  const root = record(xml(bytes).Relationships);
  const result = new Map<string, Relationship>();
  for (const raw of array(root.Relationship)) {
    const item = record(raw);
    const id = item["@Id"];
    if (typeof id !== "string" || result.has(id) || typeof item["@Type"] !== "string"
      || typeof item["@Target"] !== "string"
      || ![undefined, "Internal", "External"].includes(item["@TargetMode"] as string | undefined)) corrupt();
    result.set(id, { type: item["@Type"], target: item["@Target"], internal: item["@TargetMode"] !== "External" });
  }
  return result;
}
function hasType(relationship: Relationship, kind: string): boolean {
  return RELATIONSHIP_BASES.some((base) => relationship.type === `${base}${kind}`);
}

function namespaceBindings(value: Record<string, unknown>, inherited = new Map<string, string>()): Map<string, string> {
  const bindings = new Map(inherited);
  for (const [name, uri] of Object.entries(value)) {
    if (!name.startsWith("@xmlns:")) continue;
    if (typeof uri !== "string") corrupt();
    bindings.set(name.slice("@xmlns:".length), uri);
  }
  return bindings;
}

function boundedParagraphs(values: Iterable<string>): { paragraphs: string[]; textTruncated: boolean } {
  const paragraphs: string[] = [];
  let characters = 0;
  let textTruncated = false;
  for (const text of values) {
    if (text.trim().length === 0) continue;
    if (paragraphs.length === PAGE_PREVIEW_LIMITS.maxParagraphs || characters === PAGE_PREVIEW_LIMITS.maxTextChars) {
      textTruncated = true;
      break;
    }
    const shown = text.slice(0, PAGE_PREVIEW_LIMITS.maxTextChars - characters);
    paragraphs.push(shown);
    characters += shown.length;
    if (shown.length !== text.length) { textTruncated = true; break; }
  }
  return { paragraphs, textTruncated };
}

async function presentation(bytes: Buffer, index: number): Promise<PreviewPageDocument> {
  const verdict = verifyZipInflateLimits(bytes, PREVIEW_DOCUMENT_LIMITS, {
    opaqueArchiveMemberPrefixes: ["ppt/embeddings/"],
  });
  if (!verdict.ok) {
    throw new TableDocumentError(verdict.reason === "encrypted" ? "encrypted"
      : verdict.reason === "corrupt" ? "corrupt-document" : "archive-too-large", "Presentation container was refused.");
  }
  const zip = await JSZip.loadAsync(verdict.canonicalBytes);
  async function part(name: string): Promise<Buffer> {
    const entry = zip.file(name);
    if (!entry) corrupt();
    // The central directory has already been validated against actual inflation.
    const value = await entry.async("nodebuffer");
    if (value.length > PAGE_PREVIEW_LIMITS.maxXmlBytes) limit();
    return value;
  }
  const types = record(xml(await part("[Content_Types].xml")).Types);
  const contentTypes = new Map<string, string>();
  for (const raw of array(types.Override)) {
    const item = record(raw);
    if (typeof item["@PartName"] !== "string" || typeof item["@ContentType"] !== "string"
      || contentTypes.has(item["@PartName"])) corrupt();
    contentTypes.set(item["@PartName"], item["@ContentType"]);
  }
  if (contentTypes.get("/ppt/presentation.xml") !== PRESENTATION_TYPE) corrupt();
  const roots = relationships(await part("_rels/.rels"));
  const office = [...roots.values()].filter((item) => hasType(item, "officeDocument"));
  if (office.length !== 1 || !office[0]!.internal || !/^\/?ppt\/presentation\.xml$/.test(office[0]!.target)) corrupt();
  const presentationRoot = record(xml(await part("ppt/presentation.xml")).presentation);
  const slideList = presentationRoot.sldIdLst === undefined || presentationRoot.sldIdLst === ""
    ? {} : record(presentationRoot.sldIdLst);
  const listBindings = namespaceBindings(slideList, namespaceBindings(presentationRoot));
  const slides = array(slideList.sldId);
  if (index >= Math.min(slides.length, PAGE_PREVIEW_LIMITS.maxPages)) {
    throw new TableDocumentError("page-not-found", "Requested page does not exist.");
  }
  const links = relationships(await part("ppt/_rels/presentation.xml.rels"));
  const usedIds = new Set<string>();
  let selected = "";
  for (let slideIndex = 0; slideIndex < slides.length; slideIndex += 1) {
    const slide = record(slides[slideIndex]);
    const bindings = namespaceBindings(slide, listBindings);
    const references = Object.entries(slide).filter(([name]) => {
      const prefix = /^@([^:]+):id$/.exec(name)?.[1];
      return prefix !== undefined && RELATIONSHIP_BASES.some((base) => bindings.get(prefix) === base.slice(0, -1));
    });
    if (references.length !== 1) corrupt();
    const id = references[0]![1];
    if (typeof id !== "string" || usedIds.has(id)) corrupt();
    usedIds.add(id);
    const link = links.get(id);
    if (!link || !link.internal || !hasType(link, "slide")) corrupt();
    const path = link.target.startsWith("/") ? link.target.slice(1) : `ppt/${link.target}`;
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(path) || !zip.file(path) || contentTypes.get(`/${path}`) !== SLIDE_TYPE) corrupt();
    if (slideIndex === index) selected = path;
  }
  const slideBytes = await part(selected);
  record(xml(slideBytes).sld);
  const slide: unknown = new XMLParser({ preserveOrder: true, ignoreAttributes: true, removeNSPrefix: true,
    parseTagValue: false, trimValues: false }).parse(slideBytes.toString("utf8"));
  const paragraphs: string[] = [];
  function walk(value: unknown): void {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!isPlainRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "p") {
        const pieces: string[] = [];
        function text(node: unknown): void {
          if (Array.isArray(node)) { for (const item of node) text(item); return; }
          if (!isPlainRecord(node)) return;
          for (const [name, content] of Object.entries(node)) {
            if (name === "#text" && typeof content === "string") pieces.push(content);
            else if (name === "br") pieces.push("\n");
            else if (!name.startsWith("@")) text(content);
          }
        }
        text(child);
        paragraphs.push(pieces.join(""));
      } else if (!key.startsWith("@")) walk(child);
    }
  }
  walk(slide);
  return { format: "pptx", totalPages: slides.length, pagesTruncated: slides.length > PAGE_PREVIEW_LIMITS.maxPages,
    page: { index, ...boundedParagraphs(paragraphs), png: null, width: 0, height: 0 } };
}

async function pdf(bytes: Buffer, index: number): Promise<PreviewPageDocument> {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) corrupt();
  const { createCanvas } = await import("@napi-rs/canvas");
  const library = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const moduleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");
  library.GlobalWorkerOptions.workerSrc = import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = library.getDocument({
    data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false,
    useWorkerFetch: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    maxImageSize: PAGE_PREVIEW_LIMITS.maxPixels, canvasMaxAreaInBytes: PAGE_PREVIEW_LIMITS.maxPixels * 4,
    stopAtErrors: true, verbosity: 0,
    standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", moduleUrl)),
    cMapUrl: fileURLToPath(new URL("../../cmaps/", moduleUrl)),
    wasmUrl: fileURLToPath(new URL("../../wasm/", moduleUrl)),
  });
  try {
    const document = await task.promise;
    if (index >= Math.min(document.numPages, PAGE_PREVIEW_LIMITS.maxPages)) {
      throw new TableDocumentError("page-not-found", "Requested page does not exist.");
    }
    const page = await document.getPage(index + 1);
    const original = page.getViewport({ scale: 1 });
    if (!Number.isFinite(original.width * original.height) || original.width <= 0 || original.height <= 0) corrupt();
    const scale = Math.min(PAGE_PREVIEW_LIMITS.maxScale, PAGE_PREVIEW_LIMITS.maxSide / Math.max(original.width, original.height),
      Math.sqrt(PAGE_PREVIEW_LIMITS.maxPixels / (original.width * original.height)));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.floor(viewport.width));
    const height = Math.max(1, Math.floor(viewport.height));
    const canvas = createCanvas(width, height);
    try {
      // Read the complete operator stream: rendering can resolve after a stream error.
      await page.getOperatorList();
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
      const png = canvas.toBuffer("image/png");
      if (png.length > PAGE_PREVIEW_LIMITS.maxPngBytes) limit();
      const text = await page.getTextContent();
      return { format: "pdf", totalPages: document.numPages, pagesTruncated: document.numPages > PAGE_PREVIEW_LIMITS.maxPages,
        page: { index, ...boundedParagraphs(text.items.flatMap((item) => "str" in item ? [item.str] : [])),
          png: png.toString("base64"), width, height } };
    } finally { page.cleanup(); canvas.width = 1; canvas.height = 1; }
  } catch (error) {
    if (error instanceof TableDocumentError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new TableDocumentError("encrypted", "Encrypted documents cannot be previewed.");
    }
    return corrupt();
  } finally { await task.destroy(); }
}

export async function parsePageDocument(bytes: Buffer, format: PreviewPageFormat, index: number): Promise<PreviewPageDocument> {
  if (format !== "pptx" && format !== "pdf") throw new TableDocumentError("unsupported-format", "Unsupported document format.");
  if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) throw new TableDocumentError("too-large", "Document exceeds the file size limit.");
  if (!Number.isSafeInteger(index) || index < 0) throw new TableDocumentError("page-not-found", "Invalid page index.");
  return format === "pptx" ? presentation(bytes, index) : pdf(bytes, index);
}
