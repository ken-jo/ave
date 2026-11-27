// Terminal permission metadata and hook observations.
import { randomUUID } from "node:crypto";
import type { ToolSource } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import { answeredRecordForAction, HOST_PROVENANCE, provenanceTrustOrigin } from "../../permissions/approval-gate.js";
import type { AuditToolCategory, PermissionAuditEntryInput, HookResult, ToolExecutionAuditMetadata } from "./permission-decision.js";
import { hookInvocationFailureReason, type HookTrustOrigin, type ScriptHookType } from "../../hooks/script-hook-types.js";
import type { HookDispatchResult } from "../../hooks/script-hook-manager.js";
import type { ToolPermissionContext } from "../executor.js";

export function auditTrustOrigin(context?: ToolPermissionContext): HookTrustOrigin {
  return context?.trustOrigin ?? "unknown";
}

function permissionAuditBase(args: {
  toolName: string;
  source: ToolSource;
  category: AuditToolCategory;
  trustOrigin: HookTrustOrigin;
  audit?: ToolExecutionAuditMetadata;
}): Pick<
  Extract<PermissionAuditEntryInput, { decision: "allow" }>,
  "ts" | "auditId" | "toolUseId" | "attempt" | "executionPlan" | "executionRoute" | "workloadBrokerCorrelation" | "trustOrigin" | "tool" | "source" | "category"
> {
  return {
    ts: new Date().toISOString(),
    auditId: randomUUID(),
    ...(args.audit?.toolUseId !== undefined ? { toolUseId: args.audit.toolUseId } : {}),
    ...(args.audit?.attempt !== undefined ? { attempt: args.audit.attempt } : {}),
    ...(args.audit?.executionPlan !== undefined ? { executionPlan: args.audit.executionPlan } : {}),
    ...(args.audit?.executionRoute !== undefined ? { executionRoute: args.audit.executionRoute } : {}),
    ...(args.audit?.workloadBrokerCorrelation !== undefined
      ? { workloadBrokerCorrelation: args.audit.workloadBrokerCorrelation }
      : {}),
    trustOrigin: args.trustOrigin,
    tool: args.toolName,
    source: args.source,
    category: args.category,
  };
}

// Emit one forensic row per script, preserving source, command identity, and fail-closed cause; omit absent chains.
export function hookChainFromDispatch(
  event: ScriptHookType,
  dispatch: HookDispatchResult | undefined,
): HookResult[] | undefined {
  if (!dispatch || dispatch.results.length === 0) return undefined;
  return dispatch.results.map((r): HookResult => {
    const failureReason = hookInvocationFailureReason(r);
    return {
      hookName: r.hookPath,
      ...(r.additionalContext === undefined ? {} : { additionalContextChars: r.additionalContext.length }),
      ...(r.updatedInput === undefined ? {} : { inputModified: true as const }),
      // Project tool-use event from pre/post/perm input; runtime hookType also includes lifecycle events.
      hookType: event,
      ...(r.matcher === undefined ? {} : { matcher: r.matcher }),
      action: r.decision,
      reason: r.reason,
      durationMs: r.durationMs,
      // Populate event explicitly for readers of the closed audit surface.
      event,
      handlerType: r.handlerType ?? "command",
      commandIdentity: r.commandIdentity,
      source: r.source,
      hookSource: r.hookSource ?? (r.pluginOwner ? "plugin" : "user"),
      decision: r.decision,
      ...(failureReason !== undefined ? { failureReason } : {}),
    };
  });
}

// Omit hookChain when neither input contains rows.
export function mergeHookChains(
  ...chains: Array<HookResult[] | undefined>
): HookResult[] | undefined {
  const merged = chains.filter((c): c is HookResult[] => c !== undefined).flat();
  return merged.length > 0 ? merged : undefined;
}

export function permissionAuditEntryFromToolCall(args: {
  toolName: string;
  source: ToolSource;
  category: AuditToolCategory;
  permission: PermissionCheckResult;
  trustOrigin: HookTrustOrigin;
  hookChain?: HookResult[];
  audit?: ToolExecutionAuditMetadata;
}): PermissionAuditEntryInput {
  // An ask nobody settled is never an allow: it ends as the host's refusal.
  const permission: PermissionCheckResult = args.permission.decision === "ask"
    ? { decision: "deny", reason: args.permission.reason, provenance: HOST_PROVENANCE }
    : args.permission;
  // An answer is recorded only for the action and the decision it settled; any other is a broken binding, and throws.
  if (permission.provenance?.kind === "answered") answeredRecordForAction(permission.provenance, permission.decision === "deny" ? "deny" : "allow", args.toolName, args.audit?.toolUseId);
  if (permission.decision === "deny" && permission.answer) answeredRecordForAction(permission.answer, "allow", args.toolName, args.audit?.toolUseId);
  // The row records who decided, from the decision's provenance.
  const trustOrigin = provenanceTrustOrigin(permission.provenance, permission.decision, args.trustOrigin);
  const base = permissionAuditBase({ ...args, trustOrigin });
  if (permission.decision === "deny") {
    const denyReasons = permission.denyReasons?.length
      ? permission.denyReasons
      : [{
        reason: permission.reason,
        source: "tool-executor",
      }];
    return {
      ...base,
      decision: "deny",
      denyReasons,
      ...(permission.answer ? { answerTrustOrigin: provenanceTrustOrigin(permission.answer, "allow", args.trustOrigin) } : {}),
      ...(args.hookChain ? { hookChain: args.hookChain } : {}),
    };
  }
  const allowEntry: Extract<PermissionAuditEntryInput, { decision: "allow" }> = {
    ...base,
    decision: "allow",
    };
  if (permission.reviewer?.verdict) {
    allowEntry.reviewer = permission.reviewer.verdict;
  }
  if (args.hookChain) {
    allowEntry.hookChain = args.hookChain;
  }
  return allowEntry;
}
