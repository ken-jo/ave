/** Apply the same content rules at install and load; modified files become broken rather than active.
 * Strict entry files reject fields their normalizers would discard or rewrite. */
import { canonicalStringify } from "../../shared/canonical-json.js";
import {
  normalizeMarketplaceMessagingConnection,
  normalizeMarketplaceProviderPreset,
  type MarketplaceInstalledMessagingConnection,
  type MarketplaceInstalledProviderPreset,
} from "../../shared/marketplace-package-assets.js";
import { SUPPORTED_LOCALES } from "../../i18n/locale.js";
import { isModelFacingKey } from "../../i18n/model-facing.js";
import type { FontFormat } from "../../shared/installed-content.js";
import { isMarketplaceEligibleLLMVendor, type MarketplaceEligibleLLMVendor } from "../../shared/llm-vendor-defaults.js";
import { isBundleId, isThemeId } from "../../shared/theme-bundles.js";
import { themeSurfaceProblems, themeTokenProblems, type ThemeSurfaces, type ThemeTokens } from "../../shared/theme-tokens.js";
import { parseAgentFrontmatter } from "../../main/agent-profile-store.js";
import { parseFrontmatter } from "../../main/skill-store.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { ContentKind } from "./rules.js";
import { deriveAgentPluginComponents } from "./agent-plugin-components.js";
import type { AgentPluginComponents } from "../catalog/types.js";

export interface ContentFile {
  path: string;
  data: Buffer;
  executable?: boolean;
}

interface ThemeContent {
  kind: "theme";
  name: string;
  description: string;
  shell: "light" | "dark";
  highContrast: boolean;
  tokens: ThemeTokens;
  surfaces: ThemeSurfaces;
  preview?: string;
  pair?: string;
}

interface LanguageContent {
  kind: "language";
  locale: string;
  nativeName: string;
  englishName: string;
  messages: Record<string, string>;
  missingKeys: string[];
}

interface FontContent {
  kind: "font";
  family: string;
  faces: Array<{ file: string; format: FontFormat; weight: string; style: "normal" | "italic" }>;
}

/** Built-in provider base URLs may be overridden only by official or managed sources. */
type ProviderContent =
  | { kind: "provider"; preset: MarketplaceInstalledProviderPreset }
  | { kind: "provider"; vendor: { providerId: MarketplaceEligibleLLMVendor; defaultModel?: string; baseUrl?: string } };

interface MessagingConnectionContent {
  kind: "messaging-connection";
  connection: MarketplaceInstalledMessagingConnection;
}

interface InstructionContent {
  kind: "skill" | "agent";
  name: string;
  description: string;
}

interface AgentPluginContent {
  kind: "agent-plugin";
  components: AgentPluginComponents;
  files: readonly ContentFile[];
}

export type ParsedContent = ThemeContent | LanguageContent | FontContent | ProviderContent | MessagingConnectionContent | InstructionContent | AgentPluginContent;

export type DataContentKind = ParsedContent["kind"];

export function isDataContentKind(kind: ContentKind): kind is DataContentKind {
  return (
    kind === "agent-plugin" ||
    kind === "theme" ||
    kind === "language" ||
    kind === "font" ||
    kind === "provider" ||
    kind === "messaging-connection" ||
    kind === "skill" ||
    kind === "agent"
  );
}

export interface ContentContext {
  name: string;
  /** Prevents an agent-plugin manifest from claiming a different package version. */
  version?: string;
  minAppVersion?: string;
  payload: Record<string, unknown> | null;
  /** Translations retain the English key placeholders. */
  english: Readonly<Record<string, string>>;
  /** The source the package came from; some content is reserved for official and managed sources. */
  sourceOrigin: SourceOrigin;
  /** Author checks reject unknown or model-facing keys; installed languages ignore them across catalog changes. */
  unknownMessageKeys: "refuse" | "ignore";
}

class ContentFailure extends MarketplaceError {
  constructor(file: string, why: string) {
    super("CONTENT_RULE_VIOLATION", `${file}: ${why}`);
  }
}

