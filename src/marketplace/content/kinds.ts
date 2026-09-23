/**
 * The data of each content kind (design §5.2, blueprint 3.2–3.5): the entry
 * files of an installed package, parsed and checked. The same parse runs at
 * install (a failure refuses the package) and whenever installed content is
 * loaded (a failure lists the package as broken and applies nothing), so
 * bytes changed on disk after install are held to the same rules.
 *
 * Every entry file is strict JSON with a closed set of fields. The provider
 * and messaging-connection files go through the same normalizers today's
 * asset packages use, and a field the normalizer drops or rewrites refuses
 * the file instead of being lost silently.
 */
import { canonicalStringify } from "../../shared/canonical-json.js";
import {
  normalizeMarketplaceMessagingConnection,
  normalizeMarketplaceProviderPreset,
  type MarketplaceInstalledMessagingConnection,
  type MarketplaceInstalledProviderPreset,
} from "../../shared/marketplace-package-assets.js";
import type { FontFormat } from "../../shared/installed-content.js";
import { isDefaultVisibleThemeBundleId } from "../../shared/theme-bundles.js";
import { themeSurfaceProblems, themeTokenProblems, type ThemeSurfaces, type ThemeTokens } from "../../shared/theme-tokens.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import type { ContentKind } from "./rules.js";

export interface ContentFile {
  /** Package-relative, `/`-separated. */
  path: string;
  data: Buffer;
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

interface ProviderContent {
  kind: "provider";
  preset: MarketplaceInstalledProviderPreset;
}

interface MessagingConnectionContent {
  kind: "messaging-connection";
  connection: MarketplaceInstalledMessagingConnection;
}

export type ParsedContent = ThemeContent | LanguageContent | FontContent | ProviderContent | MessagingConnectionContent;

/** The kinds P3 gives a data model; skills and agents join with the install switch (blueprint 6.1). */
export type DataContentKind = ParsedContent["kind"];

export function isDataContentKind(kind: ContentKind): kind is DataContentKind {
  return kind === "theme" || kind === "language" || kind === "font" || kind === "provider" || kind === "messaging-connection";
}

export interface ContentContext {
  /** The package name. */
  name: string;
  /** The descriptor's payload (already schema-checked); null when loading an installed package. */
  payload: Record<string, unknown> | null;
  /** Every key of the English catalog. */
  englishKeys: ReadonlySet<string>;
}

class ContentFailure extends MarketplaceError {
  constructor(file: string, why: string) {
    super("CONTENT_RULE_VIOLATION", `${file}: ${why}`);
  }
}

function fileMap(files: readonly ContentFile[]): Map<string, Buffer> {
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

function text(record: Record<string, unknown>, path: string, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContentFailure(path, `${key} must be a single-line string of at most ${max} characters`);
  }
  return value;
}

function theme(files: Map<string, Buffer>, context: ContentContext): ThemeContent {
  const path = "theme.json";
  // The default-visible bundles stay compiled in; an installed theme may not take their id.
  if (isDefaultVisibleThemeBundleId(context.name)) throw new ContentFailure(path, `${context.name} is a built-in theme`);
  const record = readJson(files, path);
  closed(record, path, ["name", "description", "shell", "highContrast", "tokens", "surfaces", "preview"]);
  if (record.shell !== "light" && record.shell !== "dark") throw new ContentFailure(path, 'shell must be "light" or "dark"');
  if (typeof record.highContrast !== "boolean") throw new ContentFailure(path, "highContrast must be true or false");
  const problems = [...themeTokenProblems(record.tokens), ...themeSurfaceProblems(record.surfaces)];
  if (problems.length > 0) throw new ContentFailure(path, problems.join("; "));
  let preview: string | undefined;
  if (record.preview !== undefined) {
    if (typeof record.preview !== "string" || record.preview === path || !files.has(record.preview)) {
      throw new ContentFailure(path, "preview must name an image file of the package");
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
  };
}

const MESSAGE_MAX = 4000;
/** The descriptor schema's `languagePayload.locale` pattern. */
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
  if (locale === "en") throw new ContentFailure(infoPath, "English is built in and cannot be installed");
  const messagesPath = "messages.json";
  const catalog = readJson(files, messagesPath);
  const unknown: string[] = [];
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(catalog)) {
    if (!context.englishKeys.has(key)) {
      unknown.push(key);
      continue;
    }
    if (typeof value !== "string" || value.length === 0 || value.length > MESSAGE_MAX) {
      throw new ContentFailure(messagesPath, `${key} must be a non-empty string of at most ${MESSAGE_MAX} characters`);
    }
    messages[key] = value;
  }
  if (unknown.length > 0) {
    const shown = unknown.slice(0, 5).join(", ");
    throw new ContentFailure(messagesPath, `${unknown.length} key(s) are not in the English catalog: ${shown}${unknown.length > 5 ? ", …" : ""}`);
  }
  const missingKeys = [...context.englishKeys].filter((key) => !(key in messages)).sort();
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
    if (typeof weight !== "string" || !WEIGHT.test(weight)) throw new ContentFailure(path, `${at}.weight must be 100–900 in hundreds, or a "min max" range`);
    const style: unknown = entry.style ?? "normal";
    if (style !== "normal" && style !== "italic") throw new ContentFailure(path, `${at}.style must be "normal" or "italic"`);
    return { file, format: kind.format, weight, style };
  });
  const unused = [...files.keys()].filter((file) => file.startsWith("files/") && !seen.has(file));
  if (unused.length > 0) throw new ContentFailure(path, `faces does not list ${unused.join(", ")}`);
  return { kind: "font", family, faces };
}

/**
 * `normalized` must hold every field of `input` unchanged: the normalizer
 * drops unknown fields and invalid values, and a package file that loses a
 * field on the way in is refused rather than installed as something else.
 */
function sameFields(input: Record<string, unknown>, normalized: object | undefined, path: string): void {
  if (!normalized) throw new ContentFailure(path, "is not a valid declaration");
  const out = normalized as Record<string, unknown>;
  const changed = Object.keys(input).filter((key) => out[key] === undefined || canonicalStringify(out[key]) !== canonicalStringify(input[key]));
  if (changed.length > 0) throw new ContentFailure(path, `invalid or unknown field ${changed.join(", ")}`);
}

function provider(files: Map<string, Buffer>, context: ContentContext): ProviderContent {
  const path = "provider.json";
  const record = readJson(files, path);
  if (record.providerId !== context.name) throw new ContentFailure(path, `providerId must be ${context.name}, the package name`);
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

/** The parsed entry files of a `kind` package; CONTENT_RULE_VIOLATION when they do not hold. */
export function parseContent(kind: DataContentKind, files: readonly ContentFile[], context: ContentContext): ParsedContent {
  const map = fileMap(files);
  switch (kind) {
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
