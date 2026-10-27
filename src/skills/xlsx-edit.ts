/** Patches existing ordinary workbook cells while retaining untouched package bytes. */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import JSZip from "jszip";
import { XMLValidator } from "fast-xml-parser";
import { verifyZipInflateLimits } from "../tools/zip-inflate-guard.js";
import { replaceStagedFile } from "../lib/atomic-file.js";

const BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_BYTES = 20 * 1024 * 1024;
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const TYPE_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const WORKBOOK_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const ZIP_LIMITS = { maxUncompressedBytes: 200 * 1024 * 1024, maxArchiveEntries: 10000,
  maxCompressionRatio: 200, ratioCheckMinBytes: 1024 * 1024 };

interface XmlElement {
  name: string;
  tag: string;
  attrs: Record<string, string>;
  namespaces: Record<string, string>;
  start: number;
  headEnd: number;
  end: number;
  closeStart: number;
  empty: boolean;
  children: XmlElement[];
}
interface Replacement { start: number; end: number; text: string }
interface WorkbookEdit { cell: string; value?: unknown; formula?: unknown }
export interface WorkbookEditIo {
  write?: (descriptor: number, bytes: Buffer, offset: number, length: number) => number;
}
export interface WorkbookEditResult { editedCells: number; needsRecalculation: true; backup: string | null }

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function validXmlCharacter(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}
function xmlText(value: string): string {
  requireCondition([...value].every((char) => validXmlCharacter(char.codePointAt(0)!)), "Unsupported XML character.");
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");
}
function quoteAttribute(value: string): string {
  return `"${xmlText(value).replaceAll('"', "&quot;").replaceAll("\t", "&#9;").replaceAll("\n", "&#10;")}"`;
}
function decodeEntities(value: string): string {
  return value.replace(/&([^;]*);|&/g, (match, entity: string | undefined) => {
    const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity !== undefined && Object.hasOwn(predefined, entity)) return predefined[entity]!;
    requireCondition(entity !== undefined && /^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(entity), "Unsupported XML entity.");
    const code = entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    requireCondition(validXmlCharacter(code), "Unsupported XML character.");
    requireCondition(match.endsWith(";"), "Unsupported XML entity.");
    return String.fromCodePoint(code);
  });
}
function expandedName(tag: string, namespaces: Record<string, string>, attribute = false): string {
  const colon = tag.indexOf(":");
  if (colon < 0) return attribute || !namespaces[""] ? tag : `${namespaces[""]}|${tag}`;
  const prefix = tag.slice(0, colon);
  requireCondition(Object.hasOwn(namespaces, prefix) && Boolean(namespaces[prefix]), "Unbound XML namespace.");
  return `${namespaces[prefix]}|${tag.slice(colon + 1)}`;
}

