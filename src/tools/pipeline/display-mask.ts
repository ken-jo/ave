import { isPiiRedactionEnabled, maskSensitiveData } from "../../audit/dlp-filter.js";
import {
  getHostShellExecutionPlanCacheIdentity,
  type HostShellExecutionPlanAuditProjection,
} from "../../permissions/host-shell-execution-plan.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import type { ApprovalMemory } from "../../shared/permissions-events.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { Tool } from "../base.js";
import type {
  ToolCallMeta,
  ToolExecutorCallbacks,
} from "../executor.js";

// Resolve privacy masking once per input so a mid-walk setting change cannot produce mixed display state.
function maskDisplayValue(value: unknown, pii: boolean): unknown {
  if (typeof value === "string") {
    return maskSensitiveData(value, { pii }).masked;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskDisplayValue(item, pii));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskDisplayValue(item, pii)]),
    );
  }
  return value;
}

export function maskToolInputForDisplay(input: Record<string, unknown>): Record<string, unknown> {
  return maskDisplayValue(input, isPiiRedactionEnabled()) as Record<string, unknown>;
}

export function summarizeInputForDeferred(input: Record<string, unknown>): string {
  try {
    return maskSensitiveData(JSON.stringify(input), {
      pii: isPiiRedactionEnabled(),
    }).masked.slice(0, 1000);
  } catch {
    return "[unserializable input]";
  }
}

export interface InvocationApprovalIdentity {
  readonly approvalCacheKey: string | undefined;
  readonly approvalMemory: ApprovalMemory;
}

export const ARGS_APPROVAL_MEMORY: ApprovalMemory = Object.freeze({ kind: "args" });

// Only approvalMemoryScope enables target-wide memory; bind it to the sealed shell plan to prevent cross-substrate reuse.
async function approvalMemoryFor(
  tool: Tool,
  input: Record<string, unknown>,
  cwd: string,
  hostShellExecutionPlan?: HostShellExecutionPlanAuditProjection,
  sessionId?: string,
): Promise<ApprovalMemory> {
  const scope = await tool.approvalMemoryScope?.(input, sessionId === undefined ? { cwd } : { cwd, sessionId });
  if (scope === undefined) return ARGS_APPROVAL_MEMORY;
  const executionPlan = hostShellExecutionPlan === undefined
    ? null
    : getHostShellExecutionPlanCacheIdentity(hostShellExecutionPlan);
  // Cached origin policy must use the live tab/document, never select a stale target.
  // Terminal decisions bind command, terminal, and directory because each terminal has its own fixed sandbox.
  const memoryScope = scope.kind === "browser-origin"
    ? { kind: scope.kind, origin: scope.origin, tabOpener: scope.tabOpener }
    : scope.kind === "browser-agent-tabs" ? { kind: scope.kind }
      : scope.kind === "terminal-command" ? {
        kind: scope.kind,
        commandSha256: scope.commandSha256,
        tabId: scope.tabId,
        lane: scope.lane,
        terminalSessionId: scope.terminalSessionId,
        sandboxGeneration: scope.sandboxGeneration,
        cwd: scope.cwd,
      }
        : scope;
  return Object.freeze({
    kind: "key",
    key: `${tool.source === "builtin" && scope.kind === "path" && executionPlan === null
      && ["write_file", "edit_file", "multi_edit", "apply_patch"].includes(tool.name)
      ? "file-write-path" : tool.name}:${canonicalStringify({ scope: memoryScope, executionPlan })}`,
    scope: Object.freeze({ ...scope }),
  });
}

export async function approvalIdentityFor(
  tool: Tool,
  input: Record<string, unknown>,
  cwd: string,
  hostShellExecutionPlan?: HostShellExecutionPlanAuditProjection,
  sessionId?: string,
): Promise<InvocationApprovalIdentity> {
  return {
    approvalCacheKey: approvalCacheKeyFor(tool, input, cwd, hostShellExecutionPlan),
    approvalMemory: await approvalMemoryFor(tool, input, cwd, hostShellExecutionPlan, sessionId),
  };
}

export function approvalCacheKeyFor(
  tool: Tool,
  input: Record<string, unknown>,
  cwd: string,
  hostShellExecutionPlan?: HostShellExecutionPlanAuditProjection,
): string | undefined {
  const rawKey = tool.approvalCacheKey?.(input, { cwd });
  const key = rawKey?.trim();
  if (rawKey !== undefined && !key) {
    throw new Error(`approvalCacheKey for ${tool.name} returned an empty key`);
  }
  const base = key === undefined ? undefined : `${tool.name}:${key}`;
  if (hostShellExecutionPlan === undefined) return base;

  const planIdentity = getHostShellExecutionPlanCacheIdentity(
    hostShellExecutionPlan,
  );
  // Partition canonical shell approvals by sealed execution plan even without a tool-specific cache key.
  return base === undefined
    ? `${tool.name}:${planIdentity}`
    : `${base}:${planIdentity}`;
}

export function emitToolStart(
  callbacks: ToolExecutorCallbacks | undefined,
  name: string,
  input: Record<string, unknown>,
  meta: ToolCallMeta,
): void {
  callbacks?.onToolStart?.(name, maskToolInputForDisplay(input), meta);
}

export function emitPermissionReview(
  callbacks: ToolExecutorCallbacks | undefined,
  event: PermissionReviewEvent,
): void {
  callbacks?.onPermissionReview?.(event);
}
