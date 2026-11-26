// Pure permission-audit and hook-chain builders; AuditWriter owns persistence.
import { randomUUID } from "node:crypto";
import type { Tool } from "../base.js";
import type { ToolSource, ToolCategory } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import { answeredRecordForAction, HOST_PROVENANCE, provenanceTrustOrigin } from "../../permissions/approval-gate.js";
import type { AuditToolCategory, PermissionAuditEntryInput, HookResult, ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import { hookInvocationFailureReason, type HookTrustOrigin, type ScriptHookType } from "../../hooks/script-hook-types.js";
import type { HookDispatchResult } from "../../hooks/script-hook-manager.js";
import type { ToolPermissionContext } from "../executor.js";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";
import { redactFsPath } from "../../audit/dlp-filter.js";

// Redact nonempty answers[].freeText before audit while retaining choices and dismissal.
// Non-JSON error responses pass through unchanged.
export function redactAskUserAuditOutput(rawOutput: string): string {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    const answers = Array.isArray(parsed.answers) ? (parsed.answers as unknown[]) : null;
    if (!answers) return rawOutput;
    let touched = false;
    const redacted = answers.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const a = entry as Record<string, unknown>;
      if (typeof a.freeText === "string" && a.freeText.length > 0) {
        touched = true;
        return { ...a, freeText: `[redacted ${a.freeText.length} chars]` };
      }
      return a;
    });
    if (!touched) return rawOutput;
    return JSON.stringify({ ...parsed, answers: redacted });
  } catch {
    return rawOutput;
  }
}

export function auditTrustOrigin(context?: ToolPermissionContext): HookTrustOrigin {
  return context?.trustOrigin ?? "unknown";
}

function auditDirectoryForInput(
  tool: Tool | undefined,
  input: Record<string, unknown>,
  cwd: string | undefined,
  canonicalTargetFilePath?: string,
): string | undefined {
  if (tool) {
    if (canonicalTargetFilePath) return canonicalTargetFilePath;
    if (cwd !== undefined && tool.category === "shell" && typeof input.cwd === "string" && input.cwd.length > 0) {
      return resolveToolPathForPermission(input.cwd, cwd);
    }
  }
  return undefined;
}

function permissionAuditBase(args: {
  toolName: string;
  tool?: Tool;
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
  tool?: Tool;
  source: ToolSource;
  category: AuditToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult;
  rateLimitRemaining: number;
  trustOrigin: HookTrustOrigin;
  cwd: string | undefined;
  auditDirectory?: string;
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
      cwd: args.cwd === undefined ? "unknown" : redactFsPath(args.cwd),
      ...(permission.answer ? { answerTrustOrigin: provenanceTrustOrigin(permission.answer, "allow", args.trustOrigin) } : {}),
      ...(args.hookChain ? { hookChain: args.hookChain } : {}),
    };
  }
  const auditDirectory = auditDirectoryForInput(args.tool, args.input, args.cwd, args.auditDirectory);
  const allowEntry: Extract<PermissionAuditEntryInput, { decision: "allow" }> = {
    ...base,
    decision: "allow",
    };
  if (permission.reviewer?.verdict) {
    allowEntry.reviewer = permission.reviewer.verdict;
  }
  if (auditDirectory) {
    allowEntry.directory = auditDirectory;
    allowEntry.directoryAllowed = true;
  }
  if (Number.isFinite(args.rateLimitRemaining)) {
    allowEntry.rateLimitRemaining = args.rateLimitRemaining;
  }
  if (args.hookChain) {
    allowEntry.hookChain = args.hookChain;
  }
  return allowEntry;
}

export function permissionAuditAskEntryFromToolCall(args: {
  toolName: string;
  tool?: Tool;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult;
  trustOrigin: HookTrustOrigin;
  cwd: string;
  auditDirectory?: string;
  audit?: ToolExecutionAuditMetadata;
}): PermissionAuditEntryInput {
  const auditDirectory = auditDirectoryForInput(args.tool, args.input, args.cwd, args.auditDirectory);
  const askEntry: Extract<PermissionAuditEntryInput, { decision: "ask" }> = {
    ...permissionAuditBase(args),
    decision: "ask",
    reason: args.permission.reason,
  };
  if (auditDirectory) {
    askEntry.directory = auditDirectory;
  }
  return askEntry;
}
