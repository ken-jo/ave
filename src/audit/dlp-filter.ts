



import os from "node:os";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";

import { PII_PATTERNS } from "../shared/dlp.js";
import { escapeRegExp } from "../shared/escape-reg-exp.js";

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

/** Replace home prefixes in paths and file URLs and cap each field before JSON serialization; non-path strings still receive the cap. */
export function redactFsPath(p: string): string {
  if (!p) return p;
  let out = p;
  if (_homeDir) {
    const standardFileUrlHome = pathToFileURL(_homeDir).toString();
    const legacyFileUrlHome = "file://" + _homeDir;
    const windows = os.platform() === "win32";
    const comparable = (value: string): string => windows ? value.replace(/\\/gu, "/").toLowerCase() : value;
    const startsAtHome = (home: string): boolean => {
      const path = comparable(out);
      const prefix = comparable(home);
      return path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "\\");
    };
    const standardMatch = windows
      ? new RegExp(`^${homePattern(standardFileUrlHome, true, true)}(?=$|[/\\\\]|%5[cC])`, "iu").exec(out)
      : null;
    if (standardMatch || startsAtHome(standardFileUrlHome)) {
      out = "file://<home>" + out.slice(standardMatch?.[0].length ?? standardFileUrlHome.length);
    } else if (startsAtHome(legacyFileUrlHome)) {
      out = "file://<home>" + out.slice(legacyFileUrlHome.length).replace(/\\/g, "/");
    } else if (startsAtHome(_homeDir)) {
      out = "<home>" + out.slice(_homeDir.length);
    }
  }
  // Iterate code points so truncation cannot split surrogate pairs.
  const codePoints = [...out];
  return codePoints.length > MAX_AUDIT_PATH ? codePoints.slice(0, MAX_AUDIT_PATH).join("") + "…" : out;
}

interface HomeForm {
  literal: RegExp;
  marker: string;
}

interface HomeRedaction {
  forms: readonly HomeForm[];
  trigger: RegExp;
}

const GENERIC_HOME_FORMS: readonly HomeForm[] = [
  { literal: /file:\/\/\/[a-z]:\/users\/[a-z0-9._-]+/giu, marker: "file://[home]" },
  { literal: /file:\/\/\/users\/[a-z0-9._-]+/giu, marker: "file://[home]" },
  { literal: /file:\/\/\/home\/[a-z0-9._-]+/giu, marker: "file://[home]" },
  { literal: /[a-z]:[\\/]+users[\\/]+[a-z0-9._-]+/giu, marker: "[home]" },
  { literal: /\/users\/[a-z0-9._-]+/giu, marker: "[home]" },
  { literal: /\/home\/[a-z0-9._-]+/giu, marker: "[home]" },
];

function compileHomeRedaction(home: string, platform: NodeJS.Platform): HomeRedaction {
  const windows = platform === "win32";
  const standard = home ? pathToFileURL(home).toString().replace(/\/$/u, "") : "";
  const slashHome = home.replace(/\\/gu, "/");
  const anchor = home.split(/[\\/]/u).filter(Boolean).at(-1);
  const trigger = new RegExp(String.raw`[\\%&]|users|home` + (anchor ? "|" + escapeRegExp(anchor) : ""), "iu");
  if (!home) return { forms: [], trigger };
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
    return { literal: new RegExp(source, windows ? "giu" : "gu"), marker };
  });
  return { forms, trigger };
}

const homeRedaction = compileHomeRedaction(_homeDir, homePlatform);

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

/** Unlike prefix-only path redaction, display text must redact home paths anywhere, including file URLs. */
export function redactHomePathsInText(value: string): string {
  if (!value || !homeRedaction.trigger.test(value)) return value;
  return replaceLiteralHomes(replaceLiteralHomes(value, homeRedaction.forms), GENERIC_HOME_FORMS);
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
