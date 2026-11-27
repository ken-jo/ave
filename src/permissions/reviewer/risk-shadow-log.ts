import { logPermissionEvent, permissionLogId } from "../../lib/permission-log.js";
// Observed-effect records use the dedicated non-HMAC shadow channel; emission never changes permission.
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { EffectSummary } from "../effect-ledger.js";
import type { ToolSource } from "../../shared/permission-review-status.js";

type EffectShadowRecord = ({ toolName: string; source: ToolSource; pluginId?: string }
  | { hostApiPath: string; source: "plugin"; pluginId: string }) & {
  // Whether this tool's effects are HOST-OBSERVABLE — `true` for in-process plugin tools whose hostApi closures are instrumented, `false` for tools the host does not mediate (external `source:"mcp"`, which never reaches the instrumented chokepoints). When `false`, an EMPTY effect summary is NOT a confirmed read — a later read-recognition gate MUST fail closed on `hostObservable:false` and never auto-relax to read.
  hostObservable: boolean;
  // Host-observed effects collected for this invocation (the EffectLedger summary).
  hostObservedEffect: EffectSummary;
};

// Record host-observed effects for later read recognition; unobservable empty ledgers cannot prove a read.
export function emitEffectShadowLog(
  record: EffectShadowRecord,
  _auditLogger: Pick<AuditLogger, "logShadow">,
): void {
  const { hasMutatingEffect, effects, observationIncomplete } = record.hostObservedEffect;
  logPermissionEvent("permission_effect_observed", {
    tool: "toolName" in record ? permissionLogId(record.toolName) : undefined,
    source: record.source,
    pluginId: permissionLogId(record.pluginId),
    hostObservable: record.hostObservable,
    hasMutatingEffect,
    effectCount: effects.length,
    observationIncomplete,
  });
}
