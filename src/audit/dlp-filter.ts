



import os from "node:os";
import { posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { PII_PATTERNS } from "../shared/dlp.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { decodeHomeEscapes, type HomeEscapeFamily, mayDecodeHomeCharacter, readHomeEntity } from "./home-path-decode.js";

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

function configuredHome(): string {
  let raw: string;
  try { raw = os.homedir(); } catch { return ""; }
  if (!raw) return "";
  const windows = homePlatform === "win32";
  const paths = windows ? win32 : posix;
  const root = paths.parse(raw).root;
  const spelling = root + raw.slice(root.length).replace(/[\\/]+$/u, "");
  // Quotes and controls can coincide with syntax in serialized text. POSIX
  // filename backslashes can also change the meaning of a following quote.
  if (/["\p{Cc}]/u.test(spelling) || !windows && spelling.includes("\\")) return "";
  const home = paths.resolve(spelling);
  // Root homes have no account component. Only the generic text rules apply.
  return home === paths.parse(home).root ? "" : home;
}

const _homeDir = configuredHome();

const MAX_AUDIT_PATH = 256;

/** File URLs can encode native separators even when generated on a different platform. */
function homePattern(home: string, windows: boolean, fileUrl = false): string {
  return windows
    ? home.split(/([\\/]+)/u).map(part => /^[\\/]/u.test(part)
      ? (fileUrl ? String.raw`(?:[\\/]|%5[cC]){${part.length},}` : String.raw`[\\/]{${part.length},}`)
      : escapeRegExp(part)).join("")
    : escapeRegExp(home);
}

interface HomePrefix {
  pattern: RegExp;
  marker: string;
  slashSuffix: boolean;
}

function compileHomePrefixes(home: string): { literal: HomePrefix[]; decoded: HomePrefix[] } {
  if (!home) return { literal: [], decoded: [] };
  const windows = homePlatform === "win32";
  const flags = windows || homePlatform === "darwin" ? "iu" : "u";
  const standard = pathToFileURL(home).href;
  const legacy = `file://${home}`;
  const compile = (prefix: string, url: boolean, slashSuffix = false, nativeUrl = false): HomePrefix => {
    const tail = /[\\/]$/u.test(prefix) ? "" : url
      ? nativeUrl ? String.raw`(?=$|[\\/?#]|%5[cC])` : String.raw`(?=$|[\\/?#])`
      : String.raw`(?=$|[\\/])`;
    return {
      pattern: new RegExp(`^${homePattern(prefix, windows, nativeUrl)}${tail}`, flags),
      marker: url ? "file://<home>" : "<home>",
      slashSuffix,
    };
  };
  const bare = compile(home, false);
  const native = compile(legacy, true, true);
  return {
    literal: [compile(standard, true, false, windows), native, bare],
    decoded: [compile(decodeHomeEscapes(standard, "percent-entity"), true), native, bare],
  };
}

const homePrefixes = compileHomePrefixes(_homeDir);

function replaceHomePrefix(path: string, prefixes: readonly HomePrefix[]): string | undefined {
  const value = path.replace(/^file:/iu, "file:");
  for (const { pattern, marker, slashSuffix } of prefixes) {
    const match = pattern.exec(value);
    if (!match) continue;
    const suffix = path.slice(match[0].length);
    return marker + (slashSuffix ? suffix.replace(/\\/gu, "/") : suffix);
  }
  return undefined;
}

/** Prefer the literal prefix. An encoded prefix is replaced in a decoded path value. */
export function redactFsPath(path: string): string {
  if (!path) return path;
  const out = replaceHomePrefix(path, homePrefixes.literal)
    ?? replaceHomePrefix(decodeHomeEscapes(path, "percent-entity"), homePrefixes.decoded)
    ?? path;
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

function compileHomeRedaction(home: string, platform: NodeJS.Platform): HomeRedaction {
  const windows = platform === "win32";
  const flags = windows || platform === "darwin" ? "iu" : "u";
  const standard = home ? pathToFileURL(home).href.replace(/\/$/u, "") : "";
  const slashHome = home.replace(/\\/gu, "/");
  const anchor = home.split(/[\\/]/u).filter(Boolean).at(-1);
  const trigger = new RegExp(String.raw`[\\%&]|users|home` + (anchor ? "|" + escapeRegExp(anchor) : ""), "iu");
  const boundaries = new Set([...BOUNDARY_CHARACTERS].map(character => character.charCodeAt(0)));
  for (const character of home) if (character !== '"') boundaries.delete(character.charCodeAt(0));
  const requiredPathCharacter = windows ? /^[a-z]:/iu.test(home) ? ":" : "" : home.startsWith("/") ? "/" : "";
  if (!home) return { forms: [], trigger, boundaries, requiredPathCharacter };
  const spellings = [
    [`file://${slashHome}`, "file://[home]"],
    [standard, "file://[home]"],
    [slashHome, "[home]"],
    [home, "[home]"],
  ] as const;
  const forms = spellings.map(([spelling, marker]) => {
    const start = windows && /^[\\/]/u.test(spelling) ? String.raw`(?<![\\/])` : "";
    const pattern = homePattern(spelling, windows, spelling === standard);
    const source = String.raw`${start}${pattern}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])`;
    return { literal: new RegExp(source, `g${flags}`), detector: new RegExp(source, flags), marker };
  });
  return { forms, trigger, boundaries, requiredPathCharacter };
}

const homeRedaction = compileHomeRedaction(_homeDir, homePlatform);

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

function replaceLiteralHomes(text: string, forms: readonly HomeForm[], markers?: LiteralMarkers): string {
  for (const { literal, marker } of forms) {
    let copied = 0;
    let pieces: string[] | undefined;
    let spans: LiteralMarker[] | undefined;
    let previousMarker = 0;
    let offset = 0;
    const copyMarker = (previous: LiteralMarker): void => {
      spans?.push({ start: previous.start + offset, end: previous.end + offset });
    };
    for (const match of text.matchAll(literal)) {
      let start = match.index;
      const end = start + match[0].length;
      if (ESCAPABLE_INITIAL.has(text.charCodeAt(start))) {
        while (start > copied && text.charCodeAt(start - 1) === 92) start--;
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

/** Delimiters and their preceding slash runs belong to the original text. */
function replaceEncodedHomeTokens(
  text: string, { forms, boundaries, requiredPathCharacter }: HomeRedaction, markers: readonly LiteralMarker[],
): string {
  let pieces: string[] | undefined;
  let copied = 0;
  let start = 0;
  let introduced = false;
  let markerIndex = 0;
  let markerStart = markers[0]?.start ?? Infinity;
  let literalSuffix = false;
  let separatorEnd = 0;
  let escapedSuffix = false;
  const entityValue = { value: 0 };
  const containsEncodedHome = (token: string): boolean => {
    if (requiredPathCharacter && token.length >= LARGE_ESCAPE_TOKEN && !token.includes(requiredPathCharacter)
      && !mayDecodeHomeCharacter(token, requiredPathCharacter.charCodeAt(0), HOME_DECODE_LAYERS)) return false;
    return detectsEncodedHome(token, forms);
  };
  const finish = (end: number): void => {
    let replaceFrom = start;
    // A literal descendant can end at a raw list separator. Prefer the
    // separate token, with the original candidate as the fallback.
    if (introduced && separatorEnd > start && separatorEnd < end
      && containsEncodedHome(text.slice(separatorEnd, end))
      && (!escapedSuffix || !containsEncodedHome(text.slice(start, separatorEnd)))) {
      replaceFrom = separatorEnd;
    }
    literalSuffix = false;
    separatorEnd = 0;
    if (introduced && start < end) {
      introduced = false;
      if (replaceFrom === start && !containsEncodedHome(text.slice(start, end))) return;
      pieces ??= [];
      pieces.push(text.slice(copied, replaceFrom), HOME_TOKEN_MARKER);
      copied = end;
    }
    introduced = false;
  };
  for (let index = 0; index < text.length;) {
    if (index === markerStart) {
      finish(index);
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
        finish(index);
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
      if (literalSuffix && code === 59) {
        separatorEnd = index + 1;
        escapedSuffix = introduced;
        literalSuffix = false;
      }
      if (code === 37 || code === 38) introduced = true;
      // A reference's terminating semicolon is part of the escape.
      index += literalSuffix && code === 38 ? Math.max(1, readHomeEntity(text, index, entityValue)) : 1;
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