/** Reject case-only path collisions so installation is deterministic on case-insensitive disks. */
function fileMap(files: readonly ContentFile[]): Map<string, Buffer> {
  const folded = new Map<string, string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    const other = folded.get(key);
    if (other !== undefined) throw new ContentFailure(file.path, `differs from ${other} only in case`);
    folded.set(key, file.path);
  }
  return new Map(files.map((file) => [file.path, file.data]));
}

function readJson(files: Map<string, Buffer>, path: string): Record<string, unknown> {
  const bytes = files.get(path);
  if (!bytes) throw new ContentFailure(path, "is missing");
  let value: unknown;
  try {
    value = parseStrictJson(bytes.toString("utf8"));
  } catch (error) {
    throw new ContentFailure(path, `is not valid JSON (${(error as Error).message})`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContentFailure(path, "must be an object");
  return value as Record<string, unknown>;
}

function closed(record: Record<string, unknown>, path: string, keys: readonly string[]): void {
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new ContentFailure(path, `unknown field ${unknown.join(", ")}`);
}

/** Reject invisible formatting that could misrepresent displayed names or approval prompts. */
const HIDDEN_FORMATTING = /[\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

function text(record: Record<string, unknown>, path: string, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value) || HIDDEN_FORMATTING.test(value)) {
    throw new ContentFailure(path, `${key} must be a single-line string of at most ${max} characters`);
  }
  return value;
}

function imageSize(bytes: Buffer): { format: string; width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.readUInt32BE(4) === 0x0d0a1a0a && bytes.subarray(12, 16).toString("latin1") === "IHDR") {
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = bytes.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") return { format: "webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    if (chunk === "VP8 ") return { format: "webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1]!;
      const length = bytes.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return null;
}

const PREVIEW_EXTENSIONS: Readonly<Record<string, string>> = { ".png": "png", ".jpg": "jpeg", ".webp": "webp" };
const PREVIEW_MAX_SIDE = 2048;

function theme(files: Map<string, Buffer>, context: ContentContext): ThemeContent {
  const path = "theme.json";
  // Bundled themes retain their ids; other themes are packages.
  if (isBundleId(context.name)) throw new ContentFailure(path, `${context.name} is a built-in theme`);
  const record = readJson(files, path);
  closed(record, path, ["name", "description", "shell", "highContrast", "tokens", "surfaces", "preview", "pair"]);
  if (record.shell !== "light" && record.shell !== "dark") throw new ContentFailure(path, 'shell must be "light" or "dark"');
  if (typeof record.highContrast !== "boolean") throw new ContentFailure(path, "highContrast must be true or false");
  if (record.pair !== undefined && (typeof record.pair !== "string" || !isThemeId(record.pair) || record.pair === context.name)) {
    throw new ContentFailure(path, "pair must name another theme");
  }
  const problems = [...themeTokenProblems(record.tokens), ...themeSurfaceProblems(record.surfaces)];
  if (problems.length > 0) throw new ContentFailure(path, problems.join("; "));
  let preview: string | undefined;
  if (record.preview !== undefined) {
    const bytes = typeof record.preview === "string" && record.preview !== path ? files.get(record.preview) : undefined;
    if (typeof record.preview !== "string" || !bytes) {
      throw new ContentFailure(path, "preview must name an image file of the package");
    }
    const expected = PREVIEW_EXTENSIONS[record.preview.slice(record.preview.lastIndexOf(".")).toLowerCase()];
    const size = imageSize(bytes);
    if (!size || size.format !== expected) throw new ContentFailure(record.preview, "is not an image of the format its extension names");
    if (size.width < 1 || size.height < 1 || size.width > PREVIEW_MAX_SIDE || size.height > PREVIEW_MAX_SIDE) {
      throw new ContentFailure(record.preview, `must be at most ${PREVIEW_MAX_SIDE}×${PREVIEW_MAX_SIDE} pixels`);
    }
    preview = record.preview;
  }
  return {
    kind: "theme",
    name: text(record, path, "name", 64),
    description: text(record, path, "description", 240),
    shell: record.shell,
    highContrast: record.highContrast,
    tokens: record.tokens as ThemeTokens,
    surfaces: record.surfaces as ThemeSurfaces,
    ...(preview ? { preview } : {}),
    ...(record.pair !== undefined ? { pair: record.pair } : {}),
  };
}

const MESSAGE_MAX = 4000;
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/gu;

function placeholders(value: string): string {
  return [...new Set([...value.matchAll(PLACEHOLDER)].map((match) => match[1]!))].sort().join(",");
}

/** Model-facing text always uses compiled catalogs, never language packages. */
export function translatableKeys(english: Readonly<Record<string, string>>): string[] {
  return Object.keys(english).filter((key) => !isModelFacingKey(key));
}
const LOCALE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$/u;

function language(files: Map<string, Buffer>, context: ContentContext): LanguageContent {
  const infoPath = "language.json";
  const info = readJson(files, infoPath);
  closed(info, infoPath, ["locale", "nativeName", "englishName"]);
  const locale = info.locale;
  if (typeof locale !== "string" || !LOCALE_TAG.test(locale)) throw new ContentFailure(infoPath, "locale must be a BCP 47 language tag");
  if (context.payload && context.payload.locale !== locale) {
    throw new ContentFailure(infoPath, `locale must be ${String(context.payload.locale)}, the descriptor's locale`);
  }
  // Only trusted sources may replace a compiled language; regional aliases must not shadow one.
  const primary = locale.split("-")[0]!;
  if ((SUPPORTED_LOCALES as readonly string[]).includes(primary)) {
    const reserved = primary === "en" || locale !== primary || (context.sourceOrigin !== "official" && context.sourceOrigin !== "managed");
    if (reserved) throw new ContentFailure(infoPath, `${locale} is a built-in language and cannot be installed from this source`);
  }
  const messagesPath = "messages.json";
  const catalog = readJson(files, messagesPath);
  const unknown: string[] = [];
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog)) {
    const english = Object.hasOwn(context.english, key) ? context.english[key] : undefined;
    if (english === undefined || isModelFacingKey(key)) {
      unknown.push(key);
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > MESSAGE_MAX || HIDDEN_FORMATTING.test(value)) {
      throw new ContentFailure(messagesPath, `${key} must be a non-empty string of at most ${MESSAGE_MAX} characters without hidden formatting`);
    }
    // Approval translations must retain placeholders so the approved target cannot change.
    if (placeholders(value) !== placeholders(english)) {
      throw new ContentFailure(messagesPath, `${key} must keep the placeholders {${placeholders(english).split(",").filter(Boolean).join("}, {")}}`);
    }
    messages[key] = value;
  }
  if (unknown.length > 0 && context.unknownMessageKeys === "refuse") {
    const shown = unknown.slice(0, 5).join(", ");
    throw new ContentFailure(messagesPath, `${unknown.length} key(s) are not interface keys of the English catalog: ${shown}${unknown.length > 5 ? ", …" : ""}`);
  }
  const missingKeys = translatableKeys(context.english).filter((key) => !(key in messages)).sort();
  return {
    kind: "language",
    locale,
    nativeName: text(info, infoPath, "nativeName", 64),
    englishName: text(info, infoPath, "englishName", 64),
    messages,
    missingKeys,
  };
}

