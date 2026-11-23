import { appendToolInvocationAudit, recordToolInvocationAuditFailure } from "../invocation-ledger.js";
import type { ToolAuditTerminationReason } from "../../audit/audit-logger.js";
// Every ordinary tool denial must finalize through auditToolCall so PermissionDenied fires exactly once.
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../registry.js";
import type { ToolSource, ToolCategory, TrustLevel } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import { answeredRecordForAction, provenanceTrustOrigin, type DecisionProvenance } from "../../permissions/approval-gate.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput, HookResult, ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import { isPiiRedactionEnabled, maskSensitiveData } from "../../audit/dlp-filter.js";
import type {
  ScriptHookManager,
  HookDispatchResult,
} from "../../hooks/script-hook-manager.js";
import type { HookTrustOrigin, LifecycleEventPayload } from "../../hooks/script-hook-types.js";
import { recordHookContext, recordHookExecutionAudit } from "../../hooks/hook-influence.js";
import { currentToolExecutionCwd } from "../execution-context.js";
import { createLogger } from "../../lib/logger.js";
import type { ToolPermissionContext } from "../executor.js";
import {
  auditTrustOrigin,
  permissionAuditAskEntryFromToolCall,
  permissionAuditEntryFromToolCall,
} from "./audit-entries.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("executor");

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
    private readonly auditLogger: AuditLogger,
    private readonly toolRegistry: ToolRegistry,
    private readonly scriptHookManager: ScriptHookManager | undefined,
    private readonly requirePermissionAuditChain: boolean,
  ) {}

  // Lifecycle hooks are observe-only: audit decisions but never alter tool control flow or propagate errors.
  async fireLifecycleEvent(
    event: "PostToolUseFailure" | "PermissionDenied",
    sessionId: string | undefined,
    context: ToolPermissionContext,
    payload: LifecycleEventPayload,
    abortSignal?: AbortSignal,
  ): Promise<LifecycleDispatchObservation> {
    if (!this.scriptHookManager) return { status: "unwired" };
    try {
      const result = await this.scriptHookManager.runLifecycleEvent(
        event,
        sessionId ?? "unknown",
        context.trustOrigin as HookTrustOrigin,
        payload,
        { cwd: currentToolExecutionCwd() ?? process.cwd(), abortSignal },
      );
      recordHookContext(result.results);
      recordHookExecutionAudit(this.auditLogger, sessionId ?? "unknown", result.results);
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
    if (!this.auditLogger.isPermissionAuditChainReady()) {
      if (this.requirePermissionAuditChain) {
        const error = new Error("permission audit chain is not initialized");
        recordToolInvocationAuditFailure(error);
        throw error;
      }
      return;
    }
    const entry: PermissionAuditEntryInput = {
      decision: "allow",
      ts: new Date().toISOString(),
      auditId: randomUUID(),
      tool: args.toolName,
      source: args.source,
      category: args.category,
      directory: args.directory,
      directoryAllowed: true,
      ...(args.grantLifetime !== undefined ? { grantLifetime: args.grantLifetime } : {}),
      ...(args.policyRule !== undefined ? { policyRule: args.policyRule } : {}),
      ...(args.audit?.toolUseId !== undefined ? { toolUseId: args.audit.toolUseId } : {}),
      ...(args.audit?.executionPlan !== undefined ? { executionPlan: args.audit.executionPlan } : {}),
      ...(args.audit?.executionRoute !== undefined ? { executionRoute: args.audit.executionRoute } : {}),
      trustOrigin: provenanceTrustOrigin(args.provenance, "allow", auditTrustOrigin(args.permissionContext)),
    };
    try {
      await appendToolInvocationAudit(this.auditLogger, entry);
    } catch (err) {
      if (this.requirePermissionAuditChain) {
        throw err;
      }
      log.warn(
        "permission grant audit append failed for %s (%s): %s",
        args.toolName,
        args.grantLifetime ?? args.policyRule,
        errorMessage(err),
      );
    }
  }

  async auditPermissionAsk(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    input: Record<string, unknown>,
    permission: PermissionCheckResult,
    cwd: string,
    permissionContext?: ToolPermissionContext,
    auditDirectory?: string,
    audit?: ToolExecutionAuditMetadata,
  ): Promise<void> {
    // Governed-operation audit is metadata-only; never serialize presence, identity, reservation payloads, bearer, or account hash.
    const auditSafeInput = auditSafeToolInput(input, audit);
    const tool = this.toolRegistry.findByName(toolName);
    const entry = permissionAuditAskEntryFromToolCall({
      toolName,
      tool,
      source,
      category,
      input: auditSafeInput,
      permission,
      trustOrigin: auditTrustOrigin(permissionContext),
      cwd,
      auditDirectory,
      audit,
    });
    if (!this.auditLogger.isPermissionAuditChainReady()) {
      if (this.requirePermissionAuditChain) {
        const error = new Error("permission audit chain is not initialized");
        recordToolInvocationAuditFailure(error);
        throw error;
      }
      return;
    }
    try {
      await appendToolInvocationAudit(this.auditLogger, entry);
    } catch (err) {
      if (this.requirePermissionAuditChain) {
        throw err;
      }
      log.warn(
        "permission ask audit append failed for %s: %s",
        toolName,
        errorMessage(err),
      );
    }
  }

  async auditToolCall(
    sessionId: string | undefined,
    toolName: string,
    source: ToolSource,
    trust: TrustLevel,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
    startTime: number,
    permission: PermissionCheckResult,
    rateLimitRemaining: number,
    permissionContext?: ToolPermissionContext,
    category?: ToolCategory,
    cwd?: string,
    auditDirectory?: string,
    terminationReason?: ToolAuditTerminationReason,
    hookChain?: HookResult[],
    audit?: ToolExecutionAuditMetadata,
    suppressPermissionDeniedLifecycle = false,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const governedTool = audit?.governedOperation !== undefined;
    const auditSafeInput = auditSafeToolInput(input, audit);
    const auditSafeOutput = governedTool
      ? (isError ? "governed operation failed" : "governed operation completed")
      : output;
    try {
      const inputText = JSON.stringify(auditSafeInput);
      // The privacy toggle governs audit PII masking; credentials are always scrubbed.
      const auditInput = maskSensitiveData(inputText, {
        pii: isPiiRedactionEnabled(),
      }).masked;
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: auditInput.slice(0, 500),
        output: auditSafeOutput.slice(0, 1024),
        toolCalls: [{
          name: toolName,
          isError,
          source,
          trust,
          executionTimeMs: Date.now() - startTime,
          ...(audit?.toolUseId !== undefined ? { toolUseId: audit.toolUseId } : {}),
          ...(audit?.executionPlan !== undefined ? { executionPlan: audit.executionPlan } : {}),
          permissionDecision: permission?.decision ?? "allow",
          permissionReason: permission?.reason,
          rateLimitRemaining,
          ...(terminationReason ? { terminationReason } : {}),
        }],
      });
    } catch (err) {
      log.warn(
        "general tool audit failed for %s: %s",
        toolName,
        errorMessage(err),
      );
    }
    // Every terminal row is written; what the host could not resolve is recorded as unknown.
    const tool = this.toolRegistry.findByName(toolName);
    const entry = permissionAuditEntryFromToolCall({
      toolName,
      tool,
      source,
      category: category ?? "unknown",
      input: auditSafeInput,
      permission,
      rateLimitRemaining,
      trustOrigin: auditTrustOrigin(permissionContext),
      cwd,
      auditDirectory,
      ...(hookChain ? { hookChain } : {}),
      audit,
    });
    // The row is enqueued before the first await; PermissionDenied runs after it and cannot lose it.
    let appended: Promise<unknown> | undefined;
    if (this.auditLogger.isPermissionAuditChainReady()) {
      appended = appendToolInvocationAudit(this.auditLogger, entry);
      appended.catch(() => {});
    } else if (this.requirePermissionAuditChain) {
      const error = new Error("permission audit chain is not initialized");
      recordToolInvocationAuditFailure(error);
      throw error;
    }
    // Emit ordinary denials once; exclude cancellations and governed operations whose lease/proof cannot include effect-capable hooks.
    // Preserve the finalized denial reason for forensic discrimination.
    if (
      permission?.decision === "deny" &&
      permissionContext !== undefined &&
      terminationReason !== "user-abort" &&
      terminationReason !== "host-shutdown" &&
      !governedTool &&
      !suppressPermissionDeniedLifecycle
    ) {
      await this.fireLifecycleEvent(
        "PermissionDenied",
        sessionId,
        permissionContext,
        {
          toolName,
          denyReason: { source: "tool-executor", reason: permission.reason },
        },
        abortSignal,
      );
    }
    if (appended === undefined) return;
    try {
      await appended;
    } catch (err) {
      if (this.requirePermissionAuditChain) {
        throw err;
      }
      log.warn(
        "permission audit append failed for %s: %s",
        toolName,
        errorMessage(err),
      );
    }
  }
}
