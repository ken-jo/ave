import { EntityDecoder, XML } from "@nodable/entities";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { isPlainRecord } from "../shared/is-record.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { PAGE_PREVIEW_LIMITS, type PreviewDocumentElement, type PreviewPageDocument } from "../shared/preview-page-document.js";
import { isUnicodeBoundary } from "../shared/bounded-tool-output.js";
import { TableDocumentError } from "../tools/table-document-error.js";
import { CFB_MAGIC } from "../tools/workbook-container.js";
import { verifyZipInflateLimits } from "../tools/zip-inflate-guard.js";

type StructuredFormat = "docx" | "odt" | "pptx";
interface XmlNode {
  name: string;
  namespace: string;
  attributes: Map<string, string>;
  children: (XmlNode | string)[];
}
interface StructuredPage { paragraphs: string[]; elements: PreviewDocumentElement[]; truncated: boolean }

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const PACKAGE_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const WORD_NAMESPACES = ["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"];
const PRESENTATION_NAMESPACES = ["http://schemas.openxmlformats.org/presentationml/2006/main", "http://purl.oclc.org/ooxml/presentationml/main"];
const DRAWING_NAMESPACES = ["http://schemas.openxmlformats.org/drawingml/2006/main", "http://purl.oclc.org/ooxml/drawingml/main"];
const RELATIONSHIP_NAMESPACES = ["http://schemas.openxmlformats.org/officeDocument/2006/relationships", "http://purl.oclc.org/ooxml/officeDocument/relationships"];
const OFFICE_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const TEXT_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const MANIFEST_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";
const WORD_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const PRESENTATION_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const SLIDE_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const ODT_CONTENT_TYPE = "application/vnd.oasis.opendocument.text";
const SHAPE_NON_VISUAL_PARTS: Readonly<Record<string, string>> = Object.freeze({
  sp: "nvSpPr", graphicFrame: "nvGraphicFramePr", cxnSp: "nvCxnSpPr", pic: "nvPicPr", grpSp: "nvGrpSpPr",
});

function corrupt(): never { throw new TableDocumentError("corrupt-document", "Invalid structured document package."); }
function limit(): never { throw new TableDocumentError("parse-limit", "Structured document exceeds its preview budget."); }
function attr(node: XmlNode, name: string, namespace = ""): string | undefined { return node.attributes.get(`${namespace}\0${name}`); }
function matches(node: XmlNode, name: string, namespaces: readonly string[]): boolean { return node.name === name && namespaces.includes(node.namespace); }
function childNodes(node: XmlNode): XmlNode[] { return node.children.filter((value): value is XmlNode => typeof value !== "string"); }
function children(node: XmlNode, name: string, namespaces: readonly string[]): XmlNode[] { return childNodes(node).filter((value) => matches(value, name, namespaces)); }
function oneChild(node: XmlNode, name: string, namespaces: readonly string[]): XmlNode {
  const values = children(node, name, namespaces);
  if (values.length !== 1) corrupt();
  return values[0]!;
}