const FONT_FAMILY = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,47}$/u;
const FONT_FORMATS: ReadonlyArray<{ ext: string; format: FontFormat; magic: (bytes: Buffer) => boolean }> = [
  { ext: ".woff2", format: "woff2", magic: (bytes) => bytes.subarray(0, 4).toString("latin1") === "wOF2" },
  { ext: ".woff", format: "woff", magic: (bytes) => bytes.subarray(0, 4).toString("latin1") === "wOFF" },
  { ext: ".ttf", format: "truetype", magic: (bytes) => bytes.readUInt32BE(0) === 0x00010000 || bytes.subarray(0, 4).toString("latin1") === "true" },
  { ext: ".otf", format: "opentype", magic: (bytes) => bytes.subarray(0, 4).toString("latin1") === "OTTO" || bytes.readUInt32BE(0) === 0x00010000 },
];
const WEIGHT = /^[1-9]00$|^[1-9]00 [1-9]00$/u;
const weightRangeOrdered = (weight: string) => {
  const [min, max] = weight.split(" ");
  return max === undefined || Number(min) <= Number(max);
};

function font(files: Map<string, Buffer>): FontContent {
  const path = "font.json";
  const record = readJson(files, path);
  closed(record, path, ["family", "license", "faces"]);
  const family = record.family;
  if (typeof family !== "string" || !FONT_FAMILY.test(family) || family.trim() !== family) {
    throw new ContentFailure(path, "family must be letters, digits, spaces, _ or -, at most 48 characters");
  }
  if (record.license !== "LICENSE") throw new ContentFailure(path, 'license must be "LICENSE"');
  const license = files.get("LICENSE");
  if (!license || license.toString("utf8").trim().length === 0) throw new ContentFailure("LICENSE", "a font package needs a non-empty LICENSE file");
  if (!Array.isArray(record.faces) || record.faces.length === 0 || record.faces.length > 30) {
    throw new ContentFailure(path, "faces must list 1 to 30 font files");
  }
  const seen = new Set<string>();
  const faces = record.faces.map((face: unknown, index: number): FontContent["faces"][number] => {
    const at = `faces[${index}]`;
    if (typeof face !== "object" || face === null || Array.isArray(face)) throw new ContentFailure(path, `${at} must be an object`);
    const entry = face as Record<string, unknown>;
    closed(entry, path, ["file", "weight", "style"]);
    const file = entry.file;
    const bytes = typeof file === "string" ? files.get(file) : undefined;
    if (typeof file !== "string" || !file.startsWith("files/") || !bytes) throw new ContentFailure(path, `${at}.file must name a file under files/`);
    if (seen.has(file)) throw new ContentFailure(path, `${at}.file lists ${file} twice`);
    seen.add(file);
    const kind = FONT_FORMATS.find((candidate) => file.toLowerCase().endsWith(candidate.ext));
    if (!kind || bytes.length < 4 || !kind.magic(bytes)) throw new ContentFailure(file, "is not a font file of the format its extension names");
    const weight = typeof entry.weight === "number" ? String(entry.weight) : entry.weight;
    if (typeof weight !== "string" || !WEIGHT.test(weight) || !weightRangeOrdered(weight)) throw new ContentFailure(path, `${at}.weight must be 100–900 in hundreds, or a "min max" range`);
    const style: unknown = entry.style ?? "normal";
    if (style !== "normal" && style !== "italic") throw new ContentFailure(path, `${at}.style must be "normal" or "italic"`);
    return { file, format: kind.format, weight, style };
  });
  const unused = [...files.keys()].filter((file) => file.startsWith("files/") && !seen.has(file));
  if (unused.length > 0) throw new ContentFailure(path, `faces does not list ${unused.join(", ")}`);
  return { kind: "font", family, faces };
}

