import type { PreviewDocumentLimits } from "../shared/preview-document.js";
import { TableDocumentError } from "./table-document-error.js";
import { verifyZipInflateLimits } from "./zip-inflate-guard.js";

export const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const ODS_MIMETYPE = "application/vnd.oasis.opendocument.spreadsheet";
const WORKBOOK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const OFFICE_DOCUMENT_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet",
]);
const PACKAGE_PARTS = new Set([
  "[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels",
  "mimetype", "META-INF/manifest.xml", "content.xml",
]);
const XML_PART_NAME = /\.(?:xml|rels)$/i;
// Legacy VML is not well-formed XML (Excel writes bare <br>), so it gets the
// declaration byte check but not the full tag scan.
const VML_PART_NAME = /\.vml$/i;
// The decoder's own match for a sheet's legacy drawing reference.
const LEGACY_DRAWING_REFERENCE = /legacyDrawing r:id="(.*?)"/;
// The decoder reads these relationship targets as XML whatever their part name.
const XML_TARGET_RELATIONSHIP_TYPES = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/comments",
  "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment",
]);
// Parts the decoder reads by content type for any requested sheet; themes and
// calculation chains stay unread with the options parseWorkbook passes.
const EXTERNAL_LINK_CONTENT_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml",
  "application/vnd.ms-excel.externalLink",
]);
const SHARED_PART_CONTENT_TYPES = new Set([
  ...EXTERNAL_LINK_CONTENT_TYPES,
  WORKBOOK_CONTENT_TYPE,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml",
  "application/vnd.ms-excel.sharedStrings",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml",
  "application/vnd.ms-excel.styles",
  "application/vnd.openxmlformats-package.core-properties+xml",
  "application/vnd.openxmlformats-officedocument.custom-properties+xml",
  "application/vnd.openxmlformats-officedocument.extended-properties+xml",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml",
  "application/vnd.ms-excel.sheetMetadata",
  "application/vnd.ms-excel.person+xml",
]);
const ODS_DECODED_PARTS = ["meta-inf/manifest.xml", "content.xml", "styles.xml", "meta.xml"];

interface XmlTag {
  name: string;
  localName: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: ReadonlyMap<string, string>;
}

interface PackageRelationship {
  id: string;
  type: string;
  target: string;
  internal: boolean;
}

function refuse(message: string): never {
  throw new TableDocumentError("corrupt-document", message);
}

const NO_ATTRIBUTES: ReadonlyMap<string, string> = new Map();

/** End of an ASCII `[A-Za-z_][\w.:-]*` name at `start`, or `start` when none begins there. */
function nameEnd(xml: string, start: number): number {
  let position = start;
  for (;; position += 1) {
    const code = xml.charCodeAt(position);
    const letter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
    if (letter || (position > start && ((code >= 0x30 && code <= 0x39) || code === 0x2e || code === 0x3a || code === 0x2d))) continue;
    return position;
  }
}

/** End of the XML whitespace run at `start`. */
function spaceEnd(xml: string, start: number): number {
  let position = start;
  let code = xml.charCodeAt(position);
  while (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) code = xml.charCodeAt(++position);
  return position;
}