function assertDepth(text: string): void {
  let depth = 0;
  let offset = 0;
  while ((offset = text.indexOf("<", offset)) >= 0) {
    const terminator = text.startsWith("<!--", offset) ? "-->" : text.startsWith("<![CDATA[", offset) ? "]]>" : text.startsWith("<?", offset) ? "?>" : null;
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

function qualified(name: string, bindings: Map<string, string>, attribute: boolean): { name: string; namespace: string } {
  const pieces = name.split(":");
  if (pieces.length > 2 || pieces.some((piece) => !piece)) corrupt();
  const prefix = pieces.length === 2 ? pieces[0]! : "";
  if (["__proto__", "constructor", "prototype"].includes(pieces.at(-1)!)) corrupt();
  const namespace = prefix ? bindings.get(prefix) : attribute ? "" : bindings.get("") ?? "";
  if (namespace === undefined) corrupt();
  return { name: pieces.at(-1)!, namespace };
}

function xml(bytes: Buffer): XmlNode {
  if (bytes.length > PAGE_PREVIEW_LIMITS.maxXmlBytes) limit();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return corrupt(); }
  if (/<!DOCTYPE|<!ENTITY|\0/i.test(text)) corrupt();
  assertDepth(text);
  if (XMLValidator.validate(text) !== true) corrupt();
  let ordered: unknown;
  try {
    ordered = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "@", trimValues: false,
      parseTagValue: false, parseAttributeValue: false, processEntities: true,
      entityDecoder: new EntityDecoder({ namedEntities: { ...XML }, numericAllowed: true }) }).parse(text);
  } catch { return corrupt(); }
  function nodes(value: unknown, inherited: Map<string, string>): (XmlNode | string)[] {
    if (!Array.isArray(value)) corrupt();
    const result: (XmlNode | string)[] = [];
    for (const raw of value) {
      if (!isPlainRecord(raw)) corrupt();
      const bindings = new Map(inherited);
      const attrs = raw[":@"];
      if (attrs !== undefined && !isPlainRecord(attrs)) corrupt();
      for (const [key, rawValue] of Object.entries(attrs ?? {})) {
        if (typeof rawValue !== "string") corrupt();
        if (key === "@xmlns") bindings.set("", rawValue);
        else if (key.startsWith("@xmlns:")) bindings.set(key.slice(7), rawValue);
      }
      for (const [name, contents] of Object.entries(raw)) {
        if (name === ":@" || name.startsWith("?")) continue;
        if (name === "#text") {
          if (typeof contents !== "string") corrupt();
          result.push(contents);
          continue;
        }
        const resolved = qualified(name, bindings, false);
        const attributes = new Map<string, string>();
        for (const [key, rawValue] of Object.entries(attrs ?? {})) {
          if (key === "@xmlns" || key.startsWith("@xmlns:")) continue;
          if (!key.startsWith("@") || typeof rawValue !== "string") corrupt();
          const attribute = qualified(key.slice(1), bindings, true);
          const keyName = `${attribute.namespace}\0${attribute.name}`;
          if (attributes.has(keyName)) corrupt();
          attributes.set(keyName, rawValue);
        }
        result.push({ ...resolved, attributes, children: nodes(contents, bindings) });
      }
    }
    return result;
  }
  const roots = nodes(ordered, new Map([["xml", XML_NAMESPACE]])).filter((node): node is XmlNode => typeof node !== "string");
  if (roots.length !== 1) corrupt();
  return roots[0]!;
}

function packageParts(bytes: Buffer, format: StructuredFormat): Map<string, Buffer> {
  if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) throw new TableDocumentError("too-large", "Document exceeds the file size limit.");
  if (CFB_MAGIC.every((byte, offset) => bytes[offset] === byte)) throw new TableDocumentError("encrypted", "Encrypted documents cannot be previewed.");
  const parts = new Map<string, Buffer>();
  const verdict = verifyZipInflateLimits(bytes, PREVIEW_DOCUMENT_LIMITS, {
    opaqueArchiveMemberPrefixes: [format === "pptx" ? "ppt/embeddings/" : "word/embeddings/"],
    onEntry: (name, data) => {
      if (name === "mimetype" || name === "content.xml" || name === "META-INF/manifest.xml" || name === "[Content_Types].xml"
        || name === "_rels/.rels" || name === "word/document.xml" || name === "ppt/presentation.xml"
        || name === "ppt/_rels/presentation.xml.rels" || /^ppt\/slides\/[^/]+\.xml$/.test(name)) {
        if (data.length > PAGE_PREVIEW_LIMITS.maxXmlBytes) limit();
        parts.set(name, data);
      }
    },
  });
  if (!verdict.ok) throw new TableDocumentError(verdict.reason === "encrypted" ? "encrypted"
    : verdict.reason === "corrupt" ? "corrupt-document" : "archive-too-large", "Structured document container was refused.");
  return parts;
}
function part(parts: Map<string, Buffer>, name: string): Buffer { const value = parts.get(name); if (!value) corrupt(); return value; }