/** Retains source offsets and namespace bindings rather than serializing a tree. */
function xmlTree(raw: Buffer | string): { text: string; root: XmlElement } {
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  for (const char of text) requireCondition(validXmlCharacter(char.codePointAt(0)!), "Unsupported XML character.");
  const encoding = /^(?:\ufeff)?<\?xml\s[^?]*\bencoding\s*=\s*['"]([^'"]+)['"][^?]*\?>/.exec(text)?.[1];
  requireCondition(!encoding || encoding.toLowerCase() === "utf-8", "Only UTF-8 XML is supported.");
  requireCondition(!/<!DOCTYPE|<!ENTITY/i.test(text), "XML declarations are unsupported.");
  requireCondition(XMLValidator.validate(text) === true, "Invalid XML.");
  const stack: XmlElement[] = [];
  const roots: XmlElement[] = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  let textOffset = 0;
  for (const match of text.matchAll(tokens)) {
    decodeEntities(text.slice(textOffset, match.index));
    const head = match[0];
    textOffset = match.index! + head.length;
    if (head.startsWith("<!") || head.startsWith("<?")) continue;
    if (head.startsWith("</")) {
      const node = stack.pop();
      requireCondition(node && head.slice(2, -1).trim() === node.tag, "Unbalanced XML tags.");
      node.closeStart = match.index!;
      node.end = match.index! + head.length;
      continue;
    }
    const tag = /^<([^\s/>]+)/.exec(head)![1]!;
    requireCondition(tag.split(":").length <= 2, "Invalid XML namespace name.");
    const pairs = [...head.matchAll(/\s([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)];
    const namespaces = Object.assign(Object.create(null) as Record<string, string>, stack.at(-1)?.namespaces ?? { xml: XML_NS });
    for (const pair of pairs) {
      const key = pair[1]!;
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        const prefix = key === "xmlns" ? "" : key.slice(6);
        const uri = decodeEntities((pair[2] ?? pair[3]!).replace(/\r\n?|\n|\t/g, " "));
        requireCondition(prefix !== "xmlns" && uri !== XMLNS_NS && (prefix === "xml" ? uri === XML_NS : uri !== XML_NS)
          && (!prefix || Boolean(uri)), "Invalid XML namespace binding.");
        namespaces[prefix] = uri;
      }
    }
    const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const pair of pairs) {
      const key = pair[1]!;
      if (key === "xmlns" || key.startsWith("xmlns:")) continue;
      requireCondition(key.split(":").length <= 2, "Invalid XML namespace name.");
      const name = expandedName(key, namespaces, true);
      requireCondition(!Object.hasOwn(attrs, name), "Duplicate XML attribute.");
      attrs[name] = decodeEntities((pair[2] ?? pair[3]!).replace(/\r\n?|\n|\t/g, " "));
    }
    const headEnd = match.index! + head.length;
    const node: XmlElement = { name: expandedName(tag, namespaces), tag, attrs, namespaces,
      start: match.index!, headEnd, end: headEnd, closeStart: headEnd, empty: /\/\s*>$/.test(head), children: [] };
    (stack.at(-1)?.children ?? roots).push(node);
    if (!node.empty) stack.push(node);
  }
  decodeEntities(text.slice(textOffset));
  requireCondition(stack.length === 0 && roots.length === 1, "XML must have one root.");
  return { text, root: roots[0]! };
}
function children(node: XmlElement, local: string, namespace = MAIN_NS): XmlElement[] {
  return node.children.filter((child) => child.name === `${namespace}|${local}`);
}
function* walk(root: XmlElement): Generator<XmlElement> {
  const pending = [root];
  while (pending.length) { const node = pending.pop()!; yield node; pending.push(...node.children); }
}
function patch(raw: string, replacements: Replacement[]): Buffer {
  for (const item of replacements.sort((a, b) => b.start - a.start)) raw = raw.slice(0, item.start) + item.text + raw.slice(item.end);
  xmlTree(raw);
  return Buffer.from(raw, "utf8");
}
function qualified(node: XmlElement, local: string): string {
  return node.tag.includes(":") ? `${node.tag.slice(0, node.tag.lastIndexOf(":"))}:${local}` : local;
}
function openingWith(raw: string, node: XmlElement, attributes: Record<string, string>): string {
  let head = raw.slice(node.start, node.headEnd);
  for (const [key, value] of Object.entries(attributes)) {
    head = head.replace(new RegExp(`\\s${key}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "g"), "");
    const end = head.lastIndexOf(node.empty ? "/>" : ">");
    head = head.slice(0, end) + ` ${key}=${quoteAttribute(value)}` + head.slice(end);
  }
  return head;
}
function cellXml(raw: string, cell: XmlElement, edit: WorkbookEdit): string {
  requireCondition(Object.keys(cell.attrs).every((name) => ["r", "s", "t"].includes(name)), "Cell metadata cannot be safely replaced.");
  requireCondition(cell.children.every((child) => ["f", "v", "is"].some((name) => child.name === `${MAIN_NS}|${name}`)), "Cell extensions cannot be safely replaced.");
  const tag = qualified(cell, "c");
  const prefix = tag.slice(0, -1);
  let attrs = ` r=${quoteAttribute(cell.attrs.r!)}`;
  for (const declaration of raw.slice(cell.start, cell.headEnd).matchAll(/\sxmlns(?::[A-Za-z_][\w.-]*)?\s*=\s*(?:"[^"]*"|'[^']*')/g)) attrs += declaration[0];
  if (cell.attrs.s !== undefined) attrs += ` s=${quoteAttribute(cell.attrs.s)}`;
  let content: string;
  if (Object.hasOwn(edit, "formula")) {
    const formula = edit.formula;
    requireCondition(typeof formula === "string" && [...formula].length > 0 && [...formula].length <= 8192, "Invalid formula.");
    requireCondition(!formula.startsWith("="), "Formulas omit the leading equals sign.");
    content = `<${prefix}f>${xmlText(formula)}</${prefix}f>`;
  } else {
    const value = edit.value;
    if (value === null) content = "";
    else if (typeof value === "boolean") { attrs += ' t="b"'; content = `<${prefix}v>${Number(value)}</${prefix}v>`; }
    else if (typeof value === "number") {
      requireCondition(Number.isFinite(value), "Invalid numeric value.");
      content = `<${prefix}v>${value}</${prefix}v>`;
    } else {
      requireCondition(typeof value === "string" && [...value].length <= 32767, "Invalid cell value.");
      attrs += ' t="inlineStr"';
      const escaped = value.replace(/_x[0-9a-fA-F]{4}_/g, (match) => `_x005F_${match.slice(1)}`);
      content = `<${prefix}is><${prefix}t xml:space="preserve">${xmlText(escaped)}</${prefix}t></${prefix}is>`;
    }
  }
  return `<${tag}${attrs}>${content}</${tag}>`;
}
function addressInRange(address: string, region: string): boolean {
  function coordinates(value: string): [number, number] {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(value);
    requireCondition(match, "Invalid merged-cell range.");
    let column = 0;
    for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
    return [column, Number(match[2])];
  }
  const ends = region.split(":");
  requireCondition(ends.length === 1 || ends.length === 2, "Invalid merged-cell range.");
  const first = coordinates(ends[0]!); const last = coordinates(ends.at(-1)!); const cell = coordinates(address);
  return first[0] <= cell[0] && cell[0] <= last[0] && first[1] <= cell[1] && cell[1] <= last[1];
}
function readPackage(data: Buffer, compressions?: Map<string, "STORE" | "DEFLATE">): Map<string, Buffer> {
  const parts = new Map<string, Buffer>();
  const verdict = verifyZipInflateLimits(data, ZIP_LIMITS, { onEntry: (name, bytes) => { parts.set(name, bytes); } });
  requireCondition(verdict.ok, verdict.ok ? "" : verdict.detail);
  requireCondition(parts.size > 0, "Ambiguous ZIP members.");
  // Inspect original attributes; canonical framing intentionally drops them.
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset -= 1) {
    if (data.readUInt32LE(offset) !== 0x06054b50 || offset + 22 + data.readUInt16LE(offset + 20) !== data.length) continue;
    let central = data.readUInt32LE(offset + 16);
    for (let index = 0; index < data.readUInt16LE(offset + 10); index += 1) {
      const nameLength = data.readUInt16LE(central + 28);
      compressions?.set(data.subarray(central + 46, central + 46 + nameLength).toString("utf8"), data.readUInt16LE(central + 10) === 8 ? "DEFLATE" : "STORE");
      requireCondition(((data.readUInt32LE(central + 38) >>> 16) & 0xf000) !== 0xa000, "Linked ZIP member.");
      central += 46 + data.readUInt16LE(central + 28) + data.readUInt16LE(central + 30) + data.readUInt16LE(central + 32);
    }
    break;
  }
  for (const name of parts.keys()) requireCondition(!name.toLowerCase().startsWith("_xmlsignatures/") && !name.toLowerCase().endsWith("vbaproject.bin"), "Signed or macro workbook is unsupported.");
  return parts;
}
function requiredPart(parts: Map<string, Buffer>, name: string): Buffer {
  const bytes = parts.get(name); requireCondition(bytes, `Missing package part: ${name}`); return bytes;
}

async function editPackage(data: Buffer, request: unknown): Promise<{ output: Buffer; editedCells: number }> {
  requireCondition(isRecord(request) && hasKeys(request, ["sheet", "edits"]), "Expected sheet and edits only.");
  const { sheet: sheetIndex, edits } = request;
  requireCondition(typeof sheetIndex === "number" && Number.isInteger(sheetIndex) && sheetIndex >= 0, "Invalid sheet index.");
  requireCondition(Array.isArray(edits) && edits.length > 0 && edits.length <= 500, "Expected 1 to 500 edits.");
  const compressions = new Map<string, "STORE" | "DEFLATE">();
  const parts = readPackage(data, compressions);
  const types = xmlTree(requiredPart(parts, "[Content_Types].xml"));
  requireCondition(types.root.name === `${TYPE_NS}|Types`, "Invalid content types.");
  const overrides = children(types.root, "Override", TYPE_NS);
  requireCondition(new Set(overrides.map((node) => node.attrs.PartName)).size === overrides.length, "Duplicate content type declaration.");
  requireCondition(overrides.some((node) => node.attrs.PartName === "/xl/workbook.xml" && node.attrs.ContentType === WORKBOOK_TYPE), "Only ordinary XLSX workbooks are supported.");
  requireCondition(!overrides.some((node) => /macroEnabled|digital-signature/.test(node.attrs.ContentType ?? "")), "Signed or macro workbook is unsupported.");
  const officeRels = children(xmlTree(requiredPart(parts, "_rels/.rels")).root, "Relationship", PACKAGE_NS)
    .filter((node) => node.attrs.Type === `${REL_NS}/officeDocument`);
  requireCondition(officeRels.length === 1 && officeRels[0]!.attrs.Target?.replace(/^\/+/, "") === "xl/workbook.xml"
    && (officeRels[0]!.attrs.TargetMode ?? "Internal") === "Internal", "Invalid workbook relationship.");
  const workbook = xmlTree(requiredPart(parts, "xl/workbook.xml"));
  requireCondition(workbook.root.name === `${MAIN_NS}|workbook`, "Unsupported workbook namespace.");
  const sheets = children(workbook.root, "sheets");
  requireCondition(sheets.length === 1 && sheetIndex < children(sheets[0]!, "sheet").length, "Sheet does not exist.");
  const selected = children(sheets[0]!, "sheet")[sheetIndex]!;
  const rels = xmlTree(requiredPart(parts, "xl/_rels/workbook.xml.rels"));
  const relationships = children(rels.root, "Relationship", PACKAGE_NS);
  requireCondition(new Set(relationships.map((node) => node.attrs.Id)).size === relationships.length, "Duplicate workbook relationship.");
  const matches = relationships.filter((node) => node.attrs.Id === selected.attrs[`${REL_NS}|id`]);
  requireCondition(matches.length === 1, "Ambiguous sheet relationship.");
  const relationship = matches[0]!.attrs;
  const target = relationship.Target ?? "";
  requireCondition(relationship.Type === `${REL_NS}/worksheet` && (relationship.TargetMode ?? "Internal") === "Internal", "Unsupported sheet relationship.");
  const sheetPath = target.startsWith("/") ? target.replace(/^\/+/, "") : `xl/${target}`;
  requireCondition(/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath), "Unsupported sheet path.");
  const sheet = xmlTree(requiredPart(parts, sheetPath));
  requireCondition(sheet.root.name === `${MAIN_NS}|worksheet`, "Unsupported sheet namespace.");
  requireCondition(!children(sheet.root, "sheetProtection").length && !children(sheet.root, "tableParts").length, "Protected or table-managed sheets cannot be safely edited.");
  for (const node of walk(sheet.root)) if (node.name === `${MAIN_NS}|f`) requireCondition(Object.keys(node.attrs).length === 0, "Shared, array or data-table formulas cannot be safely edited.");
  const rows = children(sheet.root, "sheetData");
  requireCondition(rows.length === 1, "Expected one sheetData element.");
  const cells = new Map<string | undefined, XmlElement>();
  for (const row of children(rows[0]!, "row")) for (const cell of children(row, "c")) {
    requireCondition(!cells.has(cell.attrs.r), "Duplicate cell address."); cells.set(cell.attrs.r, cell);
  }
  const replacements: Replacement[] = [];
  const seen = new Set<string>();
  for (const edit of edits) {
    requireCondition(isRecord(edit) && (hasKeys(edit, ["cell", "value"]) || hasKeys(edit, ["cell", "formula"])), "Expected cell and exactly one value or formula.");
    const address = edit.cell;
    requireCondition(typeof address === "string" && /^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(address) && cells.has(address) && !seen.has(address), "Edit requires a unique existing cell address.");
    seen.add(address);
    for (const merged of children(sheet.root, "mergeCells")) for (const region of children(merged, "mergeCell")) requireCondition(!addressInRange(address, region.attrs.ref ?? ""), "Merged cells cannot be safely edited.");
    const cell = cells.get(address)!;
    replacements.push({ start: cell.start, end: cell.end, text: cellXml(sheet.text, cell, edit as unknown as WorkbookEdit) });
  }
  parts.set(sheetPath, patch(sheet.text, replacements));
  const retained = new Set<string | undefined>([...walk(xmlTree(parts.get(sheetPath)!).root)].filter((node) => node.name === `${MAIN_NS}|c`).map((node) => node.attrs.r));
  requireCondition(cells.size === retained.size && [...cells.keys()].every((address) => retained.has(address)), "Edited cell namespace or identity changed.");
  const calc = children(workbook.root, "calcPr");
  requireCondition(calc.length <= 1, "Ambiguous calculation properties.");
  const attributes = { fullCalcOnLoad: "1", forceFullCalc: "1", calcCompleted: "0", calcMode: "auto" };
  if (calc.length) {
    const node = calc[0]!;
    parts.set("xl/workbook.xml", patch(workbook.text, [{ start: node.start, end: node.headEnd, text: openingWith(workbook.text, node, attributes) }]));
  } else {
    const trailing = new Set(["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes", "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"].map((name) => `${MAIN_NS}|${name}`));
    const position = workbook.root.children.find((node) => trailing.has(node.name))?.start ?? workbook.root.closeStart;
    parts.set("xl/workbook.xml", patch(workbook.text, [{ start: position, end: position,
      text: `<${qualified(workbook.root, "calcPr")} ${Object.entries(attributes).map(([key, value]) => `${key}=${quoteAttribute(value)}`).join(" ")}/>` }]));
  }
  const chainRels = relationships.filter((node) => node.attrs.Type === `${REL_NS}/calcChain`);
  const chainPaths = new Set<string>();
  for (const rel of chainRels) {
    const target = rel.attrs.Target ?? "";
    const path = target.startsWith("/") ? target.replace(/^\/+/, "") : `xl/${target}`;
    requireCondition(path === "xl/calcChain.xml" && (rel.attrs.TargetMode ?? "Internal") === "Internal", "Unsupported calculation chain.");
    chainPaths.add(path);
  }
  requireCondition(!parts.has("xl/calcChain.xml") || chainPaths.has("xl/calcChain.xml"), "Unlinked calculation chain.");
  if (chainRels.length) {
    parts.set("xl/_rels/workbook.xml.rels", patch(rels.text, chainRels.map((node) => ({ start: node.start, end: node.end, text: "" }))));
    parts.set("[Content_Types].xml", patch(types.text, overrides.filter((node) => chainPaths.has((node.attrs.PartName ?? "").replace(/^\/+/, ""))).map((node) => ({ start: node.start, end: node.end, text: "" }))));
    for (const path of chainPaths) parts.delete(path);
  }
  const archive = await JSZip.loadAsync(data);
  for (const [name, entry] of Object.entries(archive.files)) {
    const bytes = parts.get(name);
    if (!bytes) { archive.remove(name); continue; }
    if (!entry.dir) archive.file(name, bytes, { date: entry.date, comment: entry.comment,
      unixPermissions: entry.unixPermissions, dosPermissions: entry.dosPermissions, createFolders: false, compression: compressions.get(name) });
  }
  const output = await archive.generateAsync({ type: "nodebuffer", compression: "STORE", platform: "UNIX" });
  requireCondition(output.length <= MAX_BYTES, "Edited workbook exceeds the file limit.");
  const checked = readPackage(output);
  requireCondition(checked.size === parts.size && [...parts].every(([name, bytes]) => checked.get(name)?.equals(bytes)), "Output package validation failed.");
  return { output, editedCells: edits.length };
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (["dev", "ino", "size", "mtimeNs", "mode", "nlink"] as const).every((key) => left[key] === right[key]);
}
function temporaryFile(path: string): { path: string; descriptor: number } {
  const temporary = join(dirname(path), `.ave-xlsx-${randomBytes(12).toString("hex")}.tmp`);
  return { path: temporary, descriptor: fs.openSync(temporary, "wx", 0o600) };
}
function writeAndSync(descriptor: number, bytes: Buffer, io: WorkbookEditIo): void {
  let offset = 0;
  while (offset < bytes.length) {
    const length = Math.min(64 * 1024, bytes.length - offset);
    const written = (io.write ?? fs.writeSync)(descriptor, bytes, offset, length);
    requireCondition(Number.isInteger(written) && written > 0 && written <= length, "Incomplete file write.");
    offset += written;
  }
  fs.fsyncSync(descriptor);
}
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Stages recovery bytes for larger files and checks source changes before replacement. */
export async function editWorkbookFile(path: string, request: unknown, io: WorkbookEditIo = {}): Promise<WorkbookEditResult> {
  path = resolve(path);
  requireCondition(extname(path).toLowerCase() === ".xlsx", "Only .xlsx files can be edited.");
  const before = fs.lstatSync(path, { bigint: true });
  requireCondition(before.isFile() && before.nlink === 1n, "Workbook must be a singly linked regular file.");
  requireCondition(before.size <= BigInt(MAX_BYTES), "Workbook exceeds 20 MiB.");
  const descriptor = fs.openSync(path, "r");
  let data: Buffer;
  try {
    requireCondition(sameIdentity(before, fs.fstatSync(descriptor, { bigint: true })), "Workbook changed before reading.");
    data = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < data.length) { const count = fs.readSync(descriptor, data, offset, data.length - offset, null); if (!count) break; offset += count; }
    requireCondition(offset === Number(before.size), "Workbook changed while reading.");
    data = data.subarray(0, offset);
  } finally { fs.closeSync(descriptor); }
  const { output, editedCells } = await editPackage(data, request);
  let backup: string | null = null;
  if (data.length > BACKUP_BYTES) {
    backup = `${path}.ave-bak`;
    const staged = temporaryFile(path);
    try {
      try { writeAndSync(staged.descriptor, data, io); } finally { fs.closeSync(staged.descriptor); }
      const saved = fs.readFileSync(staged.path);
      requireCondition(saved.length === data.length && sha256(saved) === sha256(data), "Backup verification failed.");
      fs.linkSync(staged.path, backup);
    } finally { fs.unlinkSync(staged.path); }
  }
  const staged = temporaryFile(path);
  try {
    try { writeAndSync(staged.descriptor, output, io); } finally { fs.closeSync(staged.descriptor); }
    requireCondition(sameIdentity(before, fs.lstatSync(path, { bigint: true })) && fs.readFileSync(path).equals(data), "Workbook changed before replacement.");
    fs.chmodSync(staged.path, Number(before.mode & 0o7777n));
    replaceStagedFile(staged.path, path);
  } finally { if (fs.existsSync(staged.path)) fs.unlinkSync(staged.path); }
  return { editedCells, needsRecalculation: true, backup };
}