/** Refuse any input field a normalizer would drop or rewrite. */
function sameFields(input: Record<string, unknown>, normalized: object | undefined, path: string): void {
  if (!normalized) throw new ContentFailure(path, "is not a valid declaration");
  const out = normalized as Record<string, unknown>;
  const changed = Object.keys(input).filter((key) => out[key] === undefined || canonicalStringify(out[key]) !== canonicalStringify(input[key]));
  if (changed.length > 0) throw new ContentFailure(path, `invalid or unknown field ${changed.join(", ")}`);
}

const VENDOR_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function vendorProvider(record: Record<string, unknown>, path: string, providerId: MarketplaceEligibleLLMVendor, context: ContentContext): ProviderContent {
  closed(record, path, ["providerId", "defaultModel", "baseUrl"]);
  const vendor: { providerId: MarketplaceEligibleLLMVendor; defaultModel?: string; baseUrl?: string } = { providerId };
  if (record.defaultModel !== undefined) {
    if (typeof record.defaultModel !== "string" || !VENDOR_MODEL.test(record.defaultModel)) throw new ContentFailure(path, "defaultModel must be a model id");
    vendor.defaultModel = record.defaultModel;
  }
  if (record.baseUrl !== undefined) {
    // A built-in vendor's key goes wherever its base URL points, so only an official or managed source may move it.
    if (context.sourceOrigin !== "official" && context.sourceOrigin !== "managed") {
      throw new ContentFailure(path, `only an official or managed source may set ${providerId}'s baseUrl`);
    }
    let url: URL | null = null;
    try {
      url = typeof record.baseUrl === "string" ? new URL(record.baseUrl) : null;
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password) throw new ContentFailure(path, "baseUrl must be an https URL");
    vendor.baseUrl = record.baseUrl as string;
  }
  return { kind: "provider", vendor };
}

