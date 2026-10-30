// Keep complementary containment relaxation and read-approval blocks together in invocation-authorization.
// A denied write must never become allowed; read relaxation must retain exactly the same conditions.
import {
  buildAllowedScope,
  buildRuntimeAllowedDirectories,
} from "../../permissions/allowed-directories.js";
import {
  createEffectLedger,
  currentEffectLedger,
  type EffectLedger,
} from "../../permissions/effect-ledger.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import { t } from "../../i18n/index.js";
import type { ToolSource, TrustLevel, ToolCategory } from "../types.js";
import type {
  ToolCallMeta,
  ToolExecutorCallbacks,
  ToolPermissionContext,
  ToolResult,
  ToolUseBlock,
} from "../executor.js";
import type { AuditWriter } from "./audit-writer.js";
import { emitToolStart } from "./display-mask.js";

// Record per-invocation state while stage-local permission, category, and scope mutations remain coordinated at authorization boundaries.
interface InvocationContext {
  // Permission changes across reviewer, memory, approval, and coordinated containment relaxation.
  permissionResult: PermissionCheckResult | undefined;
  source: ToolSource;
  trust: TrustLevel;
  // Category may be host-reclassified before containment relaxation reads it.
  invocationCategory: ToolCategory;
  /** Layer-1 allowed scope; widened in place by applyApprovedDirectory. */
  allowedScope: { directories: string[] };
  // Runtime directories widen together with allowedScope after an approved grant.
  runtimeAllowedDirectories: string[];
  // Observability-only invocation ledger bound around execution.
  effectLedger: EffectLedger;
  /** Ambient parent ledger, captured BEFORE opening this invocation's own. */
  parentEffectLedger: EffectLedger | undefined;
  // Fresh additional-directory snapshot used as the merge base for grants.
  baseAdditionalDirectories: readonly string[];
}

export type InitialInvocationState = Pick<
  InvocationContext,
  | "baseAdditionalDirectories"
  | "allowedScope"
  | "runtimeAllowedDirectories"
  | "parentEffectLedger"
  | "effectLedger"
>;

export function createInvocationContext(
  permissionContext: ToolPermissionContext,
  executionCwd: string,
): InitialInvocationState {
  // Refresh additional directories per invocation so earlier grants in an ordered batch are visible.
  const baseAdditionalDirectories: readonly string[] =
    permissionContext.getAdditionalDirectories?.()
    ?? permissionContext.additionalDirectories
    ?? [];
  const allowedScope = buildAllowedScope(baseAdditionalDirectories, executionCwd);
  const runtimeAllowedDirectories = buildRuntimeAllowedDirectories(
    baseAdditionalDirectories,
    executionCwd,
  );
  // Capture the parent ledger first so delegated mutations propagate to wrappers and cannot appear read-only.
  const parentEffectLedger = currentEffectLedger();
  // Create a fresh observability ledger before classification so category and effect audit share correlationId.
  const effectLedger = createEffectLedger();
  return {
    baseAdditionalDirectories,
    allowedScope,
    runtimeAllowedDirectories,
    parentEffectLedger,
    effectLedger,
  };
}

export interface UserAbortDeps {
  // Attribute cancellation to post-hook finalInput when available.
  input: Record<string, unknown>;
  toolUse: ToolUseBlock;
  meta: ToolCallMeta;
  callbacks: ToolExecutorCallbacks | undefined;
  source: ToolSource;
  trust: TrustLevel;
  invocationCategory: ToolCategory;
  sessionId: string | undefined;
  permissionContext: ToolPermissionContext | undefined;
  executionCwd: string;
  startTime: number;
  auditWriter: AuditWriter;
  audit?: ToolExecutionAuditMetadata;
}

// Emit cancellation result and fixed denial audit without participating in containment relaxation.
export async function returnUserAbort(deps: UserAbortDeps): Promise<ToolResult> {
  const {
    input,
    toolUse,
    meta,
    callbacks,
    source,
    trust,
    invocationCategory,
    sessionId,
    permissionContext,
    executionCwd,
    startTime,
    auditWriter,
    audit,
  } = deps;
  const msg = t("be_executor.toolExecutionCancelled");
  const durationMs = Date.now() - startTime;
  const abortedPermission: PermissionCheckResult = {
    decision: "deny",
    reason: "user aborted turn",
    };
  emitToolStart(callbacks, toolUse.name, input, meta);
  callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
  await auditWriter.auditToolCall(
    sessionId,
    toolUse.name,
    source,
    trust,
    input,
    msg,
    true,
    startTime,
    abortedPermission,
    Infinity,
    permissionContext,
    invocationCategory,
    executionCwd,
    undefined,
    "user-abort",
    undefined,
    audit,
  );
  return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
}
