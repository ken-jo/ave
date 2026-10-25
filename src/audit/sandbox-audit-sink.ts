/**
 * S2 Sandbox Audit Sink — append pipeline for sandbox execution audit entries.
 *
 * Spec ref: docs/research/sandbox-isolation.md §3.6 (S2 audit fields)
 * Issue: #691
 *
 * This module provides the *sink* for `SandboxAuditEntry` records — the
 * emit pipeline for sandbox execution audit entries. Entries are appended in JSONL format
 * to `~/.ave/audit/<YYYY-MM-DD>.sandbox.jsonl` (daily-rotated, same
 * directory as the permission-gate audit channel so the AuditPanel reader
 * can glob both channels from one directory).
 *
 * DLP note: callers MUST pass DLP-redacted args and nlJustification.
 * This sink does NOT apply DLP — it trusts the caller has already run
 * `maskSensitiveData()` on sensitive fields before calling `emitSandboxAudit`.
 * That responsibility is co-located with the PermissionManager.dispatchReviewer
 * call-site, which already has a DLP-redacted `finalInput` in scope.
 *
 * File permissions: 0o600 (user-read/write only).
 * Directory permissions: 0o700 (created if absent).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { utcDateKey } from "../shared/local-date.js";
import type {
  SandboxAuditEntry,
  SandboxEgressDecisionAuditEntry,
  SandboxEgressDenyAuditEntry,
  SandboxEgressRouteAuditEntry,
} from "./sandbox-audit.js";

// ─── Sink path ────────────────────────────────────────────────────────────────

/**
 * Path to the daily-rotated sandbox JSONL audit log.
 *
 * Returns `~/.ave/audit/<YYYY-MM-DD>.sandbox.jsonl` — one file per calendar
 * day in the same `~/.ave/audit/` directory used by the permission-gate audit
 * channel. The `.sandbox` infix distinguishes the two channels; the AuditPanel
 * reader globs `~/.ave/audit/` and surfaces both without needing a discriminator
 * field scan on every entry.
 *
 * Accepts an optional `date` parameter so tests can inject a fixed date without
 * touching the real clock.
 *
 * Timezone — UTC. {@link utcDateKey} yields the UTC calendar day, the same
 * partition key `audit-logger.ts` names its daily files by.
 * Both channels roll at UTC midnight so events emitted moments apart cannot
 * land in different daily files based on the operator's local timezone.
 * Forensic correlation across timezones relies on this invariant.
 */
function sinkPath(date = new Date()): string {
  const ymd = utcDateKey(date);
  return resolve(aveHome(), "audit", `${ymd}.sandbox.jsonl`);
}

// ─── Emit ─────────────────────────────────────────────────────────────────────

/**
 * Append a single `SandboxAuditEntry` to the JSONL audit log.
 *
 * Each call appends exactly one line: `${JSON.stringify(entry)}\n`.
 * The file is created if it does not exist (mode 0o600).
 * The parent directory is created if absent (mode 0o700).
 *
 * Failures are NOT swallowed — the caller decides whether to log-and-continue
 * or surface the error. Production call-sites in `permission-manager.ts` wrap
 * this in a try/catch and log the error without blocking the tool execution.
 */
export async function emitSandboxAudit(
  entry: SandboxAuditEntry | SandboxEgressDenyAuditEntry | SandboxEgressDecisionAuditEntry | SandboxEgressRouteAuditEntry,
): Promise<void> {
  const path = sinkPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/**
 * Return the resolved audit log path (for tests and the AuditPanel IPC handler).
 */
export function sandboxAuditSinkPath(): string {
  return sinkPath();
}

// ─── Recent egress denials ────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * The proxy denies of the last `windowMs` (24 h by default), newest first, at
 * most `limit` of them, read back from the sandbox channel itself so the
 * Settings list and the audit log cannot disagree and the list survives a
 * restart. A 24 h window spans at most two UTC days, so at most two daily
 * files are read; a missing file is an empty day. A line that does not parse
 * is skipped: the channel is append-only and a torn last line from a crash
 * must not hide the rest.
 */
export async function readRecentSandboxEgressDenials(options: {
  now?: Date;
  windowMs?: number;
  limit?: number;
} = {}): Promise<SandboxEgressDenyAuditEntry[]> {
  const now = options.now ?? new Date();
  const windowMs = options.windowMs ?? DAY_MS;
  const limit = options.limit ?? 200;
  const since = now.getTime() - windowMs;
  const days = new Set([sinkPath(new Date(since)), sinkPath(now)]);
  const rows: SandboxEgressDenyAuditEntry[] = [];
  for (const path of days) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const line of text.split("\n")) {
      // Cheap pre-filter: most rows on this channel are tool-execution rows.
      if (!line.includes('"entryKind":"egress-deny"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isEgressDenyEntry(parsed)) continue;
      const at = Date.parse(parsed.timestamp);
      if (Number.isNaN(at) || at < since || at > now.getTime()) continue;
      rows.push(parsed);
    }
  }
  rows.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return rows.slice(0, limit);
}

function isEgressDenyEntry(value: unknown): value is SandboxEgressDenyAuditEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<SandboxEgressDenyAuditEntry>;
  return row.entryKind === "egress-deny"
    && typeof row.timestamp === "string"
    && typeof row.invocation === "object" && row.invocation !== null
    && typeof row.deny === "object" && row.deny !== null
    && typeof row.deny.host === "string";
}
