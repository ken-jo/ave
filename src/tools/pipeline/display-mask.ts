/**
 * Tool pipeline — display/DLP masking + callback emission + approval-cache key.
 *
 * Pure helpers factored out of `executor.ts` (C7 decomposition). These mask the
 * tool input shown to the renderer/audit, derive the per-invocation approval
 * cache key, and fan tool-start / permission-review events out to the executor
 * callbacks. No executor state is touched.
 */
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

// The tool input the renderer shows, and the deferred-approval summary, are
// display surfaces governed by `privacy.piiRedactEnabled`. Resolve the setting
// once per input rather than per string so one displayed object cannot be half
// masked if the user flips the toggle mid-walk.
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

/**
 * The policy key of one invocation and what a remembered decision for it is
 * keyed on (see {@link ApprovalMemory}).
 */
export interface InvocationApprovalIdentity {
  readonly approvalCacheKey: string | undefined;
  readonly approvalMemory: ApprovalMemory;
}

export const ARGS_APPROVAL_MEMORY: ApprovalMemory = Object.freeze({ kind: "args" });

/**
 * Target-wide memory exists only when the tool opts in with
 * `approvalMemoryScope`; `approvalCacheKey` alone never widens it. The key
 * hashes the scope together with the sealed host-shell plan, so a decision
 * made under one execution substrate never answers for another.
 */
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
  // Remember the origin policy while handing execute this invocation's live
  // tab and document identity. Cached metadata must never select an old tab.
  // A terminal command is remembered by command, terminal and directory: each
  // terminal's shell has its own sandbox jail, fixed when it was spawned, so a
  // decision made for one terminal does not carry to another (cwdForMatch is
  // derived from cwd and left out).
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
    key: `${tool.name}:${canonicalStringify({ scope: memoryScope, executionPlan })}`,
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
  // A canonical host shell still needs a plan partition when it does not
  // declare a tool-specific key: lookupApproval also receives canonical args,
  // so this only adds the sealed execution substrate to that identity.
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
