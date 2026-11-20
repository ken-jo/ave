



import os from "node:os";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { PII_PATTERNS } from "../shared/dlp.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { decodeHomeEscapes, type HomeEscapeFamily } from "./home-path-decode.js";
import { rewriteWindowsPathText } from "./home-path-quote-frames.js";

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
  const windows = homePlatform === "win32";
  const root = windows ? win32.parse(raw).root : raw.startsWith("/") ? "/" : "";
  const home = root + raw.slice(root.length).replace(/[\\/]+$/u, "");
  // Quotes and controls can coincide with syntax in serialized text. POSIX
  // filename backslashes can also change the meaning of a following quote.
  // These home spellings are unsupported. Trailing separators are normalized.
  return /["\p{Cc}]/u.test(home) || !windows && home.includes("\\") ? "" : home;
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
  windows?: boolean;
  windowsRoot?: boolean;
  escapedSeparators?: boolean;
}

interface HomeDetector extends HomeForm {
  detector: RegExp;
}

interface HomeRedaction {
  forms: readonly HomeDetector[];
  trigger: RegExp;
  boundaries: ReadonlySet<number>;
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
const HOME_TOKEN_MARKER = "[home-token]";
const SINGLE_DECODE_FAMILY = ["full"] as const;
const BACKSLASH_AND_URI_FAMILIES = ["full", "backslash", "percent-entity"] as const;
const DECODE_FAMILIES: readonly HomeEscapeFamily[] = [...BACKSLASH_AND_URI_FAMILIES, "percent", "entity"];
const URI_AND_ENTITY_FAMILIES: readonly HomeEscapeFamily[] = ["full", "percent", "entity"];
const INTRODUCER = /[\\%&]/u;
const FILENAME_CONTINUATION = /^(?:[\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])/u;
const BOUNDARY_CHARACTERS = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\"'`<>()[]{},|";

function compileHomeRedaction(home: string, platform: NodeJS.Platform): HomeRedaction {
  const windows = platform === "win32";
  const windowsRoot = windows && /[\\/]$/u.test(home);
  const flags = windows || platform === "darwin" ? "iu" : "u";
  const url = home ? pathToFileURL(home).href : "";
  const standard = windowsRoot ? url : url.replace(/\/$/u, "");
  const slashHome = home.replace(/\\/gu, "/");
  const anchor = home.split(/[\\/]/u).filter(Boolean).at(-1);
  const trigger = new RegExp(String.raw`[\\%&]|users|home` + (anchor ? "|" + escapeRegExp(anchor) : ""), "iu");
  const boundaries = new Set([...BOUNDARY_CHARACTERS].map(character => character.charCodeAt(0)));
  for (const character of home) if (character !== '"') boundaries.delete(character.charCodeAt(0));
  if (!home) return { forms: [], trigger, boundaries };
  const spellings = [
    [`file://${slashHome}`, "file://[home]"],
    [standard, "file://[home]"],
    [slashHome, "[home]"],
    [home, "[home]"],
  ] as const;
  const forms = spellings.map(([spelling, marker]) => {
    const start = windows && /^[\\/]/u.test(spelling) ? String.raw`(?<![\\/])` : "";
    const escapedSeparators = spelling === standard;
    const stem = windowsRoot ? spelling.replace(/(?:[\\/]|%5[cC])+$/u, "") : spelling;
    const pattern = homePattern(stem, windows, escapedSeparators);
    const end = windowsRoot ? String.raw`(?=[\\/%])` : `(?!${FILENAME_CONTINUATION.source.slice(1)})`;
    const source = `${start}${pattern}${end}`;
    return { literal: new RegExp(source, `g${flags}`), detector: new RegExp(source, flags), marker, windows, windowsRoot, escapedSeparators };
  });
  return { forms, trigger, boundaries };
}

const homeRedaction = compileHomeRedaction(_homeDir, homePlatform);

export function mayContainHomePath(value: string): boolean {
  return homeRedaction.trigger.test(value);
}

const ESCAPABLE_INITIAL = new Set([..."/\"'bfnrtux"].map(character => character.charCodeAt(0)));

function openingQuoteWidth(text: string, start: number): number | undefined {
  if (text.charCodeAt(start - 1) !== 34) return undefined;
  let prefix = start - 2;
  while (text.charCodeAt(prefix) === 92) prefix--;
  const quoteWidth = start - 1 - prefix;
  if (quoteWidth === 1) return 2;
  while (/[\t\r\n ]/u.test(text.charAt(prefix))) prefix--;
  // A serialized value opener has 2^depth - 1 backslashes. A root
  // separator in that value occupies twice its quote width.
  if (prefix < 0 || !":,[".includes(text.charAt(prefix)) || (quoteWidth & (quoteWidth - 1)) !== 0) {
    return undefined;
  }
  return quoteWidth * 2;
}

function windowsSeparatorEnd(text: string, start: number, width: number, escaped: boolean): number {
  let index = start;
  for (;;) {
    const code = text.charCodeAt(index);
    if (code === 47) {
      index++;
    } else if (code === 92) {
      let next = index + 1;
      while (text.charCodeAt(next) === 92) next++;
      const residue = (next - index) % width;
      if (residue === 0) index = next;
      else if (residue === width / 2 && text.charCodeAt(next) === 47) index = next + 1;
      else return next - residue;
    } else if (escaped && code === 37 && text.charCodeAt(index + 1) === 53 && (text.charCodeAt(index + 2) | 32) === 99) {
      index += 3;
    } else {
      return index;
    }
  }
}

function hasCompleteWindowsSeparators(spelling: string, width: number): boolean {
  if (width === 1) return true;
  for (const { 0: run, index } of spelling.matchAll(/\\+/gu)) {
    const residue = run.length % width;
    if (residue && (residue !== width / 2 || spelling.charCodeAt(index + run.length) !== 47)) return false;
    if (index === 0 && run.length < width * 2 && spelling.charCodeAt(run.length) !== 47) return false;
  }
  return true;
}

function replaceLiteralHomes(text: string, forms: readonly HomeForm[], preserveSiblings = false, separatorWidth = 1): string {
  for (const form of forms) {
    const { literal, marker, windowsRoot } = form;
    let copied = 0;
    let pieces: string[] | undefined;
    const matches = preserveSiblings && !windowsRoot
      ? homeComponentMatches(text, form, HOME_DECODE_LAYERS)
      : text.matchAll(literal);
    for (const match of matches) {
      let start = match.index;
      let end = start + match[0].length;
      if (windowsRoot) {
        if (!hasCompleteWindowsSeparators(match[0], separatorWidth)) continue;
        const rootEnd = windowsSeparatorEnd(text, end, separatorWidth, form.escapedSeparators === true);
        if (rootEnd === end) continue;
        end = rootEnd;
      }
      if (ESCAPABLE_INITIAL.has(text.charCodeAt(start))) {
        while (start > copied && text.charCodeAt(start - 1) === 92) start--;
      }
      pieces ??= [];
      pieces.push(text.slice(copied, start), marker);
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
  if (percent && entities) return backslashes ? DECODE_FAMILIES : URI_AND_ENTITY_FAMILIES;
  return backslashes && (percent || entities) ? BACKSLASH_AND_URI_FAMILIES : SINGLE_DECODE_FAMILY;
}

function someDecodedHomeView(
  token: string, layers: number, match: (view: string, depth: number, width: number) => boolean, separatorWidth = 1,
): boolean {
  const seen = new Map([[token, separatorWidth]]);
  let layer = [{ text: token, width: separatorWidth }];
  // Breadth first keeps the shortest route to each view, including when
  // different escape families reach the same spelling at different depths.
  for (let depth = 1; depth <= layers && layer.length; depth++) {
    const next: typeof layer = [];
    for (const { text, width } of layer) {
      for (const family of escapeFamilies(text)) {
        const decoded = decodeHomeEscapes(text, family);
        if (decoded === text) continue;
        const decodedWidth = family === "full" || family === "backslash" ? Math.max(1, width / 2) : width;
        const widths = seen.get(decoded) ?? 0;
        if (widths & decodedWidth) continue;
        if (match(decoded, depth, decodedWidth)) return true;
        seen.set(decoded, widths | decodedWidth);
        if (depth < layers && INTRODUCER.test(decoded)) next.push({ text: decoded, width: decodedWidth });
      }
    }
    layer = next;
  }
  return false;
}

function hasEncodedFilenameContinuation(text: string, start: number, limit: number, layers: number): boolean {
  if (!layers || start >= limit) return false;
  const introducer = text.charCodeAt(start + (text.charCodeAt(start) === 46 ? 1 : 0));
  if (introducer !== 37 && introducer !== 38 && introducer !== 92) return false;
  const suffix = text.slice(start, limit);
  const boundary = suffix.search(/[/:"'\s]/u);
  const candidate = boundary < 0 ? suffix : suffix.slice(0, boundary);
  return someDecodedHomeView(candidate, layers, view => FILENAME_CONTINUATION.test(view));
}

function hasNativeSeparator(text: string, start: number, suffix: number): boolean {
  if (text.charCodeAt(suffix) !== 92) return false;
  // A native separator starts a descendant even when the name resembles an
  // escape. A serialized separator uses the full slash width of its value.
  const width = openingQuoteWidth(text, start) ?? 1;
  let end = suffix + 1;
  while (end < suffix + width && text.charCodeAt(end) === 92) end++;
  return end === suffix + width;
}

/** Check continuation without using a decoded offset as a replacement boundary. */
function* homeComponentMatches(text: string, form: HomeForm, layers: number): Generator<RegExpExecArray> {
  const matches = text.matchAll(form.literal);
  let next = matches.next();
  while (!next.done) {
    const match = next.value;
    next = matches.next();
    // Check only the gap to the next match so nearby matches cannot make the
    // suffix search revisit the rest of the input for every literal occurrence.
    const limit = next.done ? text.length : next.value.index;
    const suffix = match.index + match[0].length;
    if (form.windows && hasNativeSeparator(text, match.index, suffix)
      || !hasEncodedFilenameContinuation(text, suffix, limit, layers)) yield match;
  }
}

function detectsEncodedHome(token: string, forms: readonly HomeDetector[], separatorWidth: number): boolean {
  return someDecodedHomeView(token, HOME_DECODE_LAYERS, (view, depth, width) => forms.some(form => {
    if (!form.detector.test(view)) return false;
    if (form.windowsRoot) {
      for (const match of view.matchAll(form.literal)) {
        const end = match.index + match[0].length;
        if (hasCompleteWindowsSeparators(match[0], width)
          && windowsSeparatorEnd(view, end, width, form.escapedSeparators === true) > end) return true;
      }
      return false;
    }
    const remaining = HOME_DECODE_LAYERS - depth;
    return !remaining || !homeComponentMatches(view, form, remaining).next().done;
  }), separatorWidth);
}

/** Delimiters and their preceding slash runs belong to the original text. */
function replaceEncodedHomeTokens(text: string, { forms, boundaries }: HomeRedaction, separatorWidth: number): string {
  let pieces: string[] | undefined;
  let copied = 0;
  let start = 0;
  let introduced = false;
  const finish = (end: number): void => {
    if (introduced && start < end && detectsEncodedHome(text.slice(start, end), forms, separatorWidth)) {
      pieces ??= [];
      pieces.push(text.slice(copied, start), HOME_TOKEN_MARKER);
      copied = end;
    }
    introduced = false;
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
function redactConfiguredHome(value: string, separatorWidth: number): string {
  if (!value || !mayContainHomePath(value)) return value;
  let text = replaceLiteralHomes(value, homeRedaction.forms, true, separatorWidth);
  if (homeRedaction.forms.length && INTRODUCER.test(text)) text = replaceEncodedHomeTokens(text, homeRedaction, separatorWidth);
  return text;
}

export function redactHomePathsInText(value: string): string {
  if (!value || !mayContainHomePath(value)) return value;
  const text = homePlatform === "win32" && _homeDir
    ? rewriteWindowsPathText(value, redactConfiguredHome)
    : redactConfiguredHome(value, 1);
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