/** Scans tags without expanding entities or allocating any document objects. */
function scanXml(bytes: Buffer, onTag: (tag: XmlTag) => void): void {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return refuse("Package XML is not valid UTF-8");
  }
  if (xml.includes("\0")) refuse("Package XML contains unsupported encoding bytes");
  let offset = 0;
  const stack: string[] = [];
  while ((offset = xml.indexOf("<", offset)) >= 0) {
    const marker = xml.charCodeAt(offset + 1);
    if (marker === 0x21 && xml.startsWith("<!--", offset)) {
      const end = xml.indexOf("-->", offset + 4);
      if (end < 0) refuse("Unterminated XML comment");
      offset = end + 3;
      continue;
    }
    if (marker === 0x3f) {
      const end = xml.indexOf("?>", offset + 2);
      if (end < 0 || xml.slice(offset + 2, end).includes("<")) refuse("Invalid XML processing instruction");
      const declaration = xml.slice(offset, end);
      const encoding = /\bencoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1];
      if (encoding && !/^utf-?8$/i.test(encoding)) refuse("Package XML encoding is unsupported");
      offset = end + 2;
      continue;
    }
    // Text sections and declarations can expose a different tag stream to a
    // permissive decoder, so this boundary accepts ordinary XML tags only.
    if (marker === 0x21) refuse("Package XML declarations and text sections are unsupported");
    // Character codes read the tag in place: worksheet-sized parts reach this
    // loop, and per-tag substrings and regex matches dominated its cost.
    let position = offset + 1;
    const closing = xml.charCodeAt(position) === 0x2f;
    if (closing) position += 1;
    const nameStart = position;
    position = nameEnd(xml, position);
    if (position === nameStart) refuse("Invalid XML tag name");
    const name = xml.slice(nameStart, position);
    const localName = name.slice(name.lastIndexOf(":") + 1);
    let attributes: Map<string, string> | undefined;
    for (;;) {
      const spaceStart = position;
      position = spaceEnd(xml, position);
      const keyStart = position;
      // Each attribute needs leading whitespace; anything else must end the tag.
      if (position === spaceStart || (position = nameEnd(xml, position)) === keyStart) break;
      const key = xml.slice(keyStart, position);
      position = spaceEnd(xml, position);
      if (xml.charCodeAt(position) !== 0x3d) refuse("Invalid XML attribute");
      position = spaceEnd(xml, position + 1);
      const quote = xml.charCodeAt(position);
      if (quote !== 0x22 && quote !== 0x27) refuse("Invalid XML attribute");
      const valueEnd = xml.indexOf(quote === 0x22 ? '"' : "'", position + 1);
      if (valueEnd < 0) refuse("Unterminated XML tag");
      const value = xml.slice(position + 1, valueEnd);
      if (value.includes("<")) refuse("Invalid XML tag contents");
      position = valueEnd + 1;
      attributes ??= new Map();
      // Attribute namespaces do not separate expansion controls for the
      // decoder; reject duplicate effective names before inspecting values.
      const effectiveName = key.slice(key.lastIndexOf(":") + 1).toLowerCase();
      if (attributes.has(effectiveName)) refuse("Duplicate XML attribute name");
      attributes.set(effectiveName, value);
    }
    const selfClosing = xml.charCodeAt(position) === 0x2f;
    if (selfClosing) position = spaceEnd(xml, position + 1);
    if (xml.charCodeAt(position) !== 0x3e) refuse("Invalid or unterminated XML tag");
    if (closing) {
      if (selfClosing || attributes || stack.pop() !== name) refuse("Unbalanced XML tags");
    } else if (!selfClosing) stack.push(name);
    onTag({ name, localName, closing, selfClosing, attributes: attributes ?? NO_ATTRIBUTES });
    offset = position + 1;
  }
  if (stack.length > 0) refuse("Unclosed XML tags");
}

/** Native byte search over every XML part, read for this request or not. */
function refuseXmlDeclarations(bytes: Buffer): void {
  for (let offset = bytes.indexOf("<!"); offset >= 0; offset = bytes.indexOf("<!", offset + 2)) {
    if (bytes[offset + 2] !== 0x2d || bytes[offset + 3] !== 0x2d) {
      refuse("Package XML declarations and text sections are unsupported");
    }
  }
}

/** The decoder looks parts up case-insensitively and with either separator. */
function partKey(name: string): string {
  return name.toLowerCase().replaceAll("\\", "/");
}

/** The decoder's resolution of a relationship target against its source part. */
function resolveTarget(target: string, source: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const result = source.split("/");
  result.pop();
  for (const step of target.split("/")) {
    if (step === "..") result.pop();
    else if (step !== ".") result.push(step);
  }
  return result.join("/");
}

function requiredPart(parts: ReadonlyMap<string, Buffer>, name: string): Buffer {
  const bytes = parts.get(name);
  if (!bytes) refuse(`Missing package part: ${name}`);
  return bytes;
}

function validateXmlRoot(bytes: Buffer, expected: string): void {
  let root: string | undefined;
  scanXml(bytes, (tag) => { if (root === undefined) root = tag.localName; });
  if (root !== expected) refuse(`Invalid package XML root: ${expected}`);
}

function scanRelationships(bytes: Buffer, onRelationship: (relationship: PackageRelationship) => void): void {
  validateXmlRoot(bytes, "Relationships");
  const ids = new Set<string>();
  scanXml(bytes, (tag) => {
    if (tag.closing || tag.localName !== "Relationship") return;
    const id = tag.attributes.get("id");
    const type = tag.attributes.get("type");
    const target = tag.attributes.get("target");
    const mode = tag.attributes.get("targetmode") ?? "Internal";
    if (!id || !type || !target || ids.has(id) || (mode !== "Internal" && mode !== "External")) {
      refuse("Invalid or duplicate package relationship");
    }
    ids.add(id);
    // The decoder unescapes entities in targets; a raw target must name the same part.
    if (mode === "Internal" && target.includes("&")) refuse("Package relationship target contains an entity");
    onRelationship({ id, type, target, internal: mode === "Internal" });
  });
}