interface Relationship { id: string; type: string; target: string; internal: boolean }
function relationships(bytes: Buffer): Relationship[] {
  const root = xml(bytes);
  if (!matches(root, "Relationships", [PACKAGE_NAMESPACE])) corrupt();
  const result: Relationship[] = [];
  const ids = new Set<string>();
  for (const node of children(root, "Relationship", [PACKAGE_NAMESPACE])) {
    const id = attr(node, "Id");
    const type = attr(node, "Type");
    const target = attr(node, "Target");
    const mode = attr(node, "TargetMode");
    if (!id || ids.has(id) || !type || !target || ![undefined, "Internal", "External"].includes(mode)) corrupt();
    ids.add(id);
    result.push({ id, type, target, internal: mode !== "External" });
  }
  return result;
}
function relationshipType(link: Relationship, kind: string): boolean { return RELATIONSHIP_NAMESPACES.some((namespace) => link.type === `${namespace}/${kind}`); }
function contentTypes(parts: Map<string, Buffer>): Map<string, string> {
  const root = xml(part(parts, "[Content_Types].xml"));
  if (!matches(root, "Types", [CONTENT_NAMESPACE])) corrupt();
  const result = new Map<string, string>();
  for (const node of children(root, "Override", [CONTENT_NAMESPACE])) {
    const name = attr(node, "PartName");
    const type = attr(node, "ContentType");
    if (!name || !type || result.has(name)) corrupt();
    result.set(name, type);
  }
  return result;
}
function officeRoot(parts: Map<string, Buffer>, path: string): void {
  const office = relationships(part(parts, "_rels/.rels")).filter((link) => relationshipType(link, "officeDocument"));
  if (office.length !== 1 || !office[0]!.internal || office[0]!.target.replace(/^\//, "") !== path) corrupt();
}
function* descendants(node: XmlNode): Generator<XmlNode> { for (const child of childNodes(node)) { yield child; yield* descendants(child); } }
function* visibleWordNodes(node: XmlNode, namespace: string): Generator<XmlNode> {
  for (const child of childNodes(node)) {
    if (child.namespace === namespace && (child.name === "del" || child.name === "moveFrom")) continue;
    yield child;
    yield* visibleWordNodes(child, namespace);
  }
}
function textContent(node: XmlNode): string { return node.children.map((child) => typeof child === "string" ? child : textContent(child)).join(""); }
function officeText(node: XmlNode, namespaces: readonly string[]): string {
  if (!namespaces.includes(node.namespace)) return childNodes(node).map((child) => officeText(child, namespaces)).join("");
  if (node.name === "t") return textContent(node);
  if (node.name === "br" || node.name === "cr") return "\n";
  if (node.name === "tab") return "\t";
  if (node.name === "del" || node.name === "moveFrom" || node.name === "instrText") return "";
  return childNodes(node).map((child) => officeText(child, namespaces)).join("");
}
function bounded<T>(values: Iterable<T>, textOf: (value: T) => string, replaceText: (value: T, text: string) => T): { values: T[]; truncated: boolean } {
  const result: T[] = [];
  let characters = 0;
  let truncated = false;
  for (const value of values) {
    const text = textOf(value);
    if (result.length === PAGE_PREVIEW_LIMITS.maxParagraphs || characters === PAGE_PREVIEW_LIMITS.maxTextChars) { truncated = true; break; }
    const end = Math.min(text.length, PAGE_PREVIEW_LIMITS.maxTextChars - characters);
    const shown = text.slice(0, isUnicodeBoundary(text, end) ? end : end - 1);
    result.push(replaceText(value, shown));
    characters += shown.length;
    if (shown.length !== text.length) { truncated = true; break; }
  }
  return { values: result, truncated };
}
function boundedPage(paragraphs: Iterable<string>, elements: Iterable<PreviewDocumentElement>): StructuredPage {
  const text = bounded(paragraphs, (value) => value, (_value, shown) => shown);
  const source = bounded(elements, (value) => value.text, (value, shown) => ({ ...value, text: shown }));
  return { paragraphs: text.values, elements: source.values, truncated: text.truncated || source.truncated };
}
function documentParagraphs(parts: Map<string, Buffer>): { paragraphs: string[]; elements: PreviewDocumentElement[] } {
  if (contentTypes(parts).get("/word/document.xml") !== WORD_CONTENT_TYPE) corrupt();
  officeRoot(parts, "word/document.xml");
  const document = xml(part(parts, "word/document.xml"));
  if (!matches(document, "document", WORD_NAMESPACES)) corrupt();
  const body = oneChild(document, "body", [document.namespace]);
  const paragraphs: string[] = [];
  const elements: PreviewDocumentElement[] = [];
  let characters = 0;
  let sourceCharacters = 0;
  for (const node of visibleWordNodes(body, document.namespace)) {
    if (!matches(node, "p", [document.namespace])) continue;
    const paragraph = paragraphs.length;
    const text = officeText(node, [document.namespace]);
    paragraphs.push(text);
    characters += text.length;
    if (elements.length <= PAGE_PREVIEW_LIMITS.maxParagraphs && sourceCharacters <= PAGE_PREVIEW_LIMITS.maxTextChars) {
      const shown = text.slice(0, PAGE_PREVIEW_LIMITS.maxTextChars + 1 - sourceCharacters);
      elements.push({ element: { kind: "paragraph", paragraph }, text: shown });
      sourceCharacters += shown.length;
    }
    let run = 0;
    for (const item of visibleWordNodes(node, document.namespace)) if (matches(item, "r", [document.namespace])) {
      if (elements.length > PAGE_PREVIEW_LIMITS.maxParagraphs || sourceCharacters > PAGE_PREVIEW_LIMITS.maxTextChars) break;
      const shown = officeText(item, [document.namespace]).slice(0, PAGE_PREVIEW_LIMITS.maxTextChars + 1 - sourceCharacters);
      elements.push({ element: { kind: "paragraph", paragraph, run: run++ }, text: shown });
      sourceCharacters += shown.length;
    }
    if (paragraphs.length > PAGE_PREVIEW_LIMITS.maxParagraphs || characters > PAGE_PREVIEW_LIMITS.maxTextChars) break;
  }
  return { paragraphs, elements };
}
function odtText(node: XmlNode, budget: number): string {
  if (node.namespace === TEXT_NAMESPACE) {
    if (node.name === "s") {
      const count = attr(node, "c", TEXT_NAMESPACE) ?? "1";
      if (!/^[1-9][0-9]*$/.test(count) || !Number.isSafeInteger(Number(count)) || Number(count) > PAGE_PREVIEW_LIMITS.maxTextChars) limit();
      return " ".repeat(Math.min(Number(count), budget));
    }
    if (node.name === "tab") return "\t";
    if (node.name === "line-break") return "\n";
  }
  let result = "";
  for (const child of node.children) {
    const remaining = budget - result.length;
    if (remaining === 0) break;
    result += typeof child === "string" ? child.slice(0, remaining) : odtText(child, remaining);
  }
  return result;
}
function textParagraphs(parts: Map<string, Buffer>): { paragraphs: string[]; elements: PreviewDocumentElement[] } {
  if (part(parts, "mimetype").toString("utf8") !== ODT_CONTENT_TYPE) corrupt();
  const manifest = xml(part(parts, "META-INF/manifest.xml"));
  if (!matches(manifest, "manifest", [MANIFEST_NAMESPACE])) corrupt();
  if ([...descendants(manifest)].some((node) => matches(node, "encryption-data", [MANIFEST_NAMESPACE]))) {
    throw new TableDocumentError("encrypted", "Encrypted documents cannot be previewed.");
  }
  const rootEntries = children(manifest, "file-entry", [MANIFEST_NAMESPACE]).filter((node) => attr(node, "full-path", MANIFEST_NAMESPACE) === "/");
  if (rootEntries.length !== 1 || attr(rootEntries[0]!, "media-type", MANIFEST_NAMESPACE) !== ODT_CONTENT_TYPE) corrupt();
  const document = xml(part(parts, "content.xml"));
  if (!matches(document, "document-content", [OFFICE_NAMESPACE])) corrupt();
  const body = oneChild(document, "body", [OFFICE_NAMESPACE]);
  const text = oneChild(body, "text", [OFFICE_NAMESPACE]);
  const paragraphs: string[] = [];
  const elements: PreviewDocumentElement[] = [];
  let characters = 0;
  for (const node of descendants(text)) if (node.namespace === TEXT_NAMESPACE && (node.name === "p" || node.name === "h")) {
    const paragraph = paragraphs.length;
    const value = odtText(node, PAGE_PREVIEW_LIMITS.maxTextChars + 1 - characters);
    paragraphs.push(value);
    characters += value.length;
    elements.push({ element: { kind: "paragraph", paragraph }, text: value });
    if (paragraphs.length > PAGE_PREVIEW_LIMITS.maxParagraphs || characters > PAGE_PREVIEW_LIMITS.maxTextChars) break;
  }
  return { paragraphs, elements };
}
function slidePaths(parts: Map<string, Buffer>): string[] {
  const types = contentTypes(parts);
  if (types.get("/ppt/presentation.xml") !== PRESENTATION_CONTENT_TYPE) corrupt();
  officeRoot(parts, "ppt/presentation.xml");
  const presentation = xml(part(parts, "ppt/presentation.xml"));
  if (!matches(presentation, "presentation", PRESENTATION_NAMESPACES)) corrupt();
  const lists = children(presentation, "sldIdLst", [presentation.namespace]);
  if (lists.length > 1) corrupt();
  const ids = lists[0] ? children(lists[0], "sldId", [presentation.namespace]) : [];
  const links = new Map(relationships(part(parts, "ppt/_rels/presentation.xml.rels")).map((link) => [link.id, link]));
  const used = new Set<string>();
  return ids.map((node) => {
    const values = RELATIONSHIP_NAMESPACES.flatMap((namespace) => { const value = attr(node, "id", namespace); return value === undefined ? [] : [value]; });
    const id = values[0];
    if (values.length !== 1 || id === undefined || used.has(id)) corrupt();
    used.add(id);
    const link = links.get(id);
    if (!link || !link.internal || !relationshipType(link, "slide")) corrupt();
    const path = link.target.startsWith("/") ? link.target.slice(1) : `ppt/${link.target}`;
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(path) || !parts.has(path) || types.get(`/${path}`) !== SLIDE_CONTENT_TYPE) corrupt();
    return path;
  });
}
function slidePage(parts: Map<string, Buffer>, path: string, slideIndex: number): StructuredPage {
  const slide = xml(part(parts, path));
  if (!matches(slide, "sld", PRESENTATION_NAMESPACES)) corrupt();
  const paragraphs: string[] = [];
  const elements: PreviewDocumentElement[] = [];
  const ids = new Set<string>();
  let characters = 0;
  let sourceCharacters = 0;
  for (const node of descendants(slide)) {
    if (matches(node, "p", DRAWING_NAMESPACES) && paragraphs.length <= PAGE_PREVIEW_LIMITS.maxParagraphs
      && characters <= PAGE_PREVIEW_LIMITS.maxTextChars) {
      const text = officeText(node, DRAWING_NAMESPACES).slice(0, PAGE_PREVIEW_LIMITS.maxTextChars + 1 - characters);
      if (text.trim()) { paragraphs.push(text); characters += text.length; }
    }
    const nonVisualName = Object.hasOwn(SHAPE_NON_VISUAL_PARTS, node.name) ? SHAPE_NON_VISUAL_PARTS[node.name] : undefined;
    if (!PRESENTATION_NAMESPACES.includes(node.namespace) || nonVisualName === undefined) continue;
    const nonVisual = oneChild(node, nonVisualName, [node.namespace]);
    const properties = oneChild(nonVisual, "cNvPr", [node.namespace]);
    const rawId = attr(properties, "id");
    if (rawId === undefined || !/^[0-9]{1,10}$/.test(rawId) || Number(rawId) > 4_294_967_295) corrupt();
    const shapeId = String(Number(rawId));
    if (ids.has(shapeId)) corrupt();
    ids.add(shapeId);
    if (elements.length > PAGE_PREVIEW_LIMITS.maxParagraphs || sourceCharacters > PAGE_PREVIEW_LIMITS.maxTextChars) continue;
    let text = "";
    for (const item of shapeParagraphs(node)) {
      const remaining = PAGE_PREVIEW_LIMITS.maxTextChars + 1 - sourceCharacters - text.length;
      if (remaining <= 0) break;
      const next = officeText(item, DRAWING_NAMESPACES);
      text += `${text ? "\n" : ""}${next}`.slice(0, remaining);
    }
    elements.push({ element: { kind: "shape", slide: slideIndex, shapeId }, text });
    sourceCharacters += text.length;
  }
  return boundedPage(paragraphs, elements);
}

function* shapeParagraphs(node: XmlNode): Generator<XmlNode> {
  for (const child of childNodes(node)) {
    if (PRESENTATION_NAMESPACES.includes(child.namespace) && Object.hasOwn(SHAPE_NON_VISUAL_PARTS, child.name)) continue;
    if (matches(child, "p", DRAWING_NAMESPACES)) yield child;
    else yield* shapeParagraphs(child);
  }
}

/** Parse only inert structured text and element addresses from a verified package. */
export function readStructuredPageDocument(bytes: Buffer, format: StructuredFormat, index: number): PreviewPageDocument {
  if (!Number.isSafeInteger(index) || index < 0) throw new TableDocumentError("invalid-index", "Page index must be a non-negative integer.");
  const parts = packageParts(bytes, format);
  const paths = format === "pptx" ? slidePaths(parts) : [""];
  if (index >= Math.min(paths.length, PAGE_PREVIEW_LIMITS.maxPages)) throw new TableDocumentError("page-not-found", "Requested page does not exist.");
  const source = format === "pptx" ? slidePage(parts, paths[index]!, index) : (() => {
    const values = format === "docx" ? documentParagraphs(parts) : textParagraphs(parts);
    return boundedPage(values.paragraphs, values.elements);
  })();
  return { format, totalPages: paths.length, pagesTruncated: paths.length > PAGE_PREVIEW_LIMITS.maxPages,
    elements: source.elements,
    page: { index, paragraphs: source.paragraphs, textTruncated: source.truncated, png: null, width: 0, height: 0 } };
}

/** A bounded element projection; page readers also carry its truncation notice. */
export function readStructuredDocumentElements(bytes: Buffer, format: StructuredFormat): PreviewDocumentElement[] {
  const parts = packageParts(bytes, format);
  if (format !== "pptx") {
    const values = format === "docx" ? documentParagraphs(parts) : textParagraphs(parts);
    return boundedPage(values.paragraphs, values.elements).elements;
  }
  function* elements(): Generator<PreviewDocumentElement> {
    for (const [index, path] of slidePaths(parts).slice(0, PAGE_PREVIEW_LIMITS.maxPages).entries()) yield* slidePage(parts, path, index).elements;
  }
  return bounded(elements(), (value) => value.text, (value, text) => ({ ...value, text })).values;
}
