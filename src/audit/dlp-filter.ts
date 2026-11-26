



import os from "node:os";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { PII_PATTERNS } from "../shared/dlp.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { decodeHomeEscapes, type HomeEscapeFamily, mayDecodeHomeCharacter } from "./home-path-decode.js";

export {
  initPiiRedactionPolicy,
  isPiiRedactionEnabled,
  maskSensitiveData,
  scrubSecretsForLLM,
} from "../shared/dlp.js";




export interface RedactResult {
  redacted: string;
  counts: Record<string, number>;
  totalCount: number;
}

let _auditLogger: { log: (e: { timestamp: string; sessionId: string; type: "dlp"; dlp: { byKind: Record<string, number>; totalRedactions: number; turnId: string } }) => void } | null = null;
type DlpAuditSessionSource = string | (() => string);
let _sessionId: DlpAuditSessionSource = "unknown";

export function initDlpAudit(
  auditLogger: typeof _auditLogger,
  sessionId: DlpAuditSessionSource,
): void {
  _auditLogger = auditLogger;
  _sessionId = sessionId;
}

export function redactForLLM(text: string, turnId?: string): RedactResult {
  const counts: Record<string, number> = {};
  const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

  let out = text;

  // Share display detection order but replace complete matches rather than preserving display shape.
  for (const spec of PII_PATTERNS) {
    spec.pattern.lastIndex = 0;
    out = out.replace(spec.pattern, (match: string): string => {
      if (spec.valid && !spec.valid(match)) return match;
      bump(spec.kind);
      return spec.redactToken;
    });
  }

  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalCount > 0 && _auditLogger) {
    _auditLogger.log({
      timestamp: new Date().toISOString(),
      // Resolve session getters at each hit so new or resumed sessions receive correct attribution.
      sessionId: typeof _sessionId === "function" ? _sessionId() : _sessionId,
      type: "dlp",
      dlp: {
        byKind: counts,
        totalRedactions: totalCount,
        turnId: turnId ?? `turn-${Date.now()}`,
      },
    });
  }
  return { redacted: out, counts, totalCount };
}

const homePlatform = os.platform();

interface ConfiguredHome {
  spellings: string[];
  nativeUrl: string;
}

