import { logPermissionEvent, permissionLogId } from "../../lib/permission-log.js";
import type { KindedTerminalRowWriter, TerminalDenial, TerminalLifecycleEvent } from "../invocation-ledger.js";
import type { ToolAuditTerminationReason } from "../executor-contract.js";
// Tool terminal rows go through auditToolCall with a row writer only the ledger hands out and the kind its writer named;
// the ledger fires one PermissionDenied per permission-denial row, except for a governed tool, and none for a cancellation.
import type { ToolSource, ToolCategory, TrustLevel } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import { answeredProvenanceRecord, answeredRecordForAction, provenanceTrustOrigin, type DecisionProvenance } from "../../permissions/approval-gate.js";
import type { HookResult, ToolExecutionAuditMetadata } from "./permission-decision.js";
import type {
  ScriptHookManager,
  HookDispatchResult,
} from "../../hooks/script-hook-manager.js";
import type { HookTrustOrigin, LifecycleEventPayload } from "../../hooks/script-hook-types.js";
import { recordHookContext, recordHookExecutionAudit } from "../../hooks/hook-influence.js";
import { currentToolExecutionCwd } from "../execution-context.js";
import type { ToolPermissionContext } from "../executor.js";
import {
  auditTrustOrigin,
  permissionAuditEntryFromToolCall,
} from "./audit-entries.js";


export function auditSafeToolInput(
  input: Record<string, unknown>,
  audit: ToolExecutionAuditMetadata | undefined,
): Record<string, unknown> {
  if (audit?.governedOperation === undefined) return input;
  return {
    operation: audit.governedOperation ?? "<invalid>",
  };
}

export interface LifecycleDispatchObservation {
  status: "unwired" | "no-match" | "executed" | "uncertain";
  result?: HookDispatchResult;
}

export class AuditWriter {
  constructor(
    private readonly scriptHookManager: ScriptHookManager | undefined,
  ) {}

  // Lifecycle hooks are observe-only: audit decisions but never alter tool control flow or propagate errors.
  fireLifecycleEvent(
    event: "PostToolUseFailure",
    sessionId: string | undefined,
    context: { readonly trustOrigin: HookTrustOrigin },
    payload: LifecycleEventPayload,
    abortSignal?: AbortSignal,
  ): Promise<LifecycleDispatchObservation> {
    return this.#dispatch(event, sessionId, context, payload, abortSignal);
  }

  /** Fires the denial the ledger committed; nothing but the ledger can mint one. */
  fireDenied(
    denial: TerminalDenial,
    sessionId: string | undefined,
    context: { readonly trustOrigin: HookTrustOrigin },
    payload: LifecycleEventPayload,
    abortSignal?: AbortSignal,
  ): Promise<LifecycleDispatchObservation> {
    return this.#dispatch(denial.event, sessionId, context, payload, abortSignal);
  }

