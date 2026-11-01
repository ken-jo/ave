import { dispatchReviewerForInteractiveAuto } from "./pipeline/reviewer-dispatch.js";
import { userOwnedSurfaceCardFacts, resolveUserOwnedSurfaceApproval } from "./pipeline/user-owned-surface.js";
import { NO_APPROVER_MESSAGE } from "../permissions/decision-pipeline.js";
import { checkReplayRootBinding, type ReplayRootBinding } from "../permissions/reviewer/replay-root-binding.js";
import { attachSandboxBlock, sandboxBlockForResult, type SandboxBlock } from "../shared/sandbox-block.js";
import { isHostApprovalRejectedDecision } from "../permissions/approval-gate.js";
import type { PermissionEvaluationContext } from "../permissions/evaluation-context.js";
import type { ApprovalPurposeSuggestion } from "../shared/permission-review-status.js";
import { classifyApprovalRuleVerdict } from "./pipeline/approval-memory-skip.js";
import { approvalFailureOutcome } from "./pipeline/approval-outcome.js";
import { hostTerminalApprovalFacts } from "./pipeline/host-terminal-approval.js";
import { disposableContainerCapability, resolveReviewerSandboxCapability } from "../permissions/sandbox-capability.js";
import type { ToolOutputArtifactInfo, ToolOutputCapture } from "../shared/tool-output-artifact.js";
import type { ApprovalDecision, ApprovalRequestInput } from "../permissions/approval-gate.js";
import { randomUUID } from "node:crypto";
import type { PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ToolExecutionAuditMetadata } from "../audit/audit-schema.js";
import { isPiiRedactionEnabled, maskSensitiveData } from "../audit/dlp-filter.js";
import { emitEffectShadowLog } from "../permissions/reviewer/risk-shadow-log.js";
import { runWithEffectLedger, type EffectLedger } from "../permissions/effect-ledger.js";
import { runWithToolExecutionCwd } from "./execution-context.js";
import { runWithAgentObservationInvocation } from "./agent-observation-context.js";
import { preparedShellCommand } from "./prepared-shell-invocation.js";
import { isCanonicalWebFetchTool } from "./web-fetch.js";
import { runWithEffectGateContext } from "../permissions/effect-enforcement.js";
import { CHOKEPOINT_EFFECT } from "../permissions/effect-kind.js";
import type { HostShellExecutionPermitBinding } from "../permissions/host-shell-execution-permit.js";
import { mintHostShellExecutionPermit } from "../permissions/host-shell-execution-permit.js";
import { resolveEffectiveCeilingMs, runWithCeiling, type ToolCeilingOutcome } from "./executor-ceiling.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { isRemoteControllerBoundToSession } from "../shared/chat-origin.js";
import {
  A2A_CAUSAL_CONTEXT_METADATA_KEY,
  isA2AAgentCausalContext,
  type A2AAgentCausalContext,
} from "../engine/a2a-agent-message-envelope.js";
import { TOOL_RESULT_READ_MAX_CHARS } from "../shared/bounded-tool-output.js";
import { TOOL_RESULT_CHUNK_READER_METADATA_KEY } from "./tool-result-chunk.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { resolveOwnerPluginSandboxRoot } from "../plugins/plugin-storage-layout.js";
import type { Tool } from "./base.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { HostShellExecutionPlan, HostShellExecutionPlanAuditProjection } from "../permissions/host-shell-execution-plan.js";
import type { ExecutionGrant } from "../permissions/execution-router.js";
import type {
  ToolCategory,
  ToolExecutionContext,
  ToolResultImage,
  ToolSource,
  TrustLevel,
} from "./types.js";
import {
  hookChainFromDispatch,
  mergeHookChains,
  redactAskUserAuditOutput,
} from "./pipeline/audit-entries.js";
import { emitPermissionReview, emitToolStart } from "./pipeline/display-mask.js";
import { returnUserAbort } from "./pipeline/invocation-context.js";
import {
  finishRationaleResume,
  startRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import {
  runScriptHook,
  type InvocationRunnerServices,
} from "./invocation-services.js";
import {
  auditSafeToolInput,
  type AuditWriter,
} from "./pipeline/audit-writer.js";
import {
  RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
  type ExecuteOptions,
  type HostPluginAuthLifecycle,
  type ToolCallMeta,
  type ToolExecutorCallbacks,
  type ToolPermissionContext,
  type ToolResult,
  type ToolUseBlock,
} from "./executor-contract.js";
import type { RationaleResumeExecutionContext } from "./invocation-runner.js";
import type { ResolvedPluginOperation } from "./plugin-operation-governance.js";
import {
  PluginOperationExecutionLeaseAbortedError,
  pluginOperationExecutionDomain,
  type PluginOperationPrincipal,
} from "../permissions/plugin-operation-grant.js";
import { errorMessage } from "../shared/error-message.js";
import { createMaskedProgressRelay, TOOL_OUTPUT_PROGRESS_METADATA_KEY } from "./tool-output-progress.js";
import { APPROVAL_MEMORY_SCOPE_METADATA_KEY } from "./approval-memory-context.js";
import {
  authorizationRequiredStateOf,
  issueAuthorizationRequiredControl,
  type AuthorizationRequiredControl,
} from "../shared/authorization-required.js";

const log = createLogger("executor");

class HandlerPermissionAskError extends Error {
  constructor() {
    super("Handler admission requires approval");
    this.name = "HandlerPermissionAskError";
  }
}

class HandlerApprovalRequiredError extends Error {
  constructor(readonly request: ApprovalRequestInput & { sessionId: string }) {
    super("Handler admission requires human approval");
    this.name = "HandlerApprovalRequiredError";
  }
}

type AuditToolCall = (...args: Parameters<AuditWriter["auditToolCall"]>) => Promise<void>;

function boundInterruptionDetail(detail: string): string {
  if (detail.length <= TOOL_RESULT_READ_MAX_CHARS) return detail;
  const suffix = "\n[Settled detail truncated]";
  return detail.slice(0, TOOL_RESULT_READ_MAX_CHARS - suffix.length) + suffix;
}

interface SettledToolDetail {
  raw: string;
  start: number;
  boundedLength: number;
}

function maskExecutionOutput(content: string, detail: SettledToolDetail | undefined, pii: boolean) {
  if (!detail) return maskSensitiveData(content, { pii });
  // Mask the complete diagnostic before truncation can remove a credential's
  // closing delimiter. The machine channel retains its bounded raw text.
  const prefix = maskSensitiveData(content.slice(0, detail.start), { pii });
  const settled = maskSensitiveData(detail.raw, { pii });
  const suffix = maskSensitiveData(content.slice(detail.start + detail.boundedLength), { pii });
  return {
    masked: prefix.masked + boundInterruptionDetail(settled.masked) + suffix.masked,
    detections: [...new Set([...prefix.detections, ...settled.detections, ...suffix.detections])],
  };
}

function satisfiesDeclaredReadResultStatus(
  value: unknown,
  successfulStatuses: readonly string[] | undefined,
): boolean {
  if (successfulStatuses === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" && successfulStatuses.includes(status);
}

export interface ExecutionStageContext {
  services: InvocationRunnerServices;
  tool: Tool;
  toolUse: ToolUseBlock;
  source: ToolSource;
  trust: TrustLevel;
  invocationCategory: ToolCategory;
  declaredCategoryForEffectShadow: ToolCategory;
  /** Layer 1 read fence for this invocation; see ToolExecutionContext. */
  blockReadsOutsideWorkingDirectories: boolean;
  finalInput: Record<string, unknown>;
  sessionId: string | undefined;
  invocationPermissionContext: ToolPermissionContext;
  rationaleResumeContext: RationaleResumeExecutionContext | undefined;
  returnRationaleResumeBlock: (
    reason: string,
    input: Record<string, unknown>,
    blockedPermission?: PermissionCheckResult,
    hookChain?: import("../audit/audit-schema.js").HookResult[],
    suppressPermissionDeniedLifecycle?: boolean,
  ) => Promise<ToolResult>;
  startTime: number;
  callbacks: ToolExecutorCallbacks | undefined;
  meta: ToolCallMeta;
  auditCurrentToolCall: AuditToolCall;
  currentAuditMetadata: (
    input?: Record<string, unknown>,
  ) => ToolExecutionAuditMetadata;
  withHostShellExecutionPlan: (result: ToolResult) => ToolResult;
  permissionResult: PermissionCheckResult | undefined;
  humanApproved: boolean;
  approvedPolicyEpoch?: string;
  permissionRecheckResult?: PermissionCheckResult;
  replayRootBinding?: ReplayRootBinding;
  abortSignal: AbortSignal | undefined;
  hostShellExecutionPermitBinding: HostShellExecutionPermitBinding | undefined;
  hostShellApprovalDecision: ApprovalDecision | undefined;
  hostShellAllowRuleDecision: PermissionCheckResult | undefined;
  hostShellExecutionPlan: HostShellExecutionPlan | undefined;
  executionRouteGrant?: ExecutionGrant;
  finalizeExecutionRouteGrant?: () => Promise<ExecutionGrant | undefined>;
  hostTerminalRoute?: { recheck(): Promise<void> };
  preparedShellInvocation?: import("./prepared-shell-invocation.js").PreparedShellInvocation;
  verifiedShellCommand?: import("../permissions/verified-shell-command.js").VerifiedShellCommand;
  hostShellRequiresExplicitApproval: boolean;
  invocationRuntimeAllowedDirectories: string[];
  supportsA2AParentDelivery: boolean | undefined;
  spawnDepth: number | undefined;
  memoryIncludeUnscoped: boolean | undefined;
  a2aCausalContext: A2AAgentCausalContext | undefined;
  toolResultChunkReader: ExecuteOptions["toolResultChunkReader"];
  toolOutputCaptureFactory?: ExecuteOptions["toolOutputCaptureFactory"];
  executionCwd: string;
  evaluationContext: PermissionEvaluationContext;
  approvalCacheKey: string | undefined;
  approvalPurpose: ApprovalPurposeSuggestion | undefined;
  targetFilePaths: string[];
  sensitivePathPattern: string | null;
  invocationAllowedScope: { directories: string[] };
  hostShellExecutionPlanAudit: HostShellExecutionPlanAuditProjection | undefined;
  approvalReasonPrefix: string | undefined;
  parentEffectLedger: EffectLedger | undefined;
  effectLedger: EffectLedger;
  targetFilePath: string | undefined;
  preResult: Awaited<ReturnType<HookRunner["runPreHooks"]>>;
  scriptPre: Awaited<ReturnType<typeof runScriptHook>>;
  resolvedPluginOperation: ResolvedPluginOperation | undefined;
  pluginOperationPrincipal: PluginOperationPrincipal | undefined;
  pluginAuthLifecycle: HostPluginAuthLifecycle | undefined;
}

export async function executeAuthorizedToolInvocation(
  context: ExecutionStageContext,
): Promise<ToolResult> {
  const {
    services,
    tool,
    toolUse,
    source,
    trust,
    invocationCategory,
    declaredCategoryForEffectShadow,
    blockReadsOutsideWorkingDirectories,
    finalInput,
    sessionId,
    invocationPermissionContext,
    rationaleResumeContext,
    returnRationaleResumeBlock,
    startTime,
    callbacks,
    meta,
    auditCurrentToolCall,
    currentAuditMetadata,
    withHostShellExecutionPlan,
    humanApproved: initialHumanApproved,
    abortSignal,
    hostShellExecutionPermitBinding,
    hostShellApprovalDecision,
    hostShellAllowRuleDecision,
    hostShellExecutionPlan,
    executionRouteGrant,
    finalizeExecutionRouteGrant,
    hostTerminalRoute,
    preparedShellInvocation,
    verifiedShellCommand,
    hostShellRequiresExplicitApproval,
    invocationRuntimeAllowedDirectories,
    supportsA2AParentDelivery,
    spawnDepth,
    memoryIncludeUnscoped,
    a2aCausalContext,
    toolResultChunkReader,
    toolOutputCaptureFactory,
    executionCwd,
    evaluationContext,
    approvalCacheKey,
    approvalPurpose,
    sensitivePathPattern,
    invocationAllowedScope,
    hostShellExecutionPlanAudit,
    approvalReasonPrefix,
    parentEffectLedger,
    effectLedger,
    targetFilePath,
    preResult,
    resolvedPluginOperation,
    pluginOperationPrincipal,
    pluginAuthLifecycle,
  } = context;
  let sandboxBlock: SandboxBlock | undefined;
  let permissionResult = context.permissionResult;
  if (typeof initialHumanApproved !== "boolean") {
    throw new Error("Handler admission is missing human approval provenance");
  }
  let humanApproved = initialHumanApproved;
  let approvedPolicyEpoch = context.approvedPolicyEpoch;
  let permissionRecheckResult = context.permissionRecheckResult;


  // ── Step 5: Rate Limit (trust별) ────────────────
  const rateResult = services.rateLimiter.check(toolUse.name, trust);
  if (!rateResult.allowed) {
    if (rationaleResumeContext) {
      return returnRationaleResumeBlock(
        "rate limit denied the sealed action",
        finalInput,
        permissionResult,
      );
    }
    const msg = t("be_executor.rateLimitExceeded", { name: toolUse.name, trust });
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
    await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, 0, invocationPermissionContext, invocationCategory, executionCwd);
    return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
  }

  if (services.requirePermissionAuditChain) {
    try {
      services.auditLogger.assertPermissionAuditWritable();
    } catch (err) {
      if (rationaleResumeContext) {
        return returnRationaleResumeBlock(
          "permission audit chain is not writable: " +
            errorMessage(err),
          finalInput,
          permissionResult,
        );
      }
      const msg = t("be_executor.auditChainBlock", { name: toolUse.name, error: errorMessage(err) });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      const audit = currentAuditMetadata(finalInput);
      services.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: maskSensitiveData(
          JSON.stringify(auditSafeToolInput(finalInput, audit)),
          { pii: isPiiRedactionEnabled() },
        ).masked.slice(0, 500),
        output: msg.slice(0, 1024),
        toolCalls: [{
          name: toolUse.name,
          isError: true,
          source,
          trust,
          executionTimeMs: durationMs,
          ...(audit.toolUseId !== undefined ? { toolUseId: audit.toolUseId } : {}),
          ...(audit.executionPlan !== undefined
            ? { executionPlan: audit.executionPlan }
            : {}),
          permissionDecision: "deny",
          permissionReason: "permission audit chain unavailable before execution",
          rateLimitRemaining: rateResult.remaining,
        }],
      });
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }
  }

  const operationExecutionDomain =
    resolvedPluginOperation && pluginOperationPrincipal
      ? pluginOperationExecutionDomain(
          pluginOperationPrincipal,
          toolUse.name,
          resolvedPluginOperation.operation,
          services.toolRegistry.listAll(),
        )
      : undefined;
  let operationExecutionLease:
    | Awaited<ReturnType<
        typeof services.pluginOperationGrants.acquireExecutionLease
      >>
    | undefined;
  try {
    operationExecutionLease =
      resolvedPluginOperation &&
      pluginOperationPrincipal &&
      operationExecutionDomain
        ? await services.pluginOperationGrants.acquireExecutionLease(
            operationExecutionDomain,
            pluginOperationPrincipal,
            abortSignal,
          )
        : undefined;
  } catch (error) {
    if (error instanceof PluginOperationExecutionLeaseAbortedError) {
      return withHostShellExecutionPlan(await returnUserAbort({
        input: finalInput,
        toolUse,
        meta,
        callbacks,
        source,
        trust,
        invocationCategory,
        sessionId,
        permissionContext: invocationPermissionContext,
        executionCwd,
        startTime,
        auditWriter: services.auditWriter,
        audit: currentAuditMetadata(),
      }));
    }
    const msg = errorMessage(error);
    if (rationaleResumeContext) {
      return returnRationaleResumeBlock(
        `governed operation admission failed: ${msg}`,
        finalInput,
        permissionResult,
        undefined,
        true,
      );
    }
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(
      toolUse.name,
      msg,
      true,
      meta,
      undefined,
      durationMs,
    );
    await auditCurrentToolCall(
      sessionId,
      toolUse.name,
      source,
      trust,
      finalInput,
      msg,
      true,
      startTime,
      { decision: "deny", reason: msg, },
      rateResult.remaining,
      invocationPermissionContext,
      invocationCategory,
      executionCwd,
      undefined,
      "error",
      undefined,
      undefined,
      true,
    );
    return withHostShellExecutionPlan({
      tool_use_id: toolUse.id,
      content: msg,
      is_error: true,
      durationMs,
    });
  }
  let content: string;
  let isError = false;
  let uiPayload: import("../mcp/types.js").McpUiPayload | undefined;
  let rawResult: unknown;
  let image: ToolResultImage | undefined;
  let authorizationRequired: AuthorizationRequiredControl | undefined;
  let effectAuthorizationRequired: AuthorizationRequiredControl | undefined;
  let effectNoApprover = false;
  let latePermissionHookChain: import("../audit/audit-schema.js").HookResult[] | undefined;
  let handlerAdmissionBlocked = true;
  let outputArtifact: ToolOutputArtifactInfo | undefined;
  let ownedOutputCapture: ToolOutputCapture | undefined;
  let outputArtifactDelivered = false;
  let terminationReason:
    | "ok"
    | "ceiling"
    | "user-abort"
    | "error"
    | "indeterminate" = "ok";
  let consumedPluginOperationGrantId: string | undefined;
  let deferredOperationSettlement: Promise<unknown> | undefined;
  let indeterminateAuditPersisted = false;
  let interruptionReason: "ceiling" | "user-abort" | undefined;
  let settledToolDetail: SettledToolDetail | undefined;
  let holdOperationLeaseForFinalBoundary = false;
  let pluginAuthLifecycleSettled = false;
  const completePluginAuthSuccess = (result: unknown): void => {
    if (!pluginAuthLifecycle || pluginAuthLifecycleSettled) return;
    pluginAuthLifecycleSettled = true;
    pluginAuthLifecycle.completeSuccess(result);
  };
  const completePluginAuthFailure = (reason: unknown): void => {
    if (!pluginAuthLifecycle || pluginAuthLifecycleSettled) return;
    pluginAuthLifecycleSettled = true;
    pluginAuthLifecycle.completeFailure(reason);
  };
  const releaseOperationLeaseAfterFinalBoundary = (): void => {
    if (!holdOperationLeaseForFinalBoundary) return;
    holdOperationLeaseForFinalBoundary = false;
    operationExecutionLease?.release();
  };
  let pendingReadReceipt:
    | {
        principal: PluginOperationPrincipal;
        readTool: string;
        readOperation: string;
        domainKey: string;
      }
    | undefined;
  let postFeedback: string | undefined;
  let scriptPost: Awaited<ReturnType<typeof runScriptHook>> = {
    decision: "allow",
    reason: "post hooks not run",
    results: [],
  };
  try {
    if (
      resolvedPluginOperation?.rule.kind === "read" &&
      pluginOperationPrincipal &&
      operationExecutionDomain
    ) {
      services.pluginOperationGrants.beginRead({
        ...pluginOperationPrincipal,
        readTool: toolUse.name,
        readOperation: resolvedPluginOperation.operation,
      }, operationExecutionDomain);
    }
    if (rationaleResumeContext) {
      if (!rationaleResumeContext.authorized) {
        return returnRationaleResumeBlock(
          "rationale resume authorization was lost before invocation start",
          finalInput,
          permissionResult,
        );
      }
      const started = await startRationaleResume(rationaleResumeContext.authorized);
      if (!started.ok) {
        return returnRationaleResumeBlock(
          started.reason,
          finalInput,
          permissionResult,
        );
      }
      rationaleResumeContext.started = started.value;
    }

    if (
      resolvedPluginOperation?.rule.kind === "write" &&
      pluginOperationPrincipal
    ) {
      const readRequirement = resolvedPluginOperation.rule.requiresRead;
      const grantContext = invocationPermissionContext.pluginOperation;
      const consumed = grantContext?.appGrantRequired === true
        ? services.pluginOperationGrants.consume(
            grantContext.grantToken,
            {
              ...pluginOperationPrincipal,
              toolName: toolUse.name,
              operation: resolvedPluginOperation.operation,
              intentHash: resolvedPluginOperation.intentHash,
              requiresRead: readRequirement !== undefined,
            },
            operationExecutionDomain!,
          )
        : readRequirement
          ? services.pluginOperationGrants.consumeRequiredRead(
              pluginOperationPrincipal,
              {
                readTool: readRequirement.tool,
                readOperations: readRequirement.operations,
                maxAgeMs: readRequirement.maxAgeMs,
              },
              operationExecutionDomain!,
            )
          : { ok: true as const };
      const consumedGrantId =
        "grantId" in consumed && typeof consumed.grantId === "string"
          ? consumed.grantId
          : undefined;
      if (consumed.ok) consumedPluginOperationGrantId = consumedGrantId;
      let grantAuditError: unknown;
      try {
        const commonGrantAudit = {
          ts: new Date().toISOString(),
          auditId: randomUUID(),
          tool: toolUse.name,
          source,
          category: invocationCategory,
          trustOrigin: invocationPermissionContext.trustOrigin,
          pluginOperation: {
            pluginId: pluginOperationPrincipal.ownerPluginId,
            operation: resolvedPluginOperation.operation,
            outcome: consumed.ok ? "consumed" : "rejected",
            ...(consumedGrantId ? { grantId: consumedGrantId } : {}),
          },
        } as const;
        if (consumed.ok) {
          await services.auditLogger.appendPermissionAuditEntry({
            ...commonGrantAudit,
            decision: "allow",
            });
        } else {
          await services.auditLogger.appendPermissionAuditEntry({
            ...commonGrantAudit,
            decision: "deny",
            denyReasons: [{
              reason: consumed.reason,
              source: "plugin-operation-grant",
            }],
          });
        }
      } catch (error) {
        grantAuditError = error;
      }
      if (!consumed.ok || grantAuditError !== undefined) {
        const reason = consumed.ok
          ? `permission audit chain failed: ${errorMessage(grantAuditError)}`
          : consumed.reason;
        const msg = `Plugin operation denied: ${reason}`;
        const durationMs = Date.now() - startTime;
        const denied: PermissionCheckResult = {
          decision: "deny",
          reason,
          };
        callbacks?.onToolEnd?.(
          toolUse.name,
          msg,
          true,
          meta,
          undefined,
          durationMs,
        );
        await auditCurrentToolCall(
          sessionId,
          toolUse.name,
          source,
          trust,
          finalInput,
          msg,
          true,
          startTime,
          denied,
          rateResult.remaining,
          invocationPermissionContext,
          invocationCategory,
          executionCwd,
        );
        return withHostShellExecutionPlan({
          tool_use_id: toolUse.id,
          content: msg,
          is_error: true,
          durationMs,
        });
      }
    }

    emitToolStart(callbacks, toolUse.name, finalInput, meta);

    // ── Step 6: Execute ─────────────────────────────
  // Mint only after all permission, hook, rate-limit, and audit gates passed.
  // The permit is private host state, binds this exact final shell action,
  // and is consumed once by the plain explicit-host / Plan-B spawn path. Its
  // authority is either the user's allow-once receipt or, for an explicit host
  // request only, the matching exact allow-rule decision (owner 2026-10-25, unsandboxed shell exact-rule requirement).
  const hostShellExecutionPermit =
    hostShellExecutionPlan !== undefined &&
    hostShellExecutionPermitBinding !== undefined
      ? mintHostShellExecutionPermit({
          plan: hostShellExecutionPlan,
          approvalDecision: hostShellApprovalDecision,
          allowRuleDecision: hostShellAllowRuleDecision,
          permissionManager: services.permissionManager,
          binding: hostShellExecutionPermitBinding,
        })
      : undefined;
  if (
    hostShellRequiresExplicitApproval &&
    hostShellExecutionPermit === undefined
  ) {
    const msg =
      "Unsandboxed shell execution blocked: no host policy authorization or verified approval receipt was available for this action.";
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
    await auditCurrentToolCall(
      sessionId,
      toolUse.name,
      source,
      trust,
      finalInput,
      msg,
      true,
      startTime,
      permissionResult
        ? {
            ...permissionResult,
            decision: "deny",
            reason: msg,
            }
        : { decision: "deny", reason: msg, },
      rateResult.remaining,
      invocationPermissionContext,
      invocationCategory,
      executionCwd,
    );
    return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
  }

  const captureOutput = source === "builtin" && hostShellExecutionPlan && toolOutputCaptureFactory
    ? () => {
        const capture = toolOutputCaptureFactory(toolUse.id);
        ownedOutputCapture = capture;
        return {
          captureId: capture.captureId,
          append: (chunk: Uint8Array) => capture.append(chunk),
          waitForDrain: () => capture.waitForDrain(),
          finish: async (interrupted?: boolean) => {
            outputArtifact = await capture.finish(interrupted);
            return outputArtifact;
          },
        };
      }
    : undefined;
  // Live shell output reaches the renderer through the same DLP masker as the
  // final display result (Step 7b), credentials included when PII redaction is
  // off, and nothing is delivered before it is masked.
  const onToolOutput = callbacks?.onToolOutput;
  const liveOutputPii = isPiiRedactionEnabled();
  const liveOutputRelay = source === "builtin" && hostShellExecutionPlan && onToolOutput
    ? createMaskedProgressRelay(
        (text) => onToolOutput(toolUse.name, text, meta),
        (text) => maskSensitiveData(text, { pii: liveOutputPii }).masked,
      )
    : undefined;
  // Undefined for a builtin, and for a plugin whose data root is not the
  // host's real directory — a replaced root grants nothing.
  const ownerPluginSandboxRoot = tool.pluginId ? resolveOwnerPluginSandboxRoot(tool.pluginId) : undefined;
  const executionContext: ToolExecutionContext = {
    cwd: executionCwd,
    ...(isCanonicalWebFetchTool(tool) && services.permissionManager && typeof finalInput.url === "string" ? {
      authorizeNetworkTarget: (() => {
        const initialUrl = new URL(finalInput.url as string);
        // The authorization stage decided this exact initial request.
        // Redirects retain destination and credential checks below.
        const hasPerCallApproval = humanApproved || (permissionResult?.decision === "allow" && permissionResult.reasonCode !== "allow-mode");
        let scopedFetch = false;
        let first = true;
        return async (url: URL): Promise<void> => {
          const rules = await services.permissionManager!.checkNetworkRules(url.href, executionCwd, finalInput.allowPrivateNetwork === true);
          if (rules.admissionDenial) throw new Error(rules.admissionDenial);
          const initial = first && url.href === initialUrl.href;
          first = false;
          if (initial && (rules.decision === "allow" || rules.decision === "ask")) scopedFetch = true;
          if (rules.decision === "deny") throw new Error("Network destination requires a new permission decision");
          // The pipeline already authorized these exact initial arguments.
          if (initial) return;
          const approvedOrigin = hasPerCallApproval && url.origin === initialUrl.origin;
          // One approval covers ordinary redirects within that origin;
          // destination restrictions still apply per hop.
          if ((rules.decision === "ask" && !approvedOrigin)
            || ((scopedFetch || hasPerCallApproval) && !initial && rules.decision !== "allow" && !approvedOrigin)) {
            throw new Error("Network destination requires a new permission decision");
          }
        };
      })(),
    } : {}),
    extraAllowedDirectories: [...new Set(invocationRuntimeAllowedDirectories)],
    blockReadsOutsideWorkingDirectories,
    headless: invocationPermissionContext.headless === true,
    // Owner plugin sandbox root — same derivation the reviewer uses
    // (executor permission path). Plugin-owned tools confine their OS
    // write-jail to `~/.ave/plugins/<pluginId>/data`, the plugin's own
    // writable state, NOT the plugin root: the root holds the bundle the next
    // load imports into the main process. Builtins pass undefined.
    ...(ownerPluginSandboxRoot !== undefined ? { ownerPluginSandboxRoot } : {}),
    ...(hostShellExecutionPlan ? { hostShellExecutionPlan } : {}),
    ...(executionRouteGrant ? { executionRouteGrant } : {}),
    ...(hostTerminalRoute ? { hostTerminalRoute } : {}),
    ...(preparedShellInvocation ? { preparedShellInvocation } : {}),
    ...(verifiedShellCommand ? { verifiedShellCommand } : {}),
    ...(hostShellExecutionPermit ? { hostShellExecutionPermit } : {}),
    metadata: {
      // Absent when the invocation has no conversation behind it. Tools that
      // need one refuse without it; a placeholder string here would make every
      // one of those guards unreachable and file the work under a synthetic
      // session instead.
      ...(sessionId !== undefined ? { sessionId } : {}),
      // C3(b): spawn depth visible to tools — `agent_spawn` reads this
      // and refuses when >= 1 (a sub-agent cannot itself spawn).
      spawnDepth: spawnDepth ?? 0,
      ...(memoryIncludeUnscoped === true ? { memoryIncludeUnscoped: true } : {}),
      // The target-wide scope this call was authorized under (see
      // approval-memory-context.ts): a tool whose target can move between the
      // prompt and execution re-checks it here.
      ...(invocationPermissionContext.approvalMemory?.kind === "key"
        ? { [APPROVAL_MEMORY_SCOPE_METADATA_KEY]: invocationPermissionContext.approvalMemory.scope }
        : {}),
      supportsA2AParentDelivery: supportsA2AParentDelivery === true,
      ...(invocationPermissionContext.approvalSurface
        ? { approvalSurface: invocationPermissionContext.approvalSurface }
        : {}),
      // Tool 자기 호출의 stable id — 렌더러가 inline UI 카드 (sub-agent 등)
      // 를 ToolGroupCard 옆에 join 할 때 키로 사용. agent_spawn 이 emit 하는
      // 라이프사이클 이벤트에 함께 실어 보냄.
      toolUseId: toolUse.id,
      ...(captureOutput ? { toolOutputCaptureFactory: captureOutput } : {}),
      ...(liveOutputRelay ? { [TOOL_OUTPUT_PROGRESS_METADATA_KEY]: liveOutputRelay } : {}),
      trustOrigin: invocationPermissionContext.trustOrigin,
      ...(toolResultChunkReader
        ? { [TOOL_RESULT_CHUNK_READER_METADATA_KEY]: toolResultChunkReader }
        : {}),
      ...(toolUse.name === "agent_send"
        && tool.source === "builtin"
        && spawnDepth === 1
        && sessionId === a2aCausalContext?.recipientChildSessionId
        && isA2AAgentCausalContext(a2aCausalContext)
        ? { [A2A_CAUSAL_CONTEXT_METADATA_KEY]: a2aCausalContext }
        : {}),
    },
    abortSignal,
  };

  // Global ceiling via `runWithCeiling` helper — last-resort cap with a
  // linked AbortController so the underlying tool work actually stops
  // (tools that participate in `executionContext.abortSignal` propagate
  // the cancellation). A builtin that supervises a bounded loop of its own
  // (agent_spawn) sizes its wall clock from the host setting that bounds that
  // loop; a builtin shell invocation follows its own `timeoutSeconds` so an
  // escalated retry is not cut short by the ceiling.
  const effectiveCeilingMs = resolveEffectiveCeilingMs(tool, finalInput);
  const awaitCancellationSettlement =
    source === "builtin" && tool.awaitCancellationSettlement === true;
  let settledTaskError: string | undefined;
  // A host-derived raise is invisible at the call site — it comes from a
  // setting, not from anything in this invocation's input — so record it.
  // (A shell raise needs no separate entry: the `timeoutSeconds` the model
  // asked for is already in this call's audited input.)
  if (
    tool.resolveHostCeilingMs !== undefined
    && effectiveCeilingMs > TOOL_TIMEOUT_POLICY.globalCeilingMs
  ) {
    services.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: sessionId ?? "unknown",
      type: "info",
      input: `tool=${tool.name} source=${tool.source}`,
      output:
        `host ceiling raised to ${effectiveCeilingMs}ms `
        + `(base ${TOOL_TIMEOUT_POLICY.globalCeilingMs}ms)`,
    });
  }
  // Every allow source reaches this gate. Reviewer-bound requests paused by
  // the breaker require fresh native consent; existing grants keep their scope.
  // Nothing asynchronous may separate this check from the handler call.
  const assertHandlerAdmission = (signal: AbortSignal): void => {
    signal.throwIfAborted();
    if (services.requirePermissionAuditChain) {
      try {
        services.auditLogger.assertPermissionAuditWritable();
      } catch (error) {
        permissionResult = {
          decision: "deny", reason: "permission audit chain unavailable before execution", };
        throw new Error(t("be_executor.auditChainBlock", { name: toolUse.name, error: errorMessage(error) }));
      }
    }
    if (humanApproved && services.permissionManager &&
        approvedPolicyEpoch !== services.permissionManager.getPolicyEpoch()) {
      permissionResult = { ...permissionResult, decision: "deny", reason: "Permission policy changed before execution.", };
      throw new Error(permissionResult.reason);
    }
    const recheckTarget = permissionRecheckResult ?? permissionResult;
    if (!humanApproved && recheckTarget?.pipelineRequest && services.permissionManager) {
      const refreshed = services.permissionManager.recheckPermission(recheckTarget);
      if (permissionRecheckResult) permissionRecheckResult = refreshed;
      const paused = refreshed.decision === "ask" && refreshed.pipelineRequest?.automationPause !== undefined;
      const forced = refreshed.forceModal === true || refreshed.pipelineRequest?.floor !== undefined || refreshed.pipelineRequest?.manualRerun === true;
      if (!permissionRecheckResult || refreshed.decision === "deny" || paused || forced) permissionResult = refreshed;
      if (refreshed.decision === "deny") throw new Error(refreshed.reason);
      if (paused || refreshed.decision === "ask" && (refreshed.pipelineRequest?.floor !== undefined || refreshed.pipelineRequest?.userOwnedSurface !== undefined)) throw new HandlerPermissionAskError();
      if (forced) throw new Error(refreshed.reason);
      // The sealed rationale receipt remains separate authority when its
      // original issued request still asks under unchanged policy.
      if (!permissionRecheckResult && refreshed.decision !== "allow") throw new Error(refreshed.reason);
    }
    if (pluginOperationPrincipal && operationExecutionDomain) {
      services.pluginOperationGrants.assertExecutionAuthorized(
        pluginOperationPrincipal,
        operationExecutionDomain,
      );
    }
    if (pluginAuthLifecycle) {
      if (!pluginOperationPrincipal || !operationExecutionDomain) {
        throw new Error("host plugin auth lifecycle is missing governed operation admission");
      }
      pluginAuthLifecycle.beforeHandler(pluginOperationPrincipal, operationExecutionDomain);
    }
    if (!isRemoteControllerBoundToSession(invocationPermissionContext.remoteControllerAuthority, sessionId)) {
      throw new Error("remote-controller-revoked");
    }
    signal.throwIfAborted();
  };

  let lateApprovalPolicyEpoch: string | undefined;
  const assertLateApprovalPolicyCurrent = (): void => {
    const manager = services.permissionManager;
    if (manager && lateApprovalPolicyEpoch !== manager.getPolicyEpoch()) {
      if (permissionResult?.pipelineRequest) permissionResult = manager.recheckPermission(permissionResult);
      throw new Error(permissionResult?.reason ?? "Permission policy changed before execution.");
    }
  };

  const prepareLateApproval = async (
    signal: AbortSignal,
  ): Promise<ApprovalRequestInput & { sessionId: string }> => {
    if (permissionResult?.decision !== "ask" || !(permissionResult.pipelineRequest?.automationPause || permissionResult.pipelineRequest?.userOwnedSurface || permissionResult.forceModal && permissionResult.pipelineRequest?.floor)) {
      throw new Error("Late approval requires an issued human approval decision");
    }
    const reason = permissionResult.reason;
    const userAvailable = invocationPermissionContext.headless !== true &&
      invocationPermissionContext.approvalSurface !== "unavailable" && services.approvalGate !== undefined;
    emitPermissionReview(callbacks, {
      status: userAvailable ? "needs_approval" : "failed", toolName: toolUse.name,
      toolCategory: invocationCategory, source, reason, ...meta,
    });
    if (!userAvailable) throw new Error(NO_APPROVER_MESSAGE);
    if (sessionId === undefined) throw new Error("Automated approval is missing its session identity");
    lateApprovalPolicyEpoch = services.permissionManager?.getPolicyEpoch();
    const permHook = await runScriptHook(
      services.scriptHookManager, "perm", toolUse.name, source, invocationCategory,
      finalInput, sessionId, invocationPermissionContext, tool.mcpServerId, tool.pluginId,
      undefined, undefined, tool.pluginGeneration !== undefined,
      signal,
    );
    signal.throwIfAborted();
    latePermissionHookChain = hookChainFromDispatch("perm", permHook);
    assertLateApprovalPolicyCurrent();
    if (permHook.decision === "deny") {
      permissionResult = { ...permissionResult, decision: "deny", reason: permHook.reason };
      throw new Error(t("be_executor.hookPermissionBlock", { reason: permHook.reason }));
    }
    await services.auditWriter.auditPermissionAsk(
      toolUse.name, source, invocationCategory, finalInput,
      permissionResult, executionCwd,
      invocationPermissionContext, targetFilePath, currentAuditMetadata(finalInput),
    );
    signal.throwIfAborted();
    assertLateApprovalPolicyCurrent();
    if (services.permissionManager && permissionResult.pipelineRequest) {
      permissionResult = services.permissionManager.recheckPermission(permissionResult);
      if (permissionResult.decision !== "ask") throw new Error(permissionResult.reason);
    }
    const hostTerminalFacts = hostTerminalApprovalFacts(tool, invocationPermissionContext.approvalMemory, finalInput.command);
    const ruleAssessment = permissionResult.reviewer?.verdict === undefined && permissionResult.forceModal !== true && !permissionResult.pipelineRequest?.userOwnedSurface
      ? classifyApprovalRuleVerdict({
          toolName: toolUse.name, source, category: invocationCategory,
          pathFields: tool.pathFields ?? [], finalInput, approvalCacheKey, executionCwd,
          allowedDirectories: invocationAllowedScope.directories,
          sensitivePathsAdjacent: sensitivePathPattern ? [sensitivePathPattern] : [],
          context: invocationPermissionContext,
          sandboxAttestation: { ...(ownerPluginSandboxRoot ? { ownerPluginSandboxRoot } : {}) },
          mcpServerId: tool.mcpServerId, workerId: tool.workerId, pluginId: tool.pluginId,
          hostShellExecutionPlan,
          ...(hostTerminalFacts.sandboxCapability ? { sandboxCapability: hostTerminalFacts.sandboxCapability } : {}),
        }) : undefined;
    return {
      id: randomUUID(), sessionId, category: "tool", kind: "tool", toolName: toolUse.name,
      toolCategory: invocationCategory, source, trustOrigin: invocationPermissionContext.trustOrigin,
      args: finalInput, reason: approvalReasonPrefix ? `${approvalReasonPrefix} ${reason}` : reason,
      ...(approvalReasonPrefix ? { approvalReasonPrefix } : {}),
      createdAt: Date.now(), abortSignal,
      ...(permissionResult.forceModal ? { forceExplicit: true as const, allowedChoices: ["allow-once", "deny-once"] as const, durableApprovalRecordAllowed: false } : {}),
      ownerUnattended: invocationPermissionContext.ownerUnattended === true,
      ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
      sensitivePathPattern, evaluationContext,
      ...(approvalCacheKey ? { approvalCacheKey } : {}),
      ...(invocationPermissionContext.approvalMemory ? { approvalMemory: invocationPermissionContext.approvalMemory } : {}),
      ...(approvalPurpose ? { approvalPurpose } : {}),
      ...(verifiedShellCommand ? { verifiedShellCommand } : {}),
      ...(hostShellExecutionPermitBinding ? { hostShellExecutionPermitBinding } : {}),
      reviewerVerdict: permissionResult.reviewer?.verdict,
      reviewerOutcome: permissionResult.reviewer?.outcome,
      reviewerApprovalBasis: permissionResult.reviewer?.approvalBasis,
      ...(ruleAssessment ? { ruleVerdict: ruleAssessment.verdict, approvalRuleBasis: ruleAssessment.basis } : {}),
      ...(hostShellExecutionPlanAudit && invocationPermissionContext.disposableSubstrate === undefined
        ? { executionPlan: hostShellExecutionPlanAudit }
        : { sandboxCapability: invocationPermissionContext.disposableSubstrate
            ? disposableContainerCapability(invocationPermissionContext.disposableSubstrate)
            : resolveReviewerSandboxCapability(source, toolUse.name, tool.mcpServerId, tool.workerId, tool.pluginId, hostShellExecutionPlan) }),
      ...hostTerminalFacts,
      ...userOwnedSurfaceCardFacts(permissionResult),
    };
  };

  const requestLateApproval = async (request: ApprovalRequestInput & { sessionId: string }): Promise<void> => {
    abortSignal?.throwIfAborted();
    if (permissionResult?.decision !== "ask" || !(permissionResult.pipelineRequest?.automationPause || permissionResult.forceModal && permissionResult.pipelineRequest?.floor)) {
      throw new Error("Late approval requires an issued human approval decision");
    }
    assertLateApprovalPolicyCurrent();
    if (services.permissionManager && permissionResult.pipelineRequest) {
      permissionResult = services.permissionManager.recheckPermission(permissionResult);
      if (permissionResult.decision !== "ask") throw new Error(permissionResult.reason);
    }
    const liveRequest: ApprovalRequestInput = { ...request,
      userOwnedSurface: undefined, userOwnedSurfaceReviewFallback: undefined,
      reason: approvalReasonPrefix ? `${approvalReasonPrefix} ${permissionResult.reason}` : permissionResult.reason,
      ...(permissionResult.forceModal ? { forceExplicit: true as const, allowedChoices: ["allow-once", "deny-once"] as const, durableApprovalRecordAllowed: false } : {}),
      ...hostTerminalApprovalFacts(tool, invocationPermissionContext.approvalMemory, finalInput.command),
      ...userOwnedSurfaceCardFacts(permissionResult),
    };
    let decision = await services.approvalGate!.requestAndWait(liveRequest);
    abortSignal?.throwIfAborted();
    const currentEpoch = services.permissionManager?.getPolicyEpoch();
    if (lateApprovalPolicyEpoch !== currentEpoch &&
        (lateApprovalPolicyEpoch === undefined || currentEpoch === undefined ||
          !services.approvalGate!.allowsPolicyTransition(decision, lateApprovalPolicyEpoch, currentEpoch))) {
      permissionResult = { ...permissionResult, decision: "deny", reason: "Permission policy changed before execution." };
      throw new Error(permissionResult.reason);
    }
    const surfaceResolution = services.permissionManager ? await resolveUserOwnedSurfaceApproval({
      manager: services.permissionManager, gate: services.approvalGate!, permission: permissionResult, decision, request: liveRequest, sessionId,
      review: async permission => await dispatchReviewerForInteractiveAuto(services.permissionManager, toolUse.name, source, invocationCategory, tool.pathFields ?? [], finalInput, invocationAllowedScope.directories, sensitivePathPattern ? [sensitivePathPattern] : [], invocationPermissionContext, evaluationContext, { ...(ownerPluginSandboxRoot ? { ownerPluginSandboxRoot } : {}) }, callbacks, meta, approvalPurpose, hostShellExecutionPlan, abortSignal, undefined, sessionId, permission) ?? permission,
    }) : { permission: permissionResult, decision, humanApproved: undefined };
    permissionResult = surfaceResolution.permission;
    decision = surfaceResolution.decision;
    const failure = approvalFailureOutcome(decision, toolUse.name, permissionResult);
    if (failure) {
      permissionResult = failure.permission;
      throw new Error(failure.content);
    }
    humanApproved = surfaceResolution.humanApproved ?? (decision.choice.startsWith("allow") && !isHostApprovalRejectedDecision(decision));
    if (!humanApproved && permissionResult.decision !== "allow") {
      permissionResult = { ...permissionResult, decision: "deny", reason: request.reason };
      throw new Error(request.reason);
    }
    if (humanApproved) permissionResult = { ...permissionResult, decision: "allow", reason: `user approved approval request (${decision.choice})` };
    approvedPolicyEpoch = currentEpoch;
    if (hostShellExecutionPlan && hostShellExecutionPermitBinding) {
      const permit = mintHostShellExecutionPermit({ plan: hostShellExecutionPlan, approvalDecision: decision,
        permissionManager: services.permissionManager, binding: hostShellExecutionPermitBinding });
      if (hostShellRequiresExplicitApproval && !permit) throw new Error("Host shell approval receipt is unavailable");
      executionContext.hostShellExecutionPermit = permit;
    }
  };

  const attemptHandler = async (signal: AbortSignal): Promise<Awaited<ReturnType<Tool["execute"]>>> => {
    // Renew route admission after every asynchronous wait, including a card.
    const finalExecutionRouteGrant = finalizeExecutionRouteGrant === undefined
      ? executionRouteGrant
      : await finalizeExecutionRouteGrant();
    const ctx: ToolExecutionContext = {
      ...executionContext,
      ...(finalExecutionRouteGrant === undefined ? {} : { executionRouteGrant: finalExecutionRouteGrant }),
      abortSignal: signal,
    };
    let execution: ReturnType<Tool["execute"]>;
    try {
      execution = runWithToolExecutionCwd(executionCwd, () =>
        runWithEffectLedger(effectLedger, () =>
          runWithEffectGateContext(
            {
              headless: invocationPermissionContext.headless === true,
              executionCwd,
              abortSignal: signal,
              permissionContext: { admissionDenial: permissionResult?.pipelineRequest?.admissionDenial, floor: permissionResult?.pipelineRequest?.floor, exfiltration: permissionResult?.pipelineRequest?.exfiltration, manualRerun: invocationPermissionContext.manualRerun, ownerUnattended: invocationPermissionContext.ownerUnattended, remoteControllerAuthority: invocationPermissionContext.remoteControllerAuthority, permissionStoreError: invocationPermissionContext.permissionStoreError },
              approvalSurface: invocationPermissionContext.approvalSurface,
              toolName: toolUse.name,
              ...(sessionId === undefined ? {} : { sessionId }),
            },
            () => {
              assertHandlerAdmission(signal);
              if (context.replayRootBinding) {
                const replayRoot = checkReplayRootBinding(context.replayRootBinding);
                if (!replayRoot.valid) throw new Error(replayRoot.reason);
              }
              handlerAdmissionBlocked = false;
              return runWithAgentObservationInvocation({ sessionId, toolUseId: toolUse.id },
                () => tool.execute(finalInput, ctx),
                preparedShellInvocation ? preparedShellCommand(preparedShellInvocation).homePath : undefined, signal);
            },
            () => {
              effectAuthorizationRequired ??= issueAuthorizationRequiredControl({
                kind: "tool", toolName: toolUse.name, source, category: invocationCategory,
                reason: "approval-surface-unavailable",
              });
            },
            () => { effectNoApprover = true; },
          ),
        ),
      );
    } catch (error) {
      if (error instanceof HandlerPermissionAskError) {
        // Hook and required ask-audit work retain the attempt's cancellation
        // and settlement ownership. Only waiting for the person moves outside.
        const request = await prepareLateApproval(signal);
        throw new HandlerApprovalRequiredError(request);
      }
      throw error;
    }
    if (!awaitCancellationSettlement) return execution;
    return execution.catch((error: unknown) => {
      settledTaskError = errorMessage(error);
      throw error;
    });
  };

  const executeAdmittedHandler = async (): Promise<ToolCeilingOutcome<Awaited<ReturnType<Tool["execute"]>>>> => {
    while (true) {
      const attempt = await runWithCeiling(attemptHandler, effectiveCeilingMs, abortSignal, toolUse.name);
      if (attempt.ok || attempt.reason !== "error" || !(attempt.error instanceof HandlerApprovalRequiredError)) {
        return attempt;
      }
      // No execution timer survives a refused admission. User consent uses
      // the same card timeout and caller cancellation as ordinary approval.
      try {
        await requestLateApproval(attempt.error.request);
      } catch (error) {
        return {
          ok: false,
          reason: abortSignal?.aborted ? "user-abort" : "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    }
  };
  const outcome = await executeAdmittedHandler();
  // A tool that never closed its stream (an error path) still releases what
  // the relay held, masked, before the call's completion is reported.
  liveOutputRelay?.end();
  const cancellationSettlement =
    !outcome.ok &&
    (outcome.reason === "ceiling" || outcome.reason === "user-abort") &&
    outcome.settlement &&
    awaitCancellationSettlement
      ? await outcome.settlement
      : undefined;
  if (
    resolvedPluginOperation &&
    operationExecutionDomain
  ) {
    if (
      resolvedPluginOperation.rule.kind === "write" ||
      outcome.settlement
    ) {
      // Declared writes and any interrupted governed execution may have
      // changed remote state. Advance before the exclusive lease can release.
      services.pluginOperationGrants.markDomainMutation(
        operationExecutionDomain,
      );
    }
  }
  if (
    outcome.settlement &&
    resolvedPluginOperation &&
    pluginOperationPrincipal
  ) {
    deferredOperationSettlement = outcome.settlement;
    terminationReason = "indeterminate";
    await services.auditLogger.appendPermissionAuditEntry({
      ts: new Date().toISOString(),
      auditId: randomUUID(),
      tool: toolUse.name,
      source,
      category: invocationCategory,
      trustOrigin: invocationPermissionContext.trustOrigin,
      decision: "deny",
      denyReasons: [{
        reason: "authorized governed operation remains unsettled after interruption",
        source: "plugin-operation-execution",
      }],
      pluginOperation: {
        pluginId: pluginOperationPrincipal.ownerPluginId,
        operation: resolvedPluginOperation.operation,
        outcome: "indeterminate",
        ...(consumedPluginOperationGrantId
          ? { grantId: consumedPluginOperationGrantId }
          : {}),
      },
    });
    indeterminateAuditPersisted = true;
  }
  if (effectAuthorizationRequired || effectNoApprover) {
    // The host effect boundary latched this before blocking the mutation. A
    // plugin may catch that thrown denial, but it cannot clear this outer
    // invocation state or turn the missing approval UI into a retryable result.
    authorizationRequired = effectAuthorizationRequired;
    content = effectAuthorizationRequired
      ? "Authorization required: this plugin effect requires explicit approval, "
      + "but this host has no approval surface. The turn has stopped and will not retry automatically."
      : NO_APPROVER_MESSAGE;
    isError = true;
    terminationReason = "error";
  } else if (outcome.ok) {
    const result = outcome.value;
    sandboxBlock = sandboxBlockForResult(result);
    content = result.output;
    isError = result.isError;
    if (authorizationRequiredStateOf(result.authorizationRequired)) {
      authorizationRequired = result.authorizationRequired;
    }
    // MCP Apps §3.2 — propagate uiPayload from tool metadata
    if (result.metadata?.uiPayload) {
      uiPayload = result.metadata.uiPayload as import("../mcp/types.js").McpUiPayload;
    }
    if (Object.prototype.hasOwnProperty.call(result.metadata ?? {}, "rawResult")) {
      rawResult = result.metadata?.rawResult;
    }
    // view_image et al. — an image the model should see travels on a sibling
    // field; the Claude mapper turns it into an image block, other vendors keep
    // the text placeholder.
    if (result.image) {
      image = result.image;
    }
    if (isError) terminationReason = "error";
  } else {
    if (
      outcome.reason === "ceiling" ||
      outcome.reason === "user-abort"
    ) {
      interruptionReason = outcome.reason;
    }
    if (!outcome.settlement || cancellationSettlement) {
      terminationReason = outcome.reason;
    }
    // Ceiling expiry is a RETRYABLE tool error, never a throw that ends the
    // turn. Shell tools recover by naming a larger `timeoutSeconds`; no other
    // tool — builtin, plugin, or MCP — has such a field (audited: only
    // bash/powershell expose one), so for them the guidance has to carry the
    // recovery instead: say the HOST bound the call, and that the way through
    // is narrower work, not a longer wait it has no way to ask for.
    content =
      outcome.reason === "ceiling"
        ? t("be_executor.toolCeilingExceeded", {
            name: toolUse.name,
            seconds: String(Math.round(effectiveCeilingMs / 1000)),
          })
        : outcome.reason === "user-abort"
          ? t("be_executor.toolExecutionCancelled")
          : outcome.error.message || t("be_executor.toolExecutionUnknownError");
    if (cancellationSettlement) {
      // Only the settled output/error is diagnostic text. In particular, a
      // late success is no proof of rollback, and UI/raw metadata is withheld.
      content += cancellationSettlement.ok
        ? "\n\n[Tool result after interruption]\n"
        : "\n\n[Tool error after interruption]\n";
      const raw = cancellationSettlement.ok
        ? cancellationSettlement.value.output
        : settledTaskError ?? cancellationSettlement.error.message;
      const bounded = boundInterruptionDetail(raw);
      settledToolDetail = { raw, start: content.length, boundedLength: bounded.length };
      content += bounded;
    }
    isError = true;
  }

  // ── Effect shadow (observability only) ───────────────────────────
  // The execution has returned, so the per-invocation ledger now holds the
  // host-observed effects. This is the dedicated shadow reconciliation log
  // (NOT the HMAC audit-grade channel). `hasMutatingEffect` is the host-owned
  // read/write classification for this call; it drives NO permission decision
  // here — a later read-recognition gate consumes it.
  const effectSummary = effectLedger.summary();
  if (
    operationExecutionDomain &&
    resolvedPluginOperation?.rule.kind === "read" &&
    !outcome.settlement &&
    effectSummary.hasMutatingEffect
  ) {
    services.pluginOperationGrants.markDomainMutation(
      operationExecutionDomain,
    );
  }
  // Propagate a MUTATING inner invocation onto the parent (outer wrapper)
  // ledger. Without this a read-declared wrapper W that delegates a mutation
  // via callTool(M) would record `hasMutatingEffect:false` on its OWN ledger
  // (M's write lives only on M's inner ledger), which a later read-recognition
  // gate could treat as a confirmed read — fail-permissive. The marker surfaces
  // W's ledger as mutating. Effect class from the SOT.
  if (parentEffectLedger && effectSummary.hasMutatingEffect) {
    parentEffectLedger.record({
      kind: "callTool-child",
      effect: CHOKEPOINT_EFFECT["callTool-child"],
      target: tool.name,
    });
  }
  // A signed read declaration alone cannot mint freshness. Stage the receipt
  // only after a successful Host-observable plugin execution with no mutation.
  // Publication waits until post hooks and the required final audit are both
  // durably complete below.
  if (
    !isError &&
    tool.source === "plugin" &&
    resolvedPluginOperation?.rule.kind === "read" &&
    pluginOperationPrincipal &&
    services.pluginOperationGrants.canRecordRead(
      pluginOperationPrincipal,
      operationExecutionDomain!,
    ) &&
    !effectSummary.hasMutatingEffect &&
    satisfiesDeclaredReadResultStatus(
      rawResult,
      resolvedPluginOperation.rule.successfulResultStatuses,
    )
  ) {
    pendingReadReceipt = {
      principal: pluginOperationPrincipal,
      readTool: toolUse.name,
      readOperation: resolvedPluginOperation.operation,
      domainKey: operationExecutionDomain!,
    };
  }
  // Emit the EFFECT shadow record for plugin/MCP invocations (builtins never
  // touch the hostApi closures, so their ledger is empty — no reconciliation
  // value). `hostObservable` is false for external MCP tools: their effects are
  // NOT host-mediated, so an empty ledger is NOT a confirmed read and a later
  // read-recognition gate MUST fail closed on it. In-process plugin tools route
  // through the instrumented hostApi closures, so they are host-observable.
  if (tool.source === "plugin" || tool.source === "mcp") {
    emitEffectShadowLog(
      {
        toolName: tool.name,
        source: tool.source,
        ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
        declaredCategory: declaredCategoryForEffectShadow,
        hostObservable: tool.source === "plugin",
        hostObservedEffect: effectSummary,
      },
      services.auditLogger,
    );
  }
  if (
    operationExecutionLease &&
    !deferredOperationSettlement
  ) {
    // Keep the exclusive governed-operation lease through every terminal audit,
    // rationale transition, receipt publication, and callback. User-abort is a
    // terminal result too; it cannot release before its final audit persists.
    holdOperationLeaseForFinalBoundary = true;
  }
  } catch (error) {
    ownedOutputCapture?.abandon?.();
    throw error;
  } finally {
    if (!holdOperationLeaseForFinalBoundary) {
      completePluginAuthFailure(
        new Error(
          "governed plugin auth invocation ended before a successful terminal audit",
        ),
      );
    }
    if (
      operationExecutionLease &&
      deferredOperationSettlement &&
      indeterminateAuditPersisted &&
      pluginOperationPrincipal &&
      resolvedPluginOperation
    ) {
      const lease = operationExecutionLease;
      const pluginId = pluginOperationPrincipal.ownerPluginId;
      const operation = resolvedPluginOperation.operation;
      const grantId = consumedPluginOperationGrantId;
      void deferredOperationSettlement
        .then(async () => {
          try {
            await services.auditLogger.appendPermissionAuditEntry({
              ts: new Date().toISOString(),
              auditId: randomUUID(),
              tool: toolUse.name,
              source,
              category: invocationCategory,
              trustOrigin: invocationPermissionContext.trustOrigin,
              decision: "allow",
              pluginOperation: {
                pluginId,
                operation,
                outcome: "settled",
                ...(grantId ? { grantId } : {}),
              },
            });
            lease.release();
          } catch (error) {
            log.error(
              "late plugin operation settlement audit failed; domain remains poisoned for %s: %s",
              toolUse.name,
              errorMessage(error),
            );
          }
        }, (error) => {
          log.error(
            "late plugin operation settlement tracking failed; domain remains poisoned for %s: %s",
            toolUse.name,
            errorMessage(error),
          );
        });
    } else if (operationExecutionLease && deferredOperationSettlement) {
      void deferredOperationSettlement.catch((error) => {
        log.error(
          "unaudited late plugin operation settlement tracking failed; domain remains poisoned for %s: %s",
          toolUse.name,
          errorMessage(error),
        );
      });
      log.error(
        "plugin operation interruption audit failed; domain remains poisoned for %s",
        toolUse.name,
      );
    } else if (!holdOperationLeaseForFinalBoundary) {
      operationExecutionLease?.release();
    }
  }

  if (interruptionReason === "user-abort") {
    const durationMs = Date.now() - startTime;
    const displayContent = maskExecutionOutput(content, settledToolDetail, isPiiRedactionEnabled()).masked;
    // Mark BEFORE any onToolEnd/meta consumer reads it: the same `meta` object
    // reaches the live renderer event and the persisted tool_result meta, so
    // setting it here is what makes both paths agree.
    meta.cancelled = true;
    try {
      if (!rationaleResumeContext?.started) {
        callbacks?.onToolEnd?.(toolUse.name, displayContent, true, meta, undefined, durationMs);
      }
      await auditCurrentToolCall(
        sessionId,
        toolUse.name,
        source,
        trust,
        finalInput,
        displayContent,
        true,
        startTime,
        permissionResult,
        rateResult.remaining,
        invocationPermissionContext,
        invocationCategory,
        executionCwd,
        targetFilePath,
        terminationReason,
      );
      if (rationaleResumeContext?.started) {
        rationaleResumeContext.terminalizationAttempted = true;
        const terminalCommitted = await finishRationaleResume(
          rationaleResumeContext.started,
          false,
        );
        rationaleResumeContext.terminalized = terminalCommitted;
        if (!terminalCommitted) {
          callbacks?.onToolEnd?.(toolUse.name, RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, true, meta, undefined, durationMs);
          completePluginAuthFailure(
            new Error(RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT),
          );
          return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, is_error: true, durationMs });
        }
        callbacks?.onToolEnd?.(toolUse.name, displayContent, true, meta, undefined, durationMs);
      }
      completePluginAuthFailure(new Error(content));
      outputArtifactDelivered = outputArtifact !== undefined;
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content, is_error: true, durationMs, ...(outputArtifact ? { outputArtifact } : {}) });
    } catch (error) {
      completePluginAuthFailure(error);
      if (operationExecutionDomain && resolvedPluginOperation) {
        services.pluginOperationGrants.poisonDomain(operationExecutionDomain);
      }
      throw error;
    } finally {
      if (!outputArtifactDelivered) ownedOutputCapture?.abandon?.();
      releaseOperationLeaseAfterFinalBoundary();
    }
  }

  try {
  // ── Step 7: PostHook + Feedback Merge ───────────
  if (!resolvedPluginOperation && !handlerAdmissionBlocked) {
    postFeedback = await services.hookRunner.runPostHooks({
      toolName: toolUse.name,
      toolInput: finalInput,
      toolOutput: content,
      isError,
    });
    scriptPost = await runScriptHook(
      services.scriptHookManager,
      "post",
      toolUse.name,
      source,
      invocationCategory,
      finalInput,
      sessionId,
      invocationPermissionContext,
      tool.mcpServerId,
      tool.pluginId,
      content,
      isError,
      tool.pluginGeneration !== undefined,
      abortSignal,
    );
    if (isError) {
      const failureHooks = await services.auditWriter.fireLifecycleEvent(
        "PostToolUseFailure",
        sessionId,
        invocationPermissionContext,
        {
          toolName: toolUse.name,
          errorMessage: content,
          durationMs: Date.now() - startTime,
        },
      );
      if (failureHooks.result?.decision === "deny" && failureHooks.result.results.length > 0) {
        content = `${content}\n\n[Script Hook Feedback]\n${failureHooks.result.reason}`;
      }
    }
  }

  if (postFeedback) content = `${content}\n\n[Hook Feedback]\n${postFeedback}`;
  if (scriptPost.results.length > 0 && scriptPost.decision === "deny") {
    content = `${content}\n\n[Script Hook Feedback]\n${scriptPost.reason}`;
  }
  if (preResult.feedback) content = `${content}\n\n[Pre-Hook Note]\n${preResult.feedback}`;

  // ── Step 7b: DLP 민감 데이터 마스킹 ────────────
  //
  // The tool_result content is part of the machine channel consumed by
  // the next LLM round. Do not mutate it with display/audit redactions:
  // user-provided operational data such as an email recipient must remain
  // available to later tools. DLP applies only to renderer callbacks and
  // audit entries.
  //
  // Those two surfaces are what `privacy.piiRedactEnabled` governs. With the
  // toggle off a credential still gets scrubbed — that is a security control,
  // not a preference — but the user's own email or phone number reaches the
  // display and the audit entry intact, and raises neither the warning nor the
  // `dlp_masked` audit note.
  let displayContent = content;
  const pii = isPiiRedactionEnabled();
  const dlpResult = maskExecutionOutput(content, settledToolDetail, pii);
  if (dlpResult.detections.length > 0) {
    displayContent = dlpResult.masked;
    const audit = currentAuditMetadata(finalInput);
    const dlpAuditInput = maskSensitiveData(
      JSON.stringify(auditSafeToolInput(finalInput, audit)),
      { pii },
    ).masked;
    log.warn(
      `Sensitive data detected and masked — tool: '${toolUse.name}', patterns: ${dlpResult.detections.join(", ")}`,
    );
    services.auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: sessionId ?? "unknown",
      type: "tool_call",
      input: dlpAuditInput.slice(0, 500),
        output: `[DLP masking applied] patterns: ${dlpResult.detections.join(", ")}`,
      toolCalls: [{
        name: toolUse.name,
        isError: false,
        source,
        trust,
        executionTimeMs: Date.now() - startTime,
        ...(audit.toolUseId !== undefined ? { toolUseId: audit.toolUseId } : {}),
        ...(audit.executionPlan !== undefined
          ? { executionPlan: audit.executionPlan }
          : {}),
        permissionDecision: "dlp_masked",
          permissionReason: `Detected patterns: ${dlpResult.detections.join(", ")}`,
      }],
    });
  }

  // ── Step 8: Audit + Result (항상 실행) ──────────
  const durationMs = Date.now() - startTime;
  // Redact the user's freeText answer before it lands in the audit
  // log. The DLP filter at Step 7b only catches structured patterns
  // (emails, IDs); a free-form answer ("내 비밀번호는 …") wouldn't match
  // any pattern but is still PII the user typed in. For ask_user_question
  // specifically, the LLM doesn't need the raw text in audit — provenance
  // (the question + that the user replied) is what matters.
  //
  // Gate on `source === "builtin"` (mirrors the builtin-only short-circuit
  // pattern at Step 3). Otherwise a plugin/MCP tool that happens to be
  // named `ask_user_question` would have its `freeText` field blindly
  // replaced — a name collision should not trigger host-level redaction.
  const auditContent =
    toolUse.name === "ask_user_question" && source === "builtin" && !isError
      ? redactAskUserAuditOutput(displayContent)
      : displayContent;
  // Forensic hook chain on the success/post path: the pre hooks that allowed
  // this call plus the post hooks that ran after it. `undefined` when neither
  // fired (keeps non-hook rows clean). config-hook vs `.sh`-hook is now
  // distinguishable via each row's `source`.
  const successHookChain = mergeHookChains(
    hookChainFromDispatch("pre", context.scriptPre),
    hookChainFromDispatch("post", scriptPost),
    latePermissionHookChain,
  );
  const auditedPermissionResult = authorizationRequired || effectNoApprover
    ? {
        ...(permissionResult ?? { }),
        decision: "deny" as const,
        reason: effectNoApprover ? NO_APPROVER_MESSAGE : "authorization required but approval surface unavailable",
      }
    : permissionResult;
  await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent, isError, startTime, auditedPermissionResult, rateResult.remaining, invocationPermissionContext, invocationCategory, executionCwd, targetFilePath, terminationReason, successHookChain);
  if (rationaleResumeContext?.started) {
    rationaleResumeContext.terminalizationAttempted = true;
    const terminalCommitted = await finishRationaleResume(
      rationaleResumeContext.started,
      !isError && terminationReason === "ok",
    );
    rationaleResumeContext.terminalized = terminalCommitted;
    if (!terminalCommitted) {
      log.error("Rationale resume invocation terminal audit CAS failed");
      callbacks?.onToolEnd?.(toolUse.name, RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, true, meta, undefined, durationMs);
      completePluginAuthFailure(
        new Error(RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT),
      );
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, is_error: true, durationMs });
    }
  }
  if (pendingReadReceipt) {
    services.pluginOperationGrants.recordRead({
      ...pendingReadReceipt.principal,
      readTool: pendingReadReceipt.readTool,
      readOperation: pendingReadReceipt.readOperation,
    }, pendingReadReceipt.domainKey);
  }
  callbacks?.onToolEnd?.(
    toolUse.name,
    displayContent,
    isError,
    meta,
    uiPayload,
    durationMs,
  );

  if (!isError && terminationReason === "ok") {
    completePluginAuthSuccess(rawResult);
  } else {
    completePluginAuthFailure(new Error(content));
  }

  outputArtifactDelivered = outputArtifact !== undefined;
  const completedResult = withHostShellExecutionPlan({
    tool_use_id: toolUse.id,
    content,
    ...(isError && { is_error: true }),
    ...(uiPayload && { uiPayload }),
    ...(rawResult !== undefined && { rawResult }),
    ...(image && { image }),
    ...(authorizationRequired ? { authorizationRequired } : {}),
    ...(outputArtifact ? { outputArtifact } : {}),
    durationMs,
  });
  if (sandboxBlock !== undefined) attachSandboxBlock(completedResult, sandboxBlock);
  return completedResult;
  } catch (error) {
    completePluginAuthFailure(error);
    if (operationExecutionDomain && resolvedPluginOperation) {
      try {
        services.pluginOperationGrants.poisonDomain(operationExecutionDomain);
      } catch (poisonError) {
        log.error(
          "failed to poison governed operation domain after final boundary failure for %s: %s",
          toolUse.name,
          errorMessage(poisonError),
        );
      }
    }
    throw error;
  } finally {
    if (!outputArtifactDelivered) ownedOutputCapture?.abandon?.();
    releaseOperationLeaseAfterFinalBoundary();
  }
}
