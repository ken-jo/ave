



import os from "node:os";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { PII_PATTERNS } from "../shared/dlp.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { decodeHomeEscapes, type HomeEscapeFamily, mayDecodeHomeCharacter, readHomeEscape } from "./home-path-decode.js";

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

/** Prefer the literal prefix. An encoded prefix is replaced in a decoded path value. */
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
  out ??= path;
  // Iterate code points so truncation cannot split surrogate pairs.
  const codePoints = [...out];
  return codePoints.length > MAX_AUDIT_PATH ? codePoints.slice(0, MAX_AUDIT_PATH).join("") + "…" : out;
}

interface HomeForm {
  literal: RegExp;
  marker: string;
}

interface HomeDetector extends HomeForm {
  detector: RegExp;
}

interface HomeRedaction {
  forms: readonly HomeDetector[];
  trigger: RegExp;
  boundaries: ReadonlySet<number>;
  componentCharacters: ReadonlySet<number>;
  minimumHomeLength: number;
  requiredPathCharacter: string;
}

const GENERIC_HOME_FORMS: readonly HomeForm[] = [
  { literal: /file:\/\/\/[a-z]:\/users\/[a-z0-9._-]+/giu, marker: "file://[home]" },
  { literal: /file:\/\/\/users\/[a-z0-9._-]+/giu, marker: "file://[home]" },
  { literal: /file:\/\/\/home\/[a-z0-9._-]+/giu, marker: "file://[home]" },
  { literal: /[a-z]:[\\/]+users[\\/]+[a-z0-9._-]+/giu, marker: "[home]" },
  { literal: /\/users\/[a-z0-9._-]+/giu, marker: "[home]" },
  { literal: /\/home\/[a-z0-9._-]+/giu, marker: "[home]" },
];

const HOME_DECODE_LAYERS = 3;
const LARGE_ESCAPE_TOKEN = 4096;
const HOME_TOKEN_MARKER = "[home-token]";
const SINGLE_DECODE_FAMILY = ["full"] as const;
const BACKSLASH_AND_URI_FAMILIES = ["full", "backslash", "percent-entity"] as const;
const DECODE_FAMILIES: readonly HomeEscapeFamily[] = [...BACKSLASH_AND_URI_FAMILIES, "percent", "entity"];
const URI_AND_ENTITY_FAMILIES: readonly HomeEscapeFamily[] = ["full", "percent", "entity"];
const INTRODUCER = /[\\%&]/u;
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
  const componentCharacters = new Set<number>();
  for (const spelling of spellings) {
    for (const character of windows ? spelling.replace(/^[a-z]:/iu, "") : spelling) {
      componentCharacters.add(character.codePointAt(0) ?? 0);
      if (character !== '"') boundaries.delete(character.charCodeAt(0));
    }
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
  return { forms, trigger, boundaries, componentCharacters, minimumHomeLength, requiredPathCharacter };
}

const homeRedaction = compileHomeRedaction(home, homePlatform);

export function mayContainHomePath(value: string): boolean {
  return homeRedaction.trigger.test(value);
}

const ESCAPABLE_INITIAL = new Set([..."/\"'bfnrtux"].map(character => character.charCodeAt(0)));

interface LiteralMarker {
  start: number;
  end: number;
}

interface LiteralMarkers {
  spans: LiteralMarker[];
}

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

