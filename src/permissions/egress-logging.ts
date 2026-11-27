import { logPermissionEvent, permissionLogId } from "../lib/permission-log.js";
import type {
  SandboxAuditEntry,
  SandboxEgressDecisionAuditEntry,
  SandboxEgressFailureAuditEntry,
  SandboxEgressDenyAuditEntry,
  SandboxEgressGrantMigrationAuditEntry,
  SandboxEgressRouteAuditEntry,
} from "./egress-observation.js";

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
