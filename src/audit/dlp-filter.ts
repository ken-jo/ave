



import os from "node:os";
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

// Resolve home once; tolerate throwing or invalid test homedir values.
const _homeDir = (() => { try { return os.homedir(); } catch { return ""; } })();

const MAX_AUDIT_PATH = 256;

/** Replace home prefixes in paths and file URLs and cap each field before JSON serialization; non-path strings still receive the cap. */
export function redactFsPath(p: string): string {
  if (!p) return p;
  let out = p;
  if (_homeDir) {
    const standardFileUrlHome = pathToFileURL(_homeDir).toString();
    const legacyFileUrlHome = "file://" + _homeDir;
    if (out === standardFileUrlHome || out.startsWith(standardFileUrlHome + "/")) {
      out = "file://<home>" + out.slice(standardFileUrlHome.length);
    } else if (out === legacyFileUrlHome || out.startsWith(legacyFileUrlHome + "/") || out.startsWith(legacyFileUrlHome + "\\")) {
      out = "file://<home>" + out.slice(legacyFileUrlHome.length).replace(/\\/g, "/");
    } else if (out === _homeDir || out.startsWith(_homeDir + "/") || out.startsWith(_homeDir + "\\")) {
      out = "<home>" + out.slice(_homeDir.length);
    }
  }
  // Iterate code points so truncation cannot split surrogate pairs.
  const codePoints = [...out];
  return codePoints.length > MAX_AUDIT_PATH ? codePoints.slice(0, MAX_AUDIT_PATH).join("") + "…" : out;
}

/** Unlike prefix-only path redaction, display text must redact home paths anywhere, including file URLs. */
export function redactHomePathsInText(value: string): string {
  if (!value) return value;
  let out = value;
  if (_homeDir) {
    const standardFileUrlHome = pathToFileURL(_homeDir).toString().replace(/\/$/u, "");
    const homeForms = [
      ["file://" + _homeDir.replace(/\\/g, "/"), "file://[home]"],
      [standardFileUrlHome, "file://[home]"],
      [_homeDir.replace(/\\/g, "/"), "[home]"],
      [_homeDir, "[home]"],
    ] as const;
    for (const [home, replacement] of homeForms) {
      if (!home) continue;
      out = out.replace(
        new RegExp(escapeRegExp(home), os.platform() === "win32" ? "giu" : "gu"),
        replacement,
      );
    }
  }
  return out
    .replace(/file:\/\/\/[a-z]:\/users\/[a-z0-9._-]+/giu, "file://[home]")
    .replace(/file:\/\/\/users\/[a-z0-9._-]+/giu, "file://[home]")
    .replace(/file:\/\/\/home\/[a-z0-9._-]+/giu, "file://[home]")
    .replace(/[a-z]:[\\/]+users[\\/]+[a-z0-9._-]+/giu, "[home]")
    .replace(/\/users\/[a-z0-9._-]+/giu, "[home]")
    .replace(/\/home\/[a-z0-9._-]+/giu, "[home]");
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