function configuredHome(): ConfiguredHome {
  const unsupported = { spellings: [], nativeUrl: "" };
  let raw: string;
  try { raw = os.homedir(); } catch { return unsupported; }
  if (!raw) return unsupported;
  const windows = homePlatform === "win32";
  const paths = windows ? win32 : posix;
  const root = paths.parse(raw).root;
  const spelling = root + raw.slice(root.length).replace(/[\\/]+$/u, "");
  // Quotes and controls can coincide with syntax in serialized text. POSIX
  // filename backslashes can also change the meaning of a following quote.
  if (/["\p{Cc}]/u.test(spelling) || !windows && spelling.includes("\\")) return unsupported;
  const normalized = paths.normalize(spelling);
  // Roots and current-directory aliases have no account component.
  if (normalized === paths.parse(normalized).root || normalized === "." || windows && /^[a-z]:\.$/iu.test(normalized)) {
    return unsupported;
  }
  const comparable = (path: string): string => windows ? path.replaceAll("\\", "/") : path;
  const spellings = comparable(spelling) === comparable(normalized) ? [spelling] : [spelling, normalized];
  // The file URL converter would resolve relative paths against the process directory.
  const absolute = windows ? /^(?:[a-z]:[\\/]|[\\/]{2})/iu.test(normalized) : posix.isAbsolute(normalized);
  return { spellings, nativeUrl: absolute ? pathToFileURL(normalized).href : "" };
}

const home = configuredHome();

const MAX_AUDIT_PATH = 256;

/** File URLs can encode native separators even when generated on a different platform. */
function homePattern(home: string, windows: boolean, fileUrl = false, extendSeparators = true): string {
  return windows
    ? home.split(/([\\/]+)/u).map(part => {
      if (!/^[\\/]/u.test(part)) return escapeRegExp(part);
      const separator = fileUrl ? String.raw`(?:[\\/]|%5[cC])` : String.raw`[\\/]`;
      return `${separator}{${part.length}${extendSeparators ? "," : ""}}`;
    }).join("")
    : escapeRegExp(home);
}

interface HomePrefix {
  pattern: RegExp;
  marker: string;
  slashSuffix: boolean;
}

function compileHomePrefixes({ spellings, nativeUrl: standard }: ConfiguredHome): { literal: HomePrefix[]; decoded: HomePrefix[] } {
  const windows = homePlatform === "win32";
  const flags = windows || homePlatform === "darwin" ? "iu" : "u";
  const compile = (prefix: string, kind: "native-url" | "raw-url" | "legacy-url" | "path", decoded = false): HomePrefix => {
    const url = kind !== "path";
    const nativeUrl = kind === "native-url" && windows;
    const tail = /[\\/]$/u.test(prefix) ? "" : url
      ? nativeUrl ? String.raw`(?=$|[\\/?#]|%5[cC])` : String.raw`(?=$|[\\/?#])`
      : String.raw`(?=$|[\\/])`;
    return {
      pattern: new RegExp(`^${homePattern(prefix, windows, nativeUrl, decoded)}${tail}`, flags),
      marker: url ? "file://<home>" : "<home>",
      slashSuffix: kind === "legacy-url",
    };
  };
  const compileSpellings = (decoded: boolean): HomePrefix[] => {
    const legacy = spellings.map(spelling => compile(`file://${spelling}`, "legacy-url", decoded));
    // Prefer the exact configured spelling when it extends a normalized URL prefix.
    if (standard) legacy.splice(spellings.length > 1 ? 1 : 0, 0, decoded
      ? compile(decodeHomeEscapes(standard, "percent-entity"), "raw-url", true)
      : compile(standard, "native-url"));
    return [...legacy, ...spellings.map(spelling => compile(spelling, "path", decoded))];
  };
  return { literal: compileSpellings(false), decoded: compileSpellings(true) };
}

const homePrefixes = compileHomePrefixes(home);

const URL_PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

function replaceHomePrefix(path: string, prefixes: readonly HomePrefix[], decodedUrlPath = false): string | undefined {
  // Folding on macOS applies to path components. Its file scheme retains the POSIX spelling.
  if (homePlatform === "darwin" && /^file:/iu.test(path) && !path.startsWith("file:")) return undefined;
  for (const { pattern, marker, slashSuffix } of prefixes) {
    const match = pattern.exec(path);
    if (!match) continue;
    const suffix = path.slice(match[0].length);
    // Query and fragment boundaries also apply to encoded URL paths.
    if ((suffix.startsWith("?") || suffix.startsWith("#")) && !decodedUrlPath && !URL_PERCENT_ESCAPE.test(match[0])) continue;
    return marker + (slashSuffix ? suffix.replace(/\\/gu, "/") : suffix);
  }
  return undefined;
}

/** Prefer the literal prefix. An encoded prefix is replaced in a decoded path value. Any other account's home is replaced as in text. */
export function redactFsPath(path: string): string {
  if (!path) return path;
  let out = replaceHomePrefix(path, homePrefixes.literal);
  if (out === undefined && INTRODUCER.test(path)) {
    const decoded = decodeHomeEscapes(path, "percent-entity");
    if (decoded !== path) {
      const modifier = path.search(/[?#]/u);
      const urlPath = modifier < 0 ? "" : path.slice(0, modifier);
      const decodedUrlPath = modifier < 0 || decodeHomeEscapes(urlPath, "percent-entity") !== urlPath;
      out = replaceHomePrefix(decoded, homePrefixes.decoded, decodedUrlPath);
    }
  }
  out = replaceLiteralHomes(out ?? path, GENERIC_PATH_HOME_FORMS);
  // Iterate code points so truncation cannot split surrogate pairs.
  const codePoints = [...out];
  return codePoints.length > MAX_AUDIT_PATH ? codePoints.slice(0, MAX_AUDIT_PATH).join("") + "…" : out;
}

interface HomeForm {
  literal: RegExp;
  marker: string;
  /** The first group is a root kept before the marker. */
  keep?: boolean;
  /** Every match contains this root word, so text without it skips the form. The test is a substring test: a word such as `homepage` still runs the form. */
  root?: RegExp;
}

interface HomeDetector extends HomeForm {
  detector: RegExp;
}

interface HomeRedaction {
  forms: readonly HomeDetector[];
  trigger: RegExp;
  boundaries: ReadonlySet<number>;
  minimumHomeLength: number;
  requiredPathCharacter: string;
}

const HOME_DECODE_LAYERS = 3;

/** A quote, apostrophe or backtick that opens a span right before the match. */
const QUOTE_OPENED = String.raw`(?<=(?:^|[^\p{L}\p{N}])["'\x60])`;

/**
 * Any account's profile: letters, marks, digits, `._-` and apostrophes before a letter or digit, each also
 * percent-encoded up to the decode bound or a JSON `\u` escape, after separators encoded the same ways, under a
 * drive, UNC, `/users/` or `/home/` root. Words after a space join the name before a separator in a path value
 * (or a quote, or its end) and in a quoted span that starts with the home (or at its closing quote); in other
 * text the name stops at whitespace.
 */
function genericHomeForms(mode: "text" | "path"): readonly HomeForm[] {
  const json = (hex: string): string => String.raw`\\{1,7}u00(?:${hex})`;
  const percent = (hex: string): string => `%(?:25){0,${HOME_DECODE_LAYERS - 1}}(?:${hex})`;
  const escaped = (hex: string): string => `(?:${percent(hex)}|${json(hex)})`;
  const slash = `(?:\\/|${escaped("2f")})`;
  const separator = `(?:[\\\\/]|${escaped("2f|5c")})`;
  const colon = `(?::|${escaped("3a")})`;
  const letter = String.raw`3\d|[46][1-9a-f]|[57][\da]|[89a-f][\da-f]`;
  // A JSON escape doubles its backslashes per layer. A run followed by the same run before a folder is a separator.
  const wide = Array.from({ length: 7 }, (_, index) => String.raw`\\{${index + 1}}u(?!00)[\da-f]{4}(?!\\{${index + 1}}[^\\"/bfnrtu])`)
    .join("|");
  // Unquoted text reads a JSON-escaped space as whitespace; elsewhere an encoded space joins the name.
  const unit = (space: string): string => `(?:[\\p{L}\\p{M}\\p{N}._-]|'(?=[\\p{L}\\p{N}])|${escaped(`2[de]|5f|${letter}`)}`
    + `|${space}|${escaped("27")}(?=[\\p{L}\\p{N}]|${escaped(letter)})|${wide})`;
  // A drive profile joined directly to a name starts the next home.
  const nameUnit = (space = escaped("20")): string =>
    `(?:(?![a-z]${colon}${separator}+users${separator}+${unit(space)})${unit(space)})`;
  const joined = (end: string): string => `${nameUnit()}+(?:(?: +[\\p{L}\\p{N}]${nameUnit()}*)+${end})?`;
  const usersRoot = /(?:users)/iu;
  const homeRoot = /(?:home)/iu;
  const roots: [prefix: string, marker: string, root: RegExp, keep?: boolean][] = [
    [`file${colon}${slash}{3}[a-z]${colon}${slash}users${slash}`, "file://[home]", usersRoot],
    [`file${colon}${slash}{3}users${slash}`, "file://[home]", usersRoot],
    [`file${colon}${slash}{3}home${slash}`, "file://[home]", homeRoot],
    // A drive profile goes first, so a device path such as `\\?\C:\Users\bob` keeps its drive in the marker.
    [`[a-z]${colon}${separator}+users${separator}+`, "[home]", usersRoot],
    // A UNC root keeps its server and share. Its leading run is twice its separator, also when serialized.
    [String.raw`((?<!\\)(\\{1,8})\2[^\s\\/]+\2(?:[^\s\\/]+\2)?)(?:users|home)\2`, "[home]", /users|home/iu, true],
    [`${slash}users${slash}`, "[home]", usersRoot],
    [`${slash}home${slash}`, "[home]", homeRoot],
  ];
  const forms = (name: string, opened = ""): HomeForm[] =>
    roots.map(([prefix, marker, root, keep]) => ({ literal: new RegExp(opened + prefix + name, "giu"), marker, root, keep }));
  return mode === "path"
    ? forms(joined(`(?=${separator}|[?#"'\\x60]|$)`))
    : [...forms(joined(`(?=${separator}|["'\\x60])`), QUOTE_OPENED), ...forms(`${nameUnit(percent("20"))}+`)];
}

const GENERIC_HOME_FORMS = genericHomeForms("text");
const GENERIC_PATH_HOME_FORMS = genericHomeForms("path");
const LARGE_ESCAPE_TOKEN = 4096;
const HOME_TOKEN_MARKER = "[home-token]";
const SINGLE_DECODE_FAMILY = ["full"] as const;
const BACKSLASH_AND_URI_FAMILIES = ["full", "backslash", "percent-entity"] as const;
const DECODE_FAMILIES: readonly HomeEscapeFamily[] = [...BACKSLASH_AND_URI_FAMILIES, "percent", "entity"];
const URI_AND_ENTITY_FAMILIES: readonly HomeEscapeFamily[] = ["full", "percent", "entity"];
const INTRODUCER = /[\\%&]/u;
const HEX_ESCAPE = /\\x[\dA-Fa-f]{2}/u;
const UTF8_LEAD_ESCAPE = /\\x[C-Fc-f][\dA-Fa-f]/u;
const BOUNDARY_CHARACTERS = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\"'`<>()[]{},|";

function compileHomeRedaction({ spellings, nativeUrl }: ConfiguredHome, platform: NodeJS.Platform): HomeRedaction {
  const windows = platform === "win32";
  const flags = windows || platform === "darwin" ? "iu" : "u";
  const standard = nativeUrl.replace(/\/$/u, "");
  const slashHomes = spellings.map(spelling => spelling.replaceAll("\\", "/"));
  const anchors = new Set(slashHomes.map(spelling => {
    const components = spelling.split("/");
    return components.findLast(component => component && component !== "." && component !== "..") ?? components.at(-1) ?? "";
  }));
  const trigger = new RegExp([String.raw`[\\%&]|users|home`, ...[...anchors].map(escapeRegExp)].join("|"), "iu");
  const boundaries = new Set([...BOUNDARY_CHARACTERS].map(character => character.charCodeAt(0)));
  for (const spelling of spellings) {
    for (const character of spelling) if (character !== '"') boundaries.delete(character.charCodeAt(0));
  }
  const requiredPathCharacter = windows ? /^[a-z]:/iu.test(spellings[0] ?? "") ? ":" : "" : spellings[0]?.startsWith("/") ? "/" : "";
  const urls = new Set(slashHomes.map(spelling => `file://${spelling}`));
  if (standard) urls.add(standard);
  const compile = (spelling: string, marker: string): HomeDetector => {
    const start = windows && /^[\\/]/u.test(spelling) ? String.raw`(?<![\\/])` : "";
    const pattern = homePattern(spelling, windows, spelling === standard);
    const source = String.raw`${start}${pattern}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])`;
    return { literal: new RegExp(source, `g${flags}`), detector: new RegExp(source, flags), marker };
  };
  const forms = [
    ...[...urls].map(spelling => compile(spelling, "file://[home]")),
    ...slashHomes.map(spelling => compile(spelling, "[home]")),
  ];
  const minimumHomeLength = Math.min(...[...slashHomes, ...urls].map(spelling => [...spelling].length));
  return { forms, trigger, boundaries, minimumHomeLength, requiredPathCharacter };
}

const homeRedaction = compileHomeRedaction(home, homePlatform);

export function mayContainHomePath(value: string): boolean {
  return homeRedaction.trigger.test(value);
}

const ESCAPABLE_INITIAL = new Set([..."/\"'bfnrtux"].map(character => character.charCodeAt(0)));

/** Require a complete JSON container. A quoted path alone is ambiguous prose. */
function hasJsonContainer(text: string): boolean {
  for (let depth = 0; depth < HOME_DECODE_LAYERS && /^\s*[[{"]/u.test(text); depth++) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return false; }
    if (typeof value !== "string") return true;
    text = value;
  }
  return false;
}

/** A URL authority, plain or percent-encoded and with escaped host bytes, ends here. */
const AFTER_AUTHORITY = /(?<=(?:^|[^a-z\d+.-])[a-z][a-z\d+.-]*(?::\/\/|%(?:25){0,2}3a%(?:25){0,2}2f%(?:25){0,2}2f)(?:[^\s/\\?#%]|%(?:25){0,2}(?!2f|5c|3f|23)[\da-f]{2})+)/iuy;
const LEADING_SLASH = /\/|%(?:25){0,2}2f|\\{1,7}u002f/iuy;

/** The separator that ends a URL authority stays before the marker of a home path that follows it. */
function keptRoot(text: string, match: RegExpExecArray | RegExpMatchArray, keep: boolean | undefined): string {
  if (keep) return match[1] ?? "";
  const start = match.index ?? 0;
  LEADING_SLASH.lastIndex = start;
  const slash = LEADING_SLASH.exec(text)?.[0];
  if (slash === undefined) return "";
  AFTER_AUTHORITY.lastIndex = start;
  return AFTER_AUTHORITY.test(text) ? slash : "";
}

function replaceLiteralHomes(text: string, forms: readonly HomeForm[]): string {
  for (const { literal, marker, keep, root } of forms) {
    if (root && !root.test(text)) continue;
    let copied = 0;
    let pieces: string[] | undefined;
    let insideJson: boolean | undefined;
    for (const match of text.matchAll(literal)) {
      let start = match.index;
      const end = start + match[0].length;
      if (text.charCodeAt(start - 1) === 92 && ESCAPABLE_INITIAL.has(text.charCodeAt(start))) {
        let runStart = start;
        while (runStart > copied && text.charCodeAt(runStart - 1) === 92) runStart--;
        if ((start - runStart) % 2 !== 0) {
          insideJson ??= hasJsonContainer(text);
          // An odd run in a parsed document can only be a string escape.
          if (insideJson) start--;
        }
      }
      pieces ??= [];
      pieces.push(text.slice(copied, start), `${keptRoot(text, match, keep)}${marker}`);
      copied = end;
    }
    if (pieces) text = pieces.join("") + text.slice(copied);
  }
  return text;
}

function escapeFamilies(view: string): readonly HomeEscapeFamily[] {
  const backslashes = view.includes("\\");
  const percent = view.includes("%");
  const entities = view.includes("&");
  // One encoder can leave syntax from another family literal in a home.
  const mixed = backslashes && (percent || entities);
  const families = percent && entities
    ? backslashes ? DECODE_FAMILIES : URI_AND_ENTITY_FAMILIES
    : mixed ? BACKSLASH_AND_URI_FAMILIES : SINGLE_DECODE_FAMILY;
  if (!backslashes || !HEX_ESCAPE.test(view)) return families;
  // Hexadecimal serializers can leave the surrounding backslashes raw.
  const candidates: HomeEscapeFamily[] = [...families, "hex", "json"];
  // Only a UTF-8 lead byte can make the two hexadecimal readings diverge.
  if (UTF8_LEAD_ESCAPE.test(view)) {
    candidates.push("hex-js", "full-js");
    if (mixed) candidates.push("backslash-js");
  }
  return candidates;
}

function detectsEncodedHome(token: string, forms: readonly HomeDetector[]): boolean {
  const seen = new Set([token]);
  let layer = [token];
  // Breadth first explores each distinct spelling at its lowest depth.
  for (let depth = 1; depth <= HOME_DECODE_LAYERS && layer.length; depth++) {
    const next: string[] = [];
    for (const view of layer) {
      for (const family of escapeFamilies(view)) {
        const decoded = decodeHomeEscapes(view, family);
        if (seen.has(decoded)) continue;
        if (forms.some(({ detector }) => detector.test(decoded))) return true;
        seen.add(decoded);
        if (depth < HOME_DECODE_LAYERS && INTRODUCER.test(decoded)) next.push(decoded);
      }
    }
    layer = next;
  }
  return false;
}

/** Delimiters and their preceding backslash runs belong to the original text. */
function replaceEncodedHomeTokens(
  text: string, { forms, boundaries, minimumHomeLength, requiredPathCharacter }: HomeRedaction,
): string {
  let pieces: string[] | undefined;
  let copied = 0;
  let start = 0;
  let introduced = false;
  const finish = (end: number): void => {
    if (!introduced || end - start < minimumHomeLength) return;
    let candidate = text.slice(start, end);
    // Mask literal matches for detection only. A decoded view must find a
    // separate occurrence, even when the source token already has a home.
    for (const { literal } of forms) candidate = candidate.replace(literal, '"');
    if (candidate.length < minimumHomeLength || !INTRODUCER.test(candidate)) return;
    if (requiredPathCharacter && candidate.length >= LARGE_ESCAPE_TOKEN && !candidate.includes(requiredPathCharacter)
      && !mayDecodeHomeCharacter(candidate, requiredPathCharacter.charCodeAt(0), HOME_DECODE_LAYERS)) return;
    if (!detectsEncodedHome(candidate, forms)) return;
    pieces ??= [];
    pieces.push(text.slice(copied, start), HOME_TOKEN_MARKER);
    copied = end;
  };
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    if (code === 92) {
      let end = index + 1;
      while (text.charCodeAt(end) === 92) end++;
      if (boundaries.has(text.charCodeAt(end))) {
        finish(index);
        index = end + 1;
        start = index;
        introduced = false;
      } else {
        introduced = true;
        index = end;
      }
    } else if (boundaries.has(code)) {
      finish(index);
      index++;
      start = index;
      introduced = false;
    } else {
      if (code === 37 || code === 38) introduced = true;
      index++;
    }
  }
  finish(text.length);
  return pieces ? pieces.join("") + text.slice(copied) : text;
}

/** Unlike prefix-only path redaction, display text must redact home paths anywhere, including file URLs. */
export function redactHomePathsInText(value: string): string {
  if (!value || !mayContainHomePath(value)) return value;
  const text = homeRedaction.forms.length && INTRODUCER.test(value) ? replaceEncodedHomeTokens(value, homeRedaction) : value;
  return replaceLiteralHomes(replaceLiteralHomes(text, homeRedaction.forms), GENERIC_HOME_FORMS);
}

/** Only listed top-level path fields are redacted; nested objects are not traversed. */
const AUDIT_PATH_KEYS = new Set([
  "entryUrl", "entryFsPath", "rawInstallRoot", "realEntry", "realRoot", "frameUrl", "cwd",
]);

/** Leave non-path fields and non-object payloads unchanged. */
export function redactAuditPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([k, v]) =>
      [k, AUDIT_PATH_KEYS.has(k) && typeof v === "string" ? redactFsPath(v) : v],
    ),
  );
}