/** Validates the package and returns the keys of the parts decoded for `sheetIndex`. */
function validateXlsx(
  parts: ReadonlyMap<string, Buffer>,
  names: ReadonlySet<string>,
  xmlParts: ReadonlyMap<string, Buffer>,
  sheetIndex: number,
): Set<string> {
  const lowerNames = new Set([...names].map((name) => name.toLowerCase()));
  if (["meta-inf/manifest.xml", "objectdata.xml", "index/document.iwa"].some((name) => lowerNames.has(name))) {
    refuse("Package declares conflicting document families");
  }
  const contentTypes = new Map<string, string>();
  const typeBytes = requiredPart(parts, "[Content_Types].xml");
  validateXmlRoot(typeBytes, "Types");
  scanXml(typeBytes, (tag) => {
    if (!tag.closing && tag.localName === "Override") {
      const path = tag.attributes.get("partname");
      const type = tag.attributes.get("contenttype");
      if (!path || !type || contentTypes.has(path)) refuse("Invalid or duplicate content type declaration");
      // Only XML-named parts are scanned, so an XML part may not hide behind another name.
      if (/[+/]xml$/i.test(type) && !XML_PART_NAME.test(path)) refuse("XML package part has a non-XML name");
      if (type.includes(".main") && /spreadsheetml|ms-excel/.test(type)
        && (path !== "/xl/workbook.xml" || type !== WORKBOOK_CONTENT_TYPE)) {
        refuse("Package declares an unsupported workbook family");
      }
      contentTypes.set(path, type);
    }
  });
  if (contentTypes.get("/xl/workbook.xml") !== WORKBOOK_CONTENT_TYPE) refuse("Package does not declare a spreadsheet workbook");
  const decoded = new Set<string>();
  for (const [path, type] of contentTypes) {
    if (!SHARED_PART_CONTENT_TYPES.has(type)) continue;
    // A binary-typed part under any name but .bin is still decoded as XML.
    if (!/\.xml$/i.test(path)) refuse("Decoded package part has a non-XML name");
    const part = path.replace(/^\//, "");
    decoded.add(partKey(part));
    if (EXTERNAL_LINK_CONTENT_TYPES.has(type)) decoded.add(partKey(part.replace(/([^/]*)$/, "_rels/$1.rels")));
  }
  const rootRelationships = requiredPart(parts, "_rels/.rels");
  let workbookLinked = false;
  scanRelationships(rootRelationships, (relationship) => {
    if (OFFICE_DOCUMENT_RELATIONSHIP_TYPES.has(relationship.type)
      && /^\/?xl\/workbook\.xml$/.test(relationship.target)
      && relationship.internal) workbookLinked = true;
  });
  if (!workbookLinked) refuse("Package workbook relationship is missing");

  const workbook = requiredPart(parts, "xl/workbook.xml");
  validateXmlRoot(workbook, "workbook");
  const sheetIds = new Set<string>();
  scanXml(workbook, (tag) => {
    if (!tag.closing && tag.localName === "sheet") {
      const id = tag.attributes.get("id");
      if (!id || sheetIds.has(id)) refuse("Invalid workbook sheet relationship");
      sheetIds.add(id);
    }
  });
  const relationships = requiredPart(parts, "xl/_rels/workbook.xml.rels");
  const linked = new Map<string, string>();
  scanRelationships(relationships, (relationship) => {
    if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type)) return;
    if (!relationship.internal) refuse("Invalid worksheet relationship");
    const path = relationship.target.startsWith("/") ? relationship.target.slice(1) : `xl/${relationship.target}`;
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path) || !names.has(path)
      || contentTypes.get(`/${path}`) !== WORKSHEET_CONTENT_TYPE) {
      refuse("Worksheet package part is missing or ambiguous");
    }
    linked.set(relationship.id, path);
  });
  if (sheetIds.size === 0 || [...sheetIds].some((id) => !linked.has(id))) refuse("Workbook has no complete worksheet relationships");

  // Only the requested worksheet, its relationships and its comments are decoded.
  const sheetId = [...sheetIds][sheetIndex];
  const sheet = sheetId === undefined ? undefined : linked.get(sheetId);
  if (sheet === undefined) return decoded;
  const sheetRelationships = sheet.replace(/([^/]*)$/, "_rels/$1.rels");
  decoded.add(partKey(sheet)).add(partKey(sheetRelationships));
  const relationshipBytes = xmlParts.get(partKey(sheetRelationships));
  if (relationshipBytes) {
    scanRelationships(relationshipBytes, (relationship) => {
      if (relationship.internal && XML_TARGET_RELATIONSHIP_TYPES.has(relationship.type)) {
        decoded.add(partKey(resolveTarget(relationship.target, sheet)));
      }
    });
  }
  // The decoder follows the legacy drawing r:id whatever the relationship type.
  const legacyDrawing = LEGACY_DRAWING_REFERENCE.exec(xmlParts.get(partKey(sheet))?.toString("utf8") ?? "")?.[1];
  if (legacyDrawing !== undefined && relationshipBytes) {
    let target: string | undefined;
    scanRelationships(relationshipBytes, (relationship) => {
      if (relationship.id === legacyDrawing) target = relationship.target;
    });
    const path = target === undefined ? undefined : resolveTarget(target, sheet);
    if (path !== undefined && !XML_PART_NAME.test(path) && !VML_PART_NAME.test(path)) {
      refuse("Legacy drawing targets a part outside the XML checks");
    }
  }
  return decoded;
}

