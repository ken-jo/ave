



import os from "node:os";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { PII_PATTERNS } from "../shared/dlp.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";
import { decodeHomeEscapes, type HomeEscapeFamily } from "./home-path-decode.js";

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
const DECODE_FAMILIES: readonly HomeEscapeFamily[] = ["full", "backslash", "percent-entity"];
const INTRODUCER = /[\\%&]/u;
const BOUNDARY_CHARACTERS = "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\"'`<>()[]{},|";

function compileHomeRedaction(home: string, platform: NodeJS.Platform): HomeRedaction {
  const windows = platform === "win32";
  const flags = windows || platform === "darwin" ? "iu" : "u";
  const standard = home ? pathToFileURL(home).toString().replace(/\/$/u, "") : "";
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
    const pattern = homePattern(spelling, windows, spelling === standard);
    const source = String.raw`${start}${pattern}(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}_-])`;
    return { literal: new RegExp(source, `g${flags}`), detector: new RegExp(source, flags), marker };
  });
  return { forms, trigger, boundaries };
}

const homeRedaction = compileHomeRedaction(_homeDir, homePlatform);

export function mayContainHomePath(value: string): boolean {
  return homeRedaction.trigger.test(value);
}

const ESCAPABLE_INITIAL = new Set([..."/\"'bfnrtux"].map(character => character.charCodeAt(0)));

function replaceLiteralHomes(text: string, forms: readonly HomeForm[]): string {
  for (const { literal, marker } of forms) {
    let copied = 0;
    let pieces: string[] | undefined;
    for (const match of text.matchAll(literal)) {
      let start = match.index;
      if (ESCAPABLE_INITIAL.has(text.charCodeAt(start))) {
        while (start > copied && text.charCodeAt(start - 1) === 92) start--;
      }
      pieces ??= [];
      pieces.push(text.slice(copied, start), marker);
      copied = match.index + match[0].length;
    }
    if (pieces) text = pieces.join("") + text.slice(copied);
  }
  return text;
}

function detectsEncodedHome(token: string, forms: readonly HomeDetector[]): boolean {
  const seen = new Set([token]);
  let layer = [token];
  // Breadth first keeps the shortest route to each view, including when
  // different escape families reach the same spelling at different depths.
  for (let depth = 0; depth < HOME_DECODE_LAYERS && layer.length; depth++) {
    const next: string[] = [];
    for (const view of layer) {
      const families: readonly HomeEscapeFamily[] = view.includes("\\") && /[%&]/u.test(view) ? DECODE_FAMILIES : ["full"];
      for (const family of families) {
        const decoded = decodeHomeEscapes(view, family);
        if (seen.has(decoded)) continue;
        if (forms.some(({ detector }) => detector.test(decoded))) return true;
        seen.add(decoded);
        if (depth + 1 < HOME_DECODE_LAYERS && INTRODUCER.test(decoded)) next.push(decoded);
      }
    }
    layer = next;
  }
  return false;
}

/** Delimiters and their preceding slash runs belong to the original text. */
function replaceEncodedHomeTokens(text: string, { forms, boundaries }: HomeRedaction): string {
  let pieces: string[] | undefined;
  let copied = 0;
  let start = 0;
  let introduced = false;
  const finish = (end: number): void => {
    if (introduced && start < end && detectsEncodedHome(text.slice(start, end), forms)) {
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
export function redactHomePathsInText(value: string): string {
  if (!value || !mayContainHomePath(value)) return value;
  let text = replaceLiteralHomes(value, homeRedaction.forms);
  if (homeRedaction.forms.length && INTRODUCER.test(text)) text = replaceEncodedHomeTokens(text, homeRedaction);
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