function provider(files: Map<string, Buffer>, context: ContentContext): ProviderContent {
  const path = "provider.json";
  const record = readJson(files, path);
  if (record.providerId !== context.name) throw new ContentFailure(path, `providerId must be ${context.name}, the package name`);
  if (isMarketplaceEligibleLLMVendor(record.providerId)) return vendorProvider(record, path, record.providerId, context);
  const preset = normalizeMarketplaceProviderPreset(record);
  sameFields(record, preset, path);
  return { kind: "provider", preset: preset! };
}

function messagingConnection(files: Map<string, Buffer>, context: ContentContext): MessagingConnectionContent {
  const path = "connection.json";
  const record = readJson(files, path);
  if (record.connectionId !== context.name) throw new ContentFailure(path, `connectionId must be ${context.name}, the package name`);
  const connection = normalizeMarketplaceMessagingConnection(record);
  sameFields(record, connection, path);
  return { kind: "messaging-connection", connection: connection! };
}

/** Optional front-matter names must match the package identity. */
function instruction(kind: "skill" | "agent", files: Map<string, Buffer>, context: ContentContext): InstructionContent {
  const path = kind === "skill" ? "SKILL.md" : "AGENTS.md";
  const bytes = files.get(path);
  if (!bytes) throw new ContentFailure(path, "is missing");
  const source = bytes.toString("utf8");
  let header: { name: string; description?: string };
  let body: string;
  try {
    ({ fm: header, body } = kind === "skill" ? parseFrontmatter(source) : parseAgentFrontmatter(source));
  } catch (error) {
    throw new ContentFailure(path, `front matter does not parse (${(error as Error).message})`);
  }
  if (header.name && header.name !== context.name) throw new ContentFailure(path, `names ${header.name}, the package is ${context.name}`);
  if (body.trim().length === 0) throw new ContentFailure(path, "has no body");
  return { kind, name: context.name, description: header.description ?? "" };
}

export function parseContent(kind: DataContentKind, files: readonly ContentFile[], context: ContentContext): ParsedContent {
  const map = fileMap(files);
  switch (kind) {
    case "agent-plugin": {
      if (!context.version) throw new MarketplaceError("MANIFEST_MISMATCH", "agent-plugin version is required to verify plugin.json");
      const components = deriveAgentPluginComponents(files, { name: context.name, version: context.version, minAppVersion: context.minAppVersion });
      if (context.payload !== null && canonicalStringify(context.payload.components) !== canonicalStringify(components)) {
        throw new MarketplaceError("MANIFEST_MISMATCH", "agent-plugin components differ from the package tree");
      }
      return { kind, components, files: files.map(({ path, data }) => ({ path, data: Buffer.from(data) })) };
    }
    case "skill":
    case "agent":
      return instruction(kind, map, context);
    case "theme":
      return theme(map, context);
    case "language":
      return language(map, context);
    case "font":
      return font(map);
    case "provider":
      return provider(map, context);
    case "messaging-connection":
      return messagingConnection(map, context);
  }
}
