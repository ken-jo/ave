// Pure permission-audit and hook-chain builders; AuditWriter owns persistence.
import { randomUUID } from "node:crypto";
import type { Tool } from "../base.js";
import type { ToolSource, ToolCategory } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { PermissionAuditEntryInput, HookResult, ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import type { HookTrustOrigin, ScriptHookInvocationResult, ScriptHookType } from "../../hooks/script-hook-types.js";
import type { HookDispatchResult } from "../../hooks/script-hook-manager.js";
import type { ToolPermissionContext } from "../executor.js";
import { resolveToolPathForPermission } from "../../shared/tool-path-resolution.js";

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
  cwd: string,
  canonicalTargetFilePath?: string,
): string | undefined {
  if (tool) {
    if (canonicalTargetFilePath) return canonicalTargetFilePath;
    if (tool.category === "shell" && typeof input.cwd === "string" && input.cwd.length > 0) {
      return resolveToolPathForPermission(input.cwd, cwd);
    }
  }
  return undefined;
}

function permissionAuditBase(args: {
  toolName: string;
  tool?: Tool;
  source: ToolSource;
  category: ToolCategory;
  trustOrigin: HookTrustOrigin;
  audit?: ToolExecutionAuditMetadata;
}): Pick<
  Extract<PermissionAuditEntryInput, { decision: "allow" }>,
  "ts" | "auditId" | "toolUseId" | "executionPlan" | "executionRoute" | "workloadBrokerCorrelation" | "trustOrigin" | "tool" | "source" | "category"
> {
  return {
    ts: new Date().toISOString(),
    auditId: randomUUID(),
    ...(args.audit?.toolUseId !== undefined ? { toolUseId: args.audit.toolUseId } : {}),
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

// Only operational hook failures carry failureReason; a successful policy deny does not.
function hookFailureReason(
  r: ScriptHookInvocationResult,
): HookResult["failureReason"] | undefined {
  if (r.timedOut) return "timeout";
  if (r.decision !== "deny") return undefined;
  if (r.reason.startsWith("hook spawn error:")) return "spawn-error";
  if (r.reason.startsWith("failed to serialise hook payload:")) return "spawn-error";
  if (r.reason.startsWith("shell unavailable:")) return "spawn-error";
  if (r.reason.startsWith("hook exited non-zero:")) return "nonzero-exit";
  if (r.reason === "hook stdout not valid {action,reason} JSON") return "bad-output";
  return undefined;
}

// Emit one forensic row per script, preserving source, command identity, and fail-closed cause; omit absent chains.
export function hookChainFromDispatch(
  event: ScriptHookType,
  dispatch: HookDispatchResult | undefined,
): HookResult[] | undefined {
  if (!dispatch || dispatch.results.length === 0) return undefined;
  return dispatch.results.map((r): HookResult => {
    const failureReason = hookFailureReason(r);
    return {
      hookName: r.hookPath,
      // Project tool-use event from pre/post/perm input; runtime hookType also includes lifecycle events.
      hookType: event,
      action: r.decision,
      reason: r.reason,
      durationMs: r.durationMs,
      // Populate event explicitly for readers of the closed audit surface.
      event,
      handlerType: "command",
      commandIdentity: r.commandIdentity,
      source: r.source,
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
  category: ToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult | undefined;
  rateLimitRemaining: number;
  trustOrigin: HookTrustOrigin;
  cwd: string;
  auditDirectory?: string;
  hookChain?: HookResult[];
  audit?: ToolExecutionAuditMetadata;
}): PermissionAuditEntryInput {
  const base = permissionAuditBase(args);
  if (args.permission?.decision === "deny") {
    const denyReasons = args.permission.denyReasons?.length
      ? args.permission.denyReasons
      : [{
        reason: args.permission.reason,
        source: "tool-executor",
      }];
    return {
      ...base,
      decision: "deny",
      denyReasons,
      ...(args.hookChain ? { hookChain: args.hookChain } : {}),
    };
  }
  const auditDirectory = auditDirectoryForInput(args.tool, args.input, args.cwd, args.auditDirectory);
  const allowEntry: Extract<PermissionAuditEntryInput, { decision: "allow" }> = {
    ...base,
    decision: "allow",
    };
  if (args.permission?.reviewer?.verdict) {
    allowEntry.reviewer = args.permission.reviewer.verdict;
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
