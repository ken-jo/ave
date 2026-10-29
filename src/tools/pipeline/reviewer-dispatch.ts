import type { PermissionManager, PermissionCheckResult, ReviewerDispatchInput } from "../../permissions/permission-manager.js";
import type { ToolSource, ToolCategory } from "../types.js";
import type { PermissionEvaluationContext } from "../../permissions/evaluation-context.js";
import type { HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import type { ApprovalPurposeSuggestion } from "../../shared/permission-review-status.js";
import type { ToolPermissionContext, ToolCallMeta, ToolExecutorCallbacks } from "../executor.js";
import { emitPermissionReview } from "./display-mask.js";
import { JudgeContractError } from "../../permissions/judge/judge-contract.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";

export function reviewerInvocationId(meta: Pick<ToolCallMeta, "groupId" | "toolUseId">): string {
  if (!meta.groupId?.trim() || !meta.toolUseId?.trim()) throw new JudgeContractError("Automated review requires a tool invocation identity");
  return JSON.stringify([meta.groupId, meta.toolUseId]);
}

type ReviewArguments = [
  permissionManager: PermissionManager | undefined, toolName: string, source: ToolSource, category: ToolCategory,
  pathFields: readonly string[], finalInput: Record<string, unknown>, allowedDirectories: string[],
  sensitivePathsAdjacent: string[], context: ToolPermissionContext, evaluationContext: PermissionEvaluationContext,
  sandboxAttestation: { ownerPluginSandboxRoot?: string }, callbacks: ToolExecutorCallbacks | undefined,
  meta: ToolCallMeta, approvalPurpose: ApprovalPurposeSuggestion | undefined,
  hostShellExecutionPlan?: HostShellExecutionPlan, abortSignal?: AbortSignal,
  auditInput?: Record<string, unknown>, sessionId?: string,
  permissionDecision?: ReviewerDispatchInput["permissionDecision"],
];

async function dispatchReview(args: ReviewArguments, headless: boolean): Promise<PermissionCheckResult> {
  const [manager, toolName, source, category, pathFields, finalInput, allowedDirectories, sensitivePathsAdjacent,
    context, evaluationContext, sandboxAttestation, callbacks, meta, approvalPurpose, hostShellExecutionPlan,
    abortSignal, auditInput, sessionId, permissionDecision] = args;
  if (!manager) throw new JudgeContractError("Permission review requires the permission manager");
  const initial = permissionDecision as PermissionCheckResult | undefined ?? manager.checkDetailed(toolName, source, category, undefined, {
    ...context, sessionId, projectRulesCwd: evaluationContext.executionCwd,
  });
  if (!initial.reviewer) return initial;
  emitPermissionReview(callbacks, { status: "reviewing", toolName, toolCategory: category, source, ...meta,
    ...(approvalPurpose ? { approvalPurpose } : {}) });
  const review = await manager.dispatchReviewer(toolName, {
    invocationId: reviewerInvocationId(meta), sessionId, source, category, pathFields, finalInput,
    executionCwd: evaluationContext.executionCwd, auditInput, allowedDirectories, sensitivePathsAdjacent,
    trustOrigin: context.trustOrigin, evaluationContext, permissionDecision: initial,
    ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
    ...(context.approvalCacheKey ? { approvalCacheKey: context.approvalCacheKey } : {}),
    ...(context.approvalMemory ? { approvalMemory: context.approvalMemory } : {}),
    ...sandboxAttestation,
    ...(meta.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
    ...(meta.pluginId ? { pluginId: meta.pluginId } : {}),
    ...(meta.workerId ? { workerId: meta.workerId } : {}),
    ...(hostShellExecutionPlan ? { hostShellExecutionPlan } : {}),
    ...(context.disposableSubstrate ? { disposableSubstrate: context.disposableSubstrate } : {}),
  }, { allowedPluginIds: context.allowedPluginIds ? [...context.allowedPluginIds] : undefined,
    additionalDirectories: context.additionalDirectories ?? [] }, { lane: headless ? "headless" : "foreground-auto", abortSignal });
  if (abortSignal?.aborted) {
    emitPermissionReview(callbacks, { status: "failed", toolName, toolCategory: category, source, ...meta,
      reason: "Permission review cancelled.", ...(approvalPurpose ? { approvalPurpose } : {}) });
    abortSignal.throwIfAborted();
  }
  const decision = manager.resolveReviewedPermission(initial, review);
  emitPermissionReview(callbacks, { status: decision.decision === "allow" ? "auto_approved" : "needs_approval",
    toolName, toolCategory: category, source, ...meta, verdictLevel: review.verdict.level, reason: decision.reason,
    ...(approvalPurpose ? { approvalPurpose } : {}) });
  return decision;
}

export async function dispatchReviewerForHeadless(...args: ReviewArguments): Promise<
  { allowed: true; permissionResult: PermissionCheckResult } | { allowed: false; message: string; permissionResult: PermissionCheckResult }
> {
  const permissionResult = await dispatchReview(args, true);
  return permissionResult.decision === "allow" ? { allowed: true, permissionResult }
    : { allowed: false, message: permissionResult.reason || NO_APPROVER_MESSAGE, permissionResult };
}

export async function dispatchReviewerForInteractiveAuto(...args: ReviewArguments): Promise<PermissionCheckResult | null> {
  return dispatchReview(args, false);
}