  async #dispatch(
    event: "PostToolUseFailure" | TerminalLifecycleEvent,
    sessionId: string | undefined,
    context: { readonly trustOrigin: HookTrustOrigin },
    payload: LifecycleEventPayload,
    abortSignal: AbortSignal | undefined,
  ): Promise<LifecycleDispatchObservation> {
    if (!this.scriptHookManager) return { status: "unwired" };
    try {
      const result = await this.scriptHookManager.runLifecycleEvent(
        event,
        sessionId ?? "unknown",
        context.trustOrigin,
        payload,
        { cwd: currentToolExecutionCwd() ?? process.cwd(), abortSignal },
      );
      recordHookContext(result.results);
      recordHookExecutionAudit(sessionId ?? "unknown", result.results);
      if (result.results.length > 0) {
        return { status: "executed", result };
      }
      if (result.reason === "no matching lifecycle hooks") {
        return { status: "no-match", result };
      }
      // Missing evidence without a confirmed no-match is indeterminate.
      return { status: "uncertain", result };
    } catch {
      // Defensive: observe-only events must never break a tool call.
      return { status: "uncertain" };
    }
  }

  // Record directory grants separately from tool outcome, with exactly one user grantLifetime or automatic policyRule.
  // Wide reads produce no grant or dialog, so this row is their only directory-decision evidence.
  async auditPermissionGrant(args: {
    toolName: string;
    source: ToolSource;
    category: ToolCategory;
    directory: string;
    grantLifetime?: "turn" | "session" | "always" | "degraded-to-turn";
    policyRule?: string;
    permissionContext?: ToolPermissionContext;
    // Who made the grant: its answerer, or the policy under the invocation's origin.
    provenance: DecisionProvenance;
    audit?: ToolExecutionAuditMetadata;
  }): Promise<void> {
    // A grant records only the answer that allowed this action.
    if (args.provenance.kind === "answered") answeredRecordForAction(args.provenance, "allow", args.toolName, args.audit?.toolUseId);
    logPermissionEvent("permission_directory_grant", {
      tool: permissionLogId(args.toolName), source: args.source, category: args.category, decision: "allow",
      correlationId: args.audit?.correlationId, grantLifetime: args.grantLifetime,
      policyRule: permissionLogId(args.policyRule),
      trustOrigin: provenanceTrustOrigin(args.provenance, "allow", auditTrustOrigin(args.permissionContext)),
    });
  }

  async auditPermissionAsk(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    _input: Record<string, unknown>,
    permission: PermissionCheckResult,
    _cwd: string,
    permissionContext?: ToolPermissionContext,
    _auditDirectory?: string,
    audit?: ToolExecutionAuditMetadata,
    sessionId?: string,
  ): Promise<void> {
    logPermissionEvent("permission_decision", {
      tool: permissionLogId(toolName), correlationId: audit?.correlationId,
      sessionId: permissionLogId(sessionId ?? permission.pipelineRequest?.sessionId),
      requestId: permissionLogId(permission.reviewer?.requestId),
      attempt: audit?.attempt ?? 1, source, category, decision: "ask",
      reasonCode: permissionLogId(permission.reasonCode),
      trustOrigin: auditTrustOrigin(permissionContext),
      provenance: permission.provenance?.kind,
      sandboxRoute: audit?.executionRoute?.route ?? audit?.executionPlan?.substrate,
    });
  }

  async auditToolCall(
    sessionId: string | undefined,
    toolName: string,
    source: ToolSource,
    trust: TrustLevel,
    _input: Record<string, unknown>,
    _output: string,
    isError: boolean,
    startTime: number,
    permission: PermissionCheckResult,
    _rateLimitRemaining: number,
    permissionContext?: ToolPermissionContext,
    category?: ToolCategory,
    _cwd?: string,
    _auditDirectory?: string,
    terminationReason?: ToolAuditTerminationReason,
    hookChain?: HookResult[],
    audit?: ToolExecutionAuditMetadata,
    terminal?: KindedTerminalRowWriter,
  ): Promise<void> {
    if (!terminal) throw new Error(`terminal row of ${toolName} has no ledger writer`);
    // Every terminal row is written; what the host could not resolve is recorded as unknown.
    const entry = permissionAuditEntryFromToolCall({
      toolName,
      source,
      category: category ?? "unknown",
      permission,
      trustOrigin: auditTrustOrigin(permissionContext),
      ...(hookChain ? { hookChain } : {}),
      audit,
    });
    const fields = {
      sessionId: permissionLogId(sessionId),
      isError,
      trust,
      elapsedMs: Date.now() - startTime,
      provenance: permission.provenance?.kind,
      reasonCode: permissionLogId(permission.reasonCode),
      requestId: permissionLogId(permission.provenance.kind === "answered"
        ? answeredProvenanceRecord(permission.provenance).requestId
        : permission.reviewer?.requestId),
      terminationReason,
      operation: permissionLogId(audit?.governedOperation),
    };
    await (entry.decision === "deny"
      ? terminal.row({ entry, kind: terminal.kind, fields, ...(permission.decision === "deny" ? { reason: permission.reason } : {}),
        humanAnswered: permission.provenance?.kind === "answered" && answeredProvenanceRecord(permission.provenance).trustOrigin !== "unknown" })
      : terminal.row({ entry, fields }));
  }
}