function repeatCount(tag: XmlTag, attribute: string, cap: number): number {
  const raw = tag.attributes.get(attribute);
  if (raw === undefined) return 1;
  if (!/^[0-9]+$/.test(raw)) refuse(`Invalid document repeat count: ${attribute}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > cap) {
    throw new TableDocumentError("archive-too-large", `Expanded document ${attribute} exceeds ${cap}`);
  }
  if (value < 1) refuse(`Invalid document repeat count: ${attribute}`);
  return value;
}

function verifyOdsExpansion(content: Buffer, limits: Readonly<PreviewDocumentLimits>): void {
  let totalRows = 0;
  let totalCells = 0;
  let rowRepeat = 0;
  let rowColumns = 0;
  let inTable = false;
  let root: string | undefined;
  scanXml(content, (tag) => {
    root ??= tag.localName;
    const normalized = tag.localName.replace(/_.*$/, "");
    if (normalized !== tag.localName
      && ["table", "table-row", "table-cell", "covered-table-cell"].includes(normalized)) {
      refuse("Unsupported spreadsheet element alias");
    }
    if (["工作表", "行", "数据"].includes(tag.localName)) refuse("Unsupported spreadsheet element alias");
    for (const key of tag.attributes.keys()) {
      if (/^number-(?:rows|columns)-repeated_/.test(key)) refuse("Unsupported document repeat attribute alias");
    }
    if (tag.localName === "table") {
      if (tag.closing) {
        if (!inTable || rowRepeat > 0) refuse("Unbalanced spreadsheet table");
        inTable = false;
      } else if (!tag.selfClosing) {
        if (inTable) refuse("Nested spreadsheet tables are unsupported");
        inTable = true;
      }
    } else if (tag.localName === "table-row") {
      if (!inTable) refuse("Spreadsheet row is outside a table");
      if (tag.closing) {
        if (rowRepeat === 0) refuse("Unbalanced spreadsheet row");
        rowRepeat = 0;
      } else {
        if (rowRepeat > 0) refuse("Nested spreadsheet rows are unsupported");
        const rows = repeatCount(tag, "number-rows-repeated", limits.maxOdsExpandedRows);
        totalRows += rows;
        if (totalRows > limits.maxOdsExpandedRows) {
          throw new TableDocumentError("archive-too-large", `Expanded document rows exceed ${limits.maxOdsExpandedRows}`);
        }
        rowRepeat = tag.selfClosing ? 0 : rows;
        rowColumns = 0;
      }
    } else if ((tag.localName === "table-cell" || tag.localName === "covered-table-cell") && !tag.closing) {
      if (!inTable || rowRepeat === 0) refuse("Spreadsheet cell is outside a row");
      const columns = repeatCount(tag, "number-columns-repeated", limits.maxOdsExpandedCells);
      rowColumns += columns;
      const cells = rowRepeat * columns;
      totalCells += cells;
      if (!Number.isSafeInteger(cells) || !Number.isSafeInteger(totalCells)
        || rowColumns > limits.maxOdsExpandedCells || totalCells > limits.maxOdsExpandedCells) {
        throw new TableDocumentError("archive-too-large", `Expanded document cells exceed ${limits.maxOdsExpandedCells}`);
      }
    } else if (tag.localName === "table-column" && !tag.closing) {
      repeatCount(tag, "number-columns-repeated", limits.maxOdsExpandedCells);
    }
  });
  if (root !== "document-content" || inTable || rowRepeat > 0) refuse("Invalid spreadsheet content document");
}

function validateOds(parts: ReadonlyMap<string, Buffer>, limits: Readonly<PreviewDocumentLimits>): void {
  if (parts.has("[Content_Types].xml")) refuse("Package declares conflicting document families");
  if (requiredPart(parts, "mimetype").toString("utf8") !== ODS_MIMETYPE) refuse("Package mimetype is not a spreadsheet");
  const manifest = requiredPart(parts, "META-INF/manifest.xml");
  validateXmlRoot(manifest, "manifest");
  let spreadsheetDeclared = false;
  let contentDeclared = false;
  scanXml(manifest, (tag) => {
    if (tag.localName === "encryption-data") throw new TableDocumentError("encrypted", "Package contains encrypted parts");
    if (tag.closing || tag.localName !== "file-entry") return;
    if (tag.attributes.get("full-path") === "/" && tag.attributes.get("media-type") === ODS_MIMETYPE) spreadsheetDeclared = true;
    if (tag.attributes.get("full-path") === "content.xml" && tag.attributes.get("media-type") === "text/xml") contentDeclared = true;
  });
  if (!spreadsheetDeclared || !contentDeclared) refuse("Spreadsheet manifest parts are missing");
  verifyOdsExpansion(requiredPart(parts, "content.xml"), limits);
}

/** Accepts the declared document family and returns only checked container bytes. */
export function prepareWorkbookContainer(
  bytes: Buffer,
  format: "xlsx" | "xls" | "ods",
  limits: Readonly<PreviewDocumentLimits>,
  sheetIndex: number,
  onCalculationState?: (needsRecalculation: boolean) => void,
): Buffer {
  if (format === "xls") {
    if (!CFB_MAGIC.every((byte, index) => bytes[index] === byte)) refuse("Document is not a compound binary workbook");
    return bytes;
  }
  const parts = new Map<string, Buffer>();
  const xmlParts = new Map<string, Buffer>();
  const verdict = verifyZipInflateLimits(bytes, limits, { onEntry: (name, data) => {
    if (PACKAGE_PARTS.has(name)) parts.set(name, data);
    if (VML_PART_NAME.test(name)) refuseXmlDeclarations(data);
    if (!XML_PART_NAME.test(name)) return;
    // No XML or VML part carries a DTD or text section; the full tag scan below
    // is kept for the XML parts decoded for this request, sparing unread worksheets.
    refuseXmlDeclarations(data);
    xmlParts.set(partKey(name), data);
    if (!/\.rels$/i.test(name)) return;
    scanXml(data, (tag) => {
      if (!tag.closing && tag.localName === "Relationship"
        && XML_TARGET_RELATIONSHIP_TYPES.has(tag.attributes.get("type") ?? "")
        && !XML_PART_NAME.test(tag.attributes.get("target") ?? "")) refuse("XML relationship targets a non-XML part");
    });
  } });
  if (!verdict.ok) {
    if (verdict.reason === "encrypted") throw new TableDocumentError("encrypted", verdict.detail);
    if (verdict.reason === "corrupt") refuse(verdict.detail);
    throw new TableDocumentError("archive-too-large", `${verdict.reason}: ${verdict.detail}`);
  }
  let decoded: Iterable<string> = ODS_DECODED_PARTS;
  if (format === "xlsx") decoded = validateXlsx(parts, new Set(verdict.entryNames), xmlParts, sheetIndex);
  else validateOds(parts, limits);
  for (const key of decoded) {
    const part = xmlParts.get(key);
    if (part) scanXml(part, () => {});
  }
  if (format === "xlsx") {
    let needsRecalculation = false;
    scanXml(requiredPart(parts, "xl/workbook.xml"), (tag) => {
      if (tag.closing || tag.localName !== "calcPr") return;
      const enabled = (name: string): boolean => ["1", "true"].includes(tag.attributes.get(name) ?? "");
      if (enabled("fullcalconload") || enabled("forcefullcalc")
        || ["0", "false"].includes(tag.attributes.get("calccompleted") ?? "")) needsRecalculation = true;
    });
    onCalculationState?.(needsRecalculation);
  }
  return verdict.canonicalBytes;
}
