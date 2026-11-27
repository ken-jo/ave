import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
/** Sandbox telemetry sink (docs/research/sandbox-isolation.md).
 * Callers must DLP-mask arguments and justifications; files use 0o600 and directories 0o700. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { aveHome } from "../shared/ave-home.js";
import { utcDateKey } from "../shared/local-date.js";
import type {
  SandboxAuditEntry,
  SandboxEgressDecisionAuditEntry,
  SandboxEgressFailureAuditEntry,
  SandboxEgressDenyAuditEntry,
  SandboxEgressGrantMigrationAuditEntry,
  SandboxEgressRouteAuditEntry,
} from "./sandbox-audit.js";

/** Partition sandbox and permission channels by the same UTC day for forensic correlation; tests may inject the date. */
function sinkPath(date = new Date()): string {
  const ymd = utcDateKey(date);
  return resolve(aveHome(), "audit", `${ymd}.sandbox.jsonl`);
}

/** Append one JSONL row with file mode 0o600 and directory mode 0o700; callers decide how to handle write failures. */
export async function emitSandboxAudit(
  entry:
    | SandboxAuditEntry
    | SandboxEgressDenyAuditEntry
    | SandboxEgressDecisionAuditEntry
    | SandboxEgressFailureAuditEntry
    | SandboxEgressRouteAuditEntry
    | SandboxEgressGrantMigrationAuditEntry,
): Promise<void> {
  if (!("entryKind" in entry)) {
    logPermissionEvent("sandbox_execution", {
      tool: permissionLogId(entry.tool.name), source: permissionLogId(entry.tool.source),
      trustOrigin: entry.tool.trustOrigin, sandboxKind: entry.sandbox.kind,
      confidence: entry.sandbox.confidence, eventCount: entry.sandbox.events.length,
      spawnLatencyMs: entry.sandbox.spawnLatencyMs, reviewerRisk: entry.reviewer.finalVerdict,
      approvalCacheHit: entry.reviewer.userApprovalUsed?.memoryHit,
    });
    return;
  }
  switch (entry.entryKind) {
    case "egress-deny":
      logPermissionEvent("sandbox_egress_denied", { sandboxKind: entry.sandbox.kind, attribution: entry.invocation.kind });
      break;
    case "egress-decision":
      logPermissionEvent("sandbox_egress_decision", {
        decision: entry.decision, basis: entry.basis, scope: entry.scope ?? undefined,
        attribution: entry.invocation.kind,
      });
      break;
    case "egress-failure":
      logPermissionEvent("sandbox_egress_failed", {
        failure: entry.failure.kind, status: entry.failure.httpStatus, attribution: entry.invocation.kind,
      }, "warn");
      break;
    case "egress-grant-migration":
      logPermissionEvent("sandbox_egress_grant_migrated", { action: entry.action });
      break;
    case "egress-route":
      logPermissionEvent("sandbox_egress_route_skipped", {
        source: permissionLogId(entry.source), skippedCount: entry.skipped.length,
      }, "warn");
      break;
  }
}

const pendingSandboxAuditWrites = new Set<Promise<void>>();


/**
 * Wait until every sandbox audit write started before or during this call has
 * settled. Failures stay with the caller of {@link emitSandboxAudit}; this only
 * waits. Lifecycle owners await it before removing the audit directory.
 */
export async function flushSandboxAudit(): Promise<void> {
  while (pendingSandboxAuditWrites.size > 0) {
    await Promise.all([...pendingSandboxAuditWrites]);
  }
}

export function sandboxAuditSinkPath(): string {
  return sinkPath();
}

const DAY_MS = 86_400_000;

/** Read recent denials from persisted audit rows, newest first and capped.
 * Skip missing files and malformed lines so a torn append cannot hide other denials. */
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
      // Most sandbox rows are tool executions; pre-filter before parsing.
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