function replaceLiteralHomes(text: string, forms: readonly HomeForm[], markers?: LiteralMarkers): string {
  for (const { literal, marker } of forms) {
    let copied = 0;
    let pieces: string[] | undefined;
    let spans: LiteralMarker[] | undefined;
    let previousMarker = 0;
    let offset = 0;
    let insideJson: boolean | undefined;
    const copyMarker = (previous: LiteralMarker): void => {
      spans?.push({ start: previous.start + offset, end: previous.end + offset });
    };
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
      pieces.push(text.slice(copied, start), marker);
      if (markers) {
        spans ??= [];
        while (previousMarker < markers.spans.length && markers.spans[previousMarker].end <= start) {
          copyMarker(markers.spans[previousMarker++]);
        }
        while (previousMarker < markers.spans.length && markers.spans[previousMarker].start < end) previousMarker++;
        spans.push({ start: start + offset, end: start + offset + marker.length });
        offset += marker.length - (end - start);
      }
      copied = end;
    }
    if (pieces) {
      text = pieces.join("") + text.slice(copied);
      if (spans && markers) {
        while (previousMarker < markers.spans.length) copyMarker(markers.spans[previousMarker++]);
        markers.spans = spans;
      }
    }
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
  // Only a UTF-8 lead byte can make adjacent hexadecimal escapes diverge.
  if (!backslashes || !/\\x[c-fC-F]/u.test(view)) return families;
  return mixed ? [...families, "full-js", "backslash-js"] : [...families, "full-js"];
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

const TOKEN_SEPARATOR = /[\p{White_Space}\p{P}\p{S}\p{Cc}]/u;
const NESTED_PERCENT_BYTE = /%(?:25){1,2}([0-9a-f]{2})/iy;
const URI_JSON_CONTROL = /(?:%5c(?:%5c)?|%255c)(?:[bfnrt]|u00[01][0-9a-f])/iy;

function isPathSeparator(code: number): boolean {
  return code === 47 || code === 92;
}

function isEscapeIntroducer(code: number): boolean {
  return code === 37 || code === 38 || code === 92;
}

function isDriveLetter(code: number): boolean {
  const lower = code | 32;
  return lower >= 97 && lower <= 122;
}

function uriJsonControlEnd(token: string, start: number): number {
  let end = start;
  URI_JSON_CONTROL.lastIndex = start;
  while (URI_JSON_CONTROL.test(token)) end = URI_JSON_CONTROL.lastIndex;
  return end;
}

/** Find separate candidates next to a literal marker using whole raw lexemes. */
function separateHomeTokens(
  token: string, componentCharacters: ReadonlySet<number>, containsEncodedHome: (candidate: string) => boolean,
  beforeLiteral: boolean,
): LiteralMarker | undefined {
  let start = 0;
  let introduced = false;
  let previousLetter = -1;
  let range: LiteralMarker | undefined;
  const escapeValue = { value: 0 };
  const collect = (end: number): boolean => {
    if ((!start && !beforeLiteral) || !introduced || !containsEncodedHome(token.slice(start, end))) return false;
    if (range) range.end = end;
    else range = { start, end };
    return !beforeLiteral;
  };
  for (let index = 0; index < token.length;) {
    const source = token.codePointAt(index) ?? 0;
    const introducer = isEscapeIntroducer(source);
    let width = introducer ? readHomeEscape(token, index, escapeValue) : -1;
    let code = width > 0 ? escapeValue.value : source;
    if (source === 37 && code === 37 && width > 0) {
      // URI encoding repeats the percent byte without escaping the final hex digits.
      NESTED_PERCENT_BYTE.lastIndex = index;
      const nested = NESTED_PERCENT_BYTE.exec(token);
      if (nested) { width = nested[0].length; code = Number.parseInt(nested[1], 16); }
    }
    if (homePlatform === "win32" && source === 37 && code === 92) {
      const controlEnd = uriJsonControlEnd(token, index);
      if (controlEnd > index) {
        // Only treat a serialized control run as a separator at a drive or
        // literal marker. For example, %5Cnew is still a path component.
        const nextDrive = isDriveLetter(token.charCodeAt(controlEnd)) && token.charCodeAt(controlEnd + 1) === 58;
        code = nextDrive || beforeLiteral && controlEnd === token.length ? 10 : token.charCodeAt(controlEnd - 1);
        width = controlEnd - index;
      }
    }
    const end = index + (width > 0 ? width : source > 0xffff ? 2 : 1);
    const next = token.charCodeAt(end);
    const driveColon = homePlatform === "win32" && code === 58 && previousLetter >= 0
      && (previousLetter === start || isPathSeparator(next) || isEscapeIntroducer(next));
    previousLetter = isDriveLetter(code) ? index : -1;
    // Test disjoint candidates. A separator may be a raw character or one
    // complete escape. Its source width determines the cut.
    if (!driveColon && !isPathSeparator(code) && !componentCharacters.has(code) && TOKEN_SEPARATOR.test(String.fromCodePoint(code))) {
      if (collect(index)) return range;
      start = end;
      introduced = false;
    } else {
      introduced ||= introducer;
    }
    index = end;
  }
  collect(token.length);
  return range;
}

/** Delimiters and their preceding slash runs belong to the original text. */
function replaceEncodedHomeTokens(
  text: string, { forms, boundaries, componentCharacters, minimumHomeLength, requiredPathCharacter }: HomeRedaction,
  markers: readonly LiteralMarker[],
): string {
  let pieces: string[] | undefined;
  let copied = 0;
  let start = 0;
  let introduced = false;
  let markerIndex = 0;
  let markerStart = markers[0]?.start ?? Infinity;
  let literalSuffix = false;
  const containsEncodedHome = (token: string): boolean => {
    // A decode cannot increase the number of characters in a candidate.
    if (token.length < minimumHomeLength || !INTRODUCER.test(token)) return false;
    if (requiredPathCharacter && token.length >= LARGE_ESCAPE_TOKEN && !token.includes(requiredPathCharacter)
      && !mayDecodeHomeCharacter(token, requiredPathCharacter.charCodeAt(0), HOME_DECODE_LAYERS)) return false;
    return detectsEncodedHome(token, forms);
  };
  const finish = (end: number, beforeLiteral = false): void => {
    const token = introduced && start < end ? text.slice(start, end) : "";
    if (token && containsEncodedHome(token)) {
      const separate = literalSuffix || beforeLiteral
        ? separateHomeTokens(token, componentCharacters, containsEncodedHome, beforeLiteral) : undefined;
      // Keep an edge of the original candidate if narrowing would expose a home there.
      const from = separate && !containsEncodedHome(token.slice(0, separate.start)) ? separate.start : 0;
      const to = beforeLiteral && separate && !containsEncodedHome(token.slice(separate.end)) ? separate.end : token.length;
      pieces ??= [];
      pieces.push(text.slice(copied, start + from), HOME_TOKEN_MARKER);
      copied = start + to;
    }
    literalSuffix = false;
    introduced = false;
  };
  for (let index = 0; index < text.length;) {
    if (index === markerStart) {
      finish(index, true);
      index = markers[markerIndex++].end;
      markerStart = markers[markerIndex]?.start ?? Infinity;
      start = index;
      literalSuffix = true;
      continue;
    }
    const code = text.charCodeAt(index);
    if (code === 92) {
      let end = index + 1;
      while (text.charCodeAt(end) === 92) end++;
      if (end === markerStart || boundaries.has(text.charCodeAt(end))) {
        finish(index, end === markerStart);
        index = end === markerStart ? end : end + 1;
        start = index;
      } else {
        introduced = true;
        index = end;
      }
    } else if (boundaries.has(code)) {
      finish(index);
      index++;
      start = index;
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
  const markers = homeRedaction.forms.length && INTRODUCER.test(value) ? { spans: [] } : undefined;
  let text = replaceLiteralHomes(value, homeRedaction.forms, markers);
  if (markers && INTRODUCER.test(text)) text = replaceEncodedHomeTokens(text, homeRedaction, markers.spans);
  return replaceLiteralHomes(text, GENERIC_HOME_FORMS);
}

/** Only listed top-level path fields are redacted; nested objects are not traversed. */
const AUDIT_PATH_KEYS = new Set([
  "entryUrl", "entryFsPath", "rawInstallRoot", "realEntry", "realRoot", "frameUrl",
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
