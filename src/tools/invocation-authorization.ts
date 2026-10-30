import { RationaleHumanApprovalDeniedError } from "./pipeline/rationale-control.js";
import { userOwnedBrowserScopeOf } from "./browser-tools.js";
import { userOwnedSurfaceCardFacts, resolveUserOwnedSurfaceApproval } from "./pipeline/user-owned-surface.js";
import { isConfinedHostShellExecution } from "../permissions/host-shell-execution-plan.js";
import { randomUUID } from "node:crypto";
import type { Tool } from "./base.js";
import type { ToolCategory, ToolSource, TrustLevel } from "./types.js";
import {
  isIssuedShellAllowRuleDecision,
  type PermissionCheckContext,
  type PermissionCheckResult,
} from "../permissions/permission-manager.js";
import { isHostApprovalRejectedDecision, type ApprovalDecision } from "../permissions/approval-gate.js";
import type { PermissionEvaluationContext } from "../permissions/evaluation-context.js";
import type {
  HostShellExecutionPlan,
  HostShellExecutionPlanAuditProjection,
} from "../permissions/host-shell-execution-plan.js";
import type { DisposablePathPolicyRelaxation } from "../permissions/execution-router.js";
import type { HostShellExecutionPermitBinding } from "../permissions/host-shell-execution-permit.js";
import { recordHostShellPolicyAuthorization, resolveHostShellWorkingDirectory } from "../permissions/host-shell-execution-permit.js";
import {
  disposableContainerCapability,
  resolveReviewerSandboxCapability,
} from "../permissions/sandbox-capability.js";
import { resolveOwnerPluginSandboxRoot } from "../plugins/plugin-storage-layout.js";
import { isCanonicalBashTool, isCanonicalPowerShellTool } from "./shell-tools.js";
import { preparedShellFacts, type PreparedShellInvocation } from "./prepared-shell-invocation.js";
import { isCanonicalTerminalRunTool, terminalCommandScopeOf, type HostTerminalCommandScope } from "./terminal-run.js";
import { scopedRuleSubjectFor } from "./pipeline/scoped-rule-subject.js";
import { classifyApprovalRuleVerdict } from "./pipeline/approval-memory-skip.js";
import { hostTerminalApprovalFacts } from "./pipeline/host-terminal-approval.js";
import {
  isRemoteControllerAuthorityCurrent,
  remoteControllerOriginOf,
} from "../shared/chat-origin.js";
import type { ApprovalPurposeSuggestion } from "../shared/permission-review-status.js";
import { t } from "../i18n/index.js";
import { approvalFailureOutcome } from "./pipeline/approval-outcome.js";
import { createLogger } from "../lib/logger.js";
import {
  hookChainFromDispatch } from "./pipeline/audit-entries.js";
import {
  emitPermissionReview,
  emitToolStart } from "./pipeline/display-mask.js";
import { maybeMaterializeRationaleControl } from "./pipeline/rationale-orchestrator.js";
import {
  authorizeRationaleResume,
  prepareRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import {
  dispatchReviewerForHeadless as dispatchReviewerForHeadlessImpl,
  dispatchReviewerForInteractiveAuto as dispatchReviewerForInteractiveAutoImpl,
  dispatchReviewerForRationale,
  reviewerInvocationId,
} from "./pipeline/reviewer-dispatch.js";
import { returnUserAbort, type UserAbortDeps,
} from "./pipeline/invocation-context.js";
import {
  runScriptHook,
  type InvocationRunnerServices,
} from "./invocation-services.js";
import type { AuditWriter } from "./pipeline/audit-writer.js";
import type {
  ToolCallMeta,
  ToolExecutorCallbacks,
  ToolPermissionContext,
  ToolResult,
  ToolUseBlock,
} from "./executor-contract.js";
import type {
  RationaleBatchExecutionContext,
  RationaleRequiredExecuteOneOutcome,
  RationaleResumeExecutionContext,
} from "./invocation-runner.js";
import type { ResolvedPluginOperation } from "./plugin-operation-governance.js";
import type { PluginOperationPrincipal } from "../permissions/plugin-operation-grant.js";
import { errorMessage } from "../shared/error-message.js";
import { NO_APPROVER_MESSAGE, type PermissionDecisionRequest } from "../permissions/decision-pipeline.js";
import { issueAuthorizationRequiredControl } from "../shared/authorization-required.js";

const log = createLogger("executor");

type AuditToolCall = (...args: Parameters<AuditWriter["auditToolCall"]>) => Promise<void>;
type AuditPermissionAsk = (
  ...args: Parameters<AuditWriter["auditPermissionAsk"]>
) => Promise<void>;

export interface AuthorizationStageContext {
  services: InvocationRunnerServices;
  tool: Tool;
  toolUse: ToolUseBlock;
  source: ToolSource;
  trust: TrustLevel;
  invocationCategory: ToolCategory;
  approvalReasonPrefix: string | undefined;
  overlayTriggerOrigin: string | null | undefined;
  hostShellRequiresExplicitApproval: boolean;
  hostShellExecutionPlan: HostShellExecutionPlan | undefined;
  verifiedShellCommand?: import("../permissions/verified-shell-command.js").VerifiedShellCommand;
  preparedShellInvocation?: PreparedShellInvocation;
  hostShellExecutionPlanAudit:
    | HostShellExecutionPlanAuditProjection | undefined;
  // Relaxations of the selected execution-route plan (execution-router).
  hostShellPathPolicyRelaxations: readonly DisposablePathPolicyRelaxation[] | undefined;
  hostShellExecutionPermitBinding: HostShellExecutionPermitBinding | undefined;
  hostShellApprovalDecision: ApprovalDecision | undefined;
  finalInput: Record<string, unknown>;
  invocationAllowedScope: { directories: string[] };
  sensitivePathPattern: string | null;
  invocationPermissionContext: ToolPermissionContext;
  evaluationContext: PermissionEvaluationContext;
  callbacks: ToolExecutorCallbacks | undefined;
  meta: ToolCallMeta;
  approvalPurpose: ApprovalPurposeSuggestion | undefined;
  auditInput: Record<string, unknown>;
  abortSignal: AbortSignal | undefined;
  rationaleResumeContext: RationaleResumeExecutionContext | undefined;
  rationaleBatchContext: RationaleBatchExecutionContext | undefined;
  targetFilePath: string | undefined;
  canonicalTargets: Array<{ filePath: string; canonicalPath: string }>;
  approvalCacheKey: string | undefined;
  executionCwd: string;
  auditCurrentToolCall: AuditToolCall;
  hasRecordedDenial?: () => boolean;
  auditCurrentPermissionAsk: AuditPermissionAsk;
  withHostShellExecutionPlan: (result: ToolResult) => ToolResult;
  abortDeps: (input: Record<string, unknown>) => UserAbortDeps;
  returnRationaleResumeBlock: (
    reason: string,
    input: Record<string, unknown>,
    blockedPermission?: PermissionCheckResult,
    hookChain?: import("../audit/audit-schema.js").HookResult[],
  ) => Promise<ToolResult>;
  sessionId: string | undefined;
  startTime: number;
  fileWritePolicy?: PermissionCheckContext["fileWritePolicy"];
  floor?: PermissionDecisionRequest["floor"];
  admissionDenial?: PermissionDecisionRequest["admissionDenial"];
  paths?: PermissionDecisionRequest["paths"];
  secretRead?: boolean;
  shellReadOnlyProven?: boolean;
  shellEscalated?: boolean;
  directoryAuthorization?: { permission: PermissionCheckResult; humanApproved: boolean; pendingRationale?: true; requestHumanApproval?: (input: { requestId: string; abortSignal?: AbortSignal }) => Promise<import("../permissions/approval-gate.js").ApprovalDecision> };
  permissionResult: PermissionCheckResult | undefined;
  reviewedPermissionForCard?: PermissionCheckResult;
  cardRequestId?: string;
  onHumanDecision?: (decision: import("../permissions/approval-gate.js").ApprovalDecision) => void;
  resolvedPluginOperation: ResolvedPluginOperation | undefined;
  pluginOperationPrincipal: PluginOperationPrincipal | undefined;
}

export interface AuthorizedInvocation {
  outcome: "authorized";
  /** True only after this action consumed verified native human consent. */
  humanApproved: boolean;
  approvedPolicyEpoch?: string;
  permissionRecheckResult?: PermissionCheckResult;
  permissionResult: PermissionCheckResult | undefined;
  hostShellApprovalDecision: ApprovalDecision | undefined;
  /** Host-issued allow-rule decision that authorized an explicit host shell. */
  hostShellAllowRuleDecision: PermissionCheckResult | undefined;
}

export async function authorizeToolInvocation(
  context: AuthorizationStageContext,
): Promise<
  AuthorizedInvocation | ToolResult | RationaleRequiredExecuteOneOutcome
> {
  const {
    services,
    tool,
    toolUse,
    source,
    trust,
    invocationCategory,
    approvalReasonPrefix,
    overlayTriggerOrigin,
    hostShellRequiresExplicitApproval,
    hostShellExecutionPlan,
    verifiedShellCommand,
    preparedShellInvocation,
    hostShellExecutionPlanAudit,
    hostShellPathPolicyRelaxations,
    hostShellExecutionPermitBinding,
    finalInput,
    invocationAllowedScope,
    sensitivePathPattern,
    invocationPermissionContext,
    evaluationContext,
    callbacks,
    meta,
    approvalPurpose,
    auditInput,
    abortSignal,
    rationaleResumeContext,
    rationaleBatchContext,
    targetFilePath,
    canonicalTargets,
    approvalCacheKey,
    executionCwd,
    auditCurrentToolCall,
    auditCurrentPermissionAsk,
    withHostShellExecutionPlan,
    abortDeps,
    returnRationaleResumeBlock,
    sessionId,
    startTime,
  } = context;
  let { permissionResult, hostShellApprovalDecision } = context;
  // The directory lane has already consumed this exact invocation's central
  // policy and, when required, its human card. Carry that authority once.
  let humanApproved = context.directoryAuthorization?.humanApproved ?? false;
  let approvedPolicyEpoch = humanApproved ? services.permissionManager?.getPolicyEpoch() : undefined;
  let permissionRecheckResult: PermissionCheckResult | undefined;
  if (context.directoryAuthorization !== undefined) {
    if (rationaleResumeContext !== undefined && !context.directoryAuthorization.pendingRationale) {
      return returnRationaleResumeBlock("Directory authorization cannot resume a sealed rationale action", finalInput, context.directoryAuthorization.permission);
    }
    if (context.directoryAuthorization.permission.decision !== "allow" && !context.directoryAuthorization.pendingRationale) {
      throw new Error("Directory authorization requires an allow decision");
    }
    permissionResult = context.directoryAuthorization.permission;
  }
  // The PermissionManager's own layer-3 allow-rule decision that authorized an
  // explicit host request, carried by identity to the permit mint.
  let hostShellAllowRuleDecision: PermissionCheckResult | undefined;

  const returnAuthorizationRequired = async (
    blockedPermission: PermissionCheckResult,
  ): Promise<ToolResult> => {
    if (abortSignal?.aborted) {
      return withHostShellExecutionPlan(
        await returnUserAbort(abortDeps(finalInput)),
      );
    }
    try {
      await auditCurrentPermissionAsk(
        toolUse.name,
        source,
        invocationCategory,
        finalInput,
        blockedPermission,
        executionCwd,
        invocationPermissionContext,
        targetFilePath,
      );
    } catch (error) {
      log.warn(
        "authorization-required permission ask audit failed: %s",
        errorMessage(error),
      );
    }
    const hostExecution = hostShellRequiresExplicitApproval;
    const message = NO_APPROVER_MESSAGE;
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(
      toolUse.name,
      message,
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
      message,
      true,
      startTime,
      {
        ...blockedPermission,
        decision: "deny",
        reason: NO_APPROVER_MESSAGE,
      },
      Infinity,
      invocationPermissionContext,
      invocationCategory,
      executionCwd,
    );
    return withHostShellExecutionPlan({
      tool_use_id: toolUse.id,
      content: message,
      is_error: true,
      authorizationRequired: issueAuthorizationRequiredControl({
        kind: hostExecution ? "host-execution" : "tool",
        toolName: toolUse.name,
        source,
        category: invocationCategory,
        reason: hostExecution
          ? "host-execution-authorization-required"
          : "approval-surface-unavailable",
        ...(hostShellExecutionPlanAudit &&
            invocationPermissionContext.disposableSubstrate === undefined
          ? { executionPlan: hostShellExecutionPlanAudit }
          : {}),
      }),
      durationMs,
    });
  };

  // Normalize host facts before the shared policy decision.
  const metaOverride = source === "builtin" && tool.category === "meta"
    ? tool.decisionOverride
    : undefined;
  const requiresRemoteLocalOneShot =
    invocationPermissionContext.remoteControllerAuthority !== undefined;
  const remoteControllerOrigin = remoteControllerOriginOf(
    invocationPermissionContext.remoteControllerAuthority,
  );
  const terminalScope = isCanonicalTerminalRunTool(tool)
    ? terminalCommandScopeOf(invocationPermissionContext.approvalMemory)
    : undefined;
  const hostTerminalScope: HostTerminalCommandScope | undefined = terminalScope?.lane === "manual" ? terminalScope : undefined;
  const otherPrincipal = invocationPermissionContext.otherPrincipal === true || approvalReasonPrefix !== undefined ||
    requiresRemoteLocalOneShot;
  const floor = context.floor ?? (otherPrincipal ? {
    code: "other-principal" as const,
    reason: "another principal's request requires local allow-once approval",
  } : undefined);
  if (context.directoryAuthorization === undefined || context.directoryAuthorization.pendingRationale) {
    const shellDialect = isCanonicalBashTool(tool)
      ? "bash" as const
      : isCanonicalPowerShellTool(tool) ? "powershell" as const : undefined;
    // A command typed into the user's terminal is judged as a bash command
    // in the directory that terminal's shell reported — the one sealed into
    // its approval scope before this decision (terminal-run.ts). Only zsh and
    // bash terminals are typed into, and the command text refuses everything
    // they read differently from bash (terminal-command-text.ts), so the words
    // the rules match are the words the shell runs.
    const shellRuleSubject = shellDialect !== undefined && typeof finalInput.command === "string"
      ? {
          kind: "shell" as const,
          dialect: shellDialect,
          command: finalInput.command,
          cwd: resolveHostShellWorkingDirectory(
            executionCwd,
            typeof finalInput.cwd === "string" && finalInput.cwd.length > 0 ? finalInput.cwd : undefined,
          ),
        }
      : terminalScope !== undefined && typeof finalInput.command === "string"
        ? terminalScope.lane === "manual"
          // Evaluate the user's host shell in its OS-verified physical directory and its own rule namespace.
          ? { kind: "shell" as const, dialect: "bash" as const, command: finalInput.command, cwd: terminalScope.physicalCwd,
            hostTerminal: { shell: terminalScope.shell, cwd: terminalScope.physicalCwd } }
          : { kind: "shell" as const, dialect: "bash" as const, command: finalInput.command, cwd: terminalScope.cwd }
        : undefined;
    const shellExecution = shellDialect !== undefined && hostShellExecutionPlan !== undefined
      ? {
          runsSandboxed: isConfinedHostShellExecution(hostShellExecutionPlan, invocationPermissionContext.disposableSubstrate)
            || invocationPermissionContext.disposableSubstrate !== undefined,
          pathPolicyRelaxations: hostShellPathPolicyRelaxations ?? [],
          ...(shellDialect === "bash" && preparedShellInvocation !== undefined && hostShellExecutionPlan.substrate !== "mxc"
            && invocationPermissionContext.disposableSubstrate === undefined
            ? { environmentSnapshot: preparedShellFacts(preparedShellInvocation).environment } : {}),
        } : terminalScope !== undefined
          // The user's host terminal decides on its sealed host route's relaxations (none); the isolated terminal keeps its own.
          ? { runsSandboxed: false, ...(terminalScope.lane === "manual" ? { pathPolicyRelaxations: hostShellPathPolicyRelaxations ?? [] } : {}) }
          : undefined;
    const scopedSubjectCandidate = scopedRuleSubjectFor(tool, finalInput, executionCwd, canonicalTargets);
    // Guest file paths belong to the workload namespace, never to host Edit scopes.
    const scopedRuleSubject = scopedSubjectCandidate?.kind === "edit"
      && invocationPermissionContext.disposableSubstrate?.authority === "workload-broker"
      ? undefined : scopedSubjectCandidate;
    const projectRulesCwd = shellRuleSubject !== undefined ? shellRuleSubject.cwd : executionCwd;
    if (services.permissionManager && projectRulesCwd !== undefined) {
      await services.permissionManager.ensureProjectRulesLoaded(projectRulesCwd);
    }
    permissionResult = context.reviewedPermissionForCard !== undefined && services.permissionManager !== undefined
      ? services.permissionManager.recheckPermission(context.reviewedPermissionForCard)
      : context.directoryAuthorization?.pendingRationale
      ? context.directoryAuthorization.permission
      : services.permissionManager
      ? services.permissionManager.checkDetailed(
          toolUse.name,
          source,
          invocationCategory,
          overlayTriggerOrigin,
          {
            ...invocationPermissionContext,
            decisionOverride: metaOverride,
            fileWritePolicy: context.fileWritePolicy,
            floor,
            admissionDenial: context.admissionDenial,
            ...(hostTerminalScope ? { hostTerminalTurn: hostTerminalScope } : {}),
            userOwnedBrowser: userOwnedBrowserScopeOf(tool, invocationPermissionContext.approvalMemory),
            trustOrigin: invocationPermissionContext.trustOrigin,
            paths: context.paths,
            secretRead: context.secretRead,
            shellReadOnlyProven: context.shellReadOnlyProven,
            shellEscalated: context.shellEscalated,
            mcpReadOnlyHint: tool.mcpReadOnlyHint,
            ...(shellRuleSubject ? { ruleSubject: shellRuleSubject } : {}),
            ...(verifiedShellCommand ? { verifiedShellCommand } : {}),
            ...(hostShellExecutionPlan === undefined ? {} : { hostShellExecutionPlan }),
            ...(shellExecution === undefined ? {} : { shellExecution }),
            ...(sessionId !== undefined ? { sessionId } : {}),
            ...(scopedRuleSubject ? { ruleSubject: scopedRuleSubject } : {}),
            ...(projectRulesCwd !== undefined ? { projectRulesCwd } : {}),
          },
        )
      : {
          decision: "deny",
          reason: "Permission manager is unavailable",
          forceModal: true,
        };
    if (!permissionResult) {
      throw new Error("Permission evaluation returned no result");
    }
    // Retain the host-issued rule receipt where one exists. Other central
    // allows receive an exact live-action policy permit below.
    if (hostShellExecutionPlan?.executionRequest === "host" &&
        isIssuedShellAllowRuleDecision(permissionResult, services.permissionManager)) {
      hostShellAllowRuleDecision = permissionResult;
    }

    // #885 v6 (§5.3): the untrusted `tool.writesToOwnSandbox` self-claim is no
    // longer threaded to the reviewer — the auto-LOW keys solely on the
    // HOST-computed `ownerPluginSandboxRoot` + host-verified path containment.
    // A plugin whose data root is not the host's real directory gets no owner
    // sandbox, so no auto-LOW: the stricter path.
    const ownerPluginSandboxRoot = tool.pluginId ? resolveOwnerPluginSandboxRoot(tool.pluginId) : undefined;
    const sandboxAttestation = {
      ...(ownerPluginSandboxRoot !== undefined ? { ownerPluginSandboxRoot } : {}),
    };
    // Stored grants are stage-three evidence even when the initial mode path
    // has no human approver. The manager preserves admission, floor and ask
    // precedence when it incorporates a matching grant.
    const ordinaryRequest = permissionResult.pipelineRequest;
    if (permissionResult.decision !== "allow" && ordinaryRequest !== undefined && !ordinaryRequest.admissionDenial &&
        !ordinaryRequest.floor && ordinaryRequest.rules?.deny === undefined && ordinaryRequest.rules?.ask === undefined &&
        ordinaryRequest.manualRerun !== true && context.reviewedPermissionForCard === undefined && rationaleResumeContext === undefined &&
        rationaleBatchContext === undefined && services.permissionManager !== undefined) {
      const memorySkip = await services.tryUserApprovalMemorySkip(
        toolUse.name,
        source,
        invocationCategory,
        tool.pathFields ?? [],
        finalInput,
        executionCwd,
        invocationAllowedScope.directories,
        sensitivePathPattern ? [sensitivePathPattern] : [],
        invocationPermissionContext,
        approvalCacheKey,
        sandboxAttestation,
        reviewerInvocationId(meta),
        tool.mcpServerId,
        tool.workerId,
        tool.pluginId,
        hostShellExecutionPlan,
        auditInput,
        sessionId,
      );
      if (memorySkip) {
        permissionResult = services.permissionManager.resolveRememberedPermission(permissionResult, memorySkip.reason);
      }
    }
    if (
      permissionResult.decision === "ask" && rationaleResumeContext === undefined && permissionResult.reviewer?.verdict === undefined &&
      (permissionResult.reviewer?.route === "foreground-auto" ||
        rationaleBatchContext !== undefined && permissionResult.reviewer?.route === "headless")
    ) {
      const dispatchInitialReview = rationaleBatchContext !== undefined
        ? dispatchReviewerForRationale
        : dispatchReviewerForInteractiveAutoImpl;
      const reviewerResult = await dispatchInitialReview(
        services.permissionManager,
        toolUse.name,
        source,
        invocationCategory,
        tool.pathFields ?? [],
        finalInput,
        invocationAllowedScope.directories,
        sensitivePathPattern ? [sensitivePathPattern] : [],
        invocationPermissionContext,
        evaluationContext,
        // Issue #664 P1 — manifest-declared sandbox-write self-attestation
        // populated from the Tool descriptor. `ownerPluginSandboxRoot` is
        // computed only when the tool is plugin-owned; builtin / MCP tools
        // have no sandbox root and the auto-LOW rule will not engage.
        sandboxAttestation,
        callbacks,
        meta,
        approvalPurpose,
        hostShellExecutionPlan,
        abortSignal,
        auditInput,
        sessionId,
        permissionResult,
      );
      if (abortSignal?.aborted) {
        return withHostShellExecutionPlan(
          await returnUserAbort(abortDeps(finalInput)),
        );
      }
      if (reviewerResult) {
        permissionResult = reviewerResult;
      }
    }
    const needsRationaleSecurityContext =
      rationaleBatchContext !== undefined ||
      rationaleResumeContext !== undefined;
    const sandboxCapability = needsRationaleSecurityContext
      ? resolveReviewerSandboxCapability(
          source,
          toolUse.name,
          tool.mcpServerId,
          tool.workerId,
          tool.pluginId,
          hostShellExecutionPlan,
          invocationPermissionContext.disposableSubstrate,
        )
      : undefined;
    const sandboxExecutionPlan: Record<string, unknown> | undefined =
      sandboxCapability === undefined
        ? undefined
        : {
            // v2 adds the exact sealed host-shell plan to the canonical action
            // identity. A stale v1 rationale ticket therefore fails closed on
            // resume instead of authorizing a changed execution substrate.
            version:
              hostShellExecutionPlanAudit === undefined
                ? "rationale-sandbox-execution-plan/v1"
                : "rationale-sandbox-execution-plan/v2",
            executionCwd,
            allowedDirectories: [...invocationAllowedScope.directories],
            checkpointAvailable: permissionResult.pipelineRequest?.fileWrite?.checkpointAvailable === true,
            capability: {
              kind: sandboxCapability.kind,
              confidence: sandboxCapability.confidence,
              platform: sandboxCapability.platform,
              reason: sandboxCapability.reason,
              ...(sandboxCapability.confines === undefined
                ? {}
                : {
                    confines: {
                      filesystem: sandboxCapability.confines.filesystem,
                      process: sandboxCapability.confines.process,
                      network: sandboxCapability.confines.network,
                    },
                  }),
            },
            ...(hostShellExecutionPlanAudit === undefined
              ? {}
              : { hostShellExecutionPlan: hostShellExecutionPlanAudit }),
          };
    if (rationaleBatchContext && sandboxCapability && sandboxExecutionPlan) {
      const reviewedPermissionForCard = permissionResult;
      const rationaleControl = await maybeMaterializeRationaleControl(
        rationaleBatchContext.runtime,
        {
          batchId: rationaleBatchContext.batchId,
          originalToolUseIds: rationaleBatchContext.originalToolUseIds,
          completedToolUseIds: rationaleBatchContext.completedToolUseIds,
          toolUseId: toolUse.id,
          originalInput: toolUse.input,
          finalInput,
          toolName: toolUse.name,
          toolVersion: tool.version,
          source,
          category: invocationCategory,
          ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
          ...(tool.mcpServerId === undefined
            ? {}
            : { mcpServerId: tool.mcpServerId }),
          ...(tool.workerId === undefined ? {} : { workerId: tool.workerId }),
          invocationTrustOrigin: invocationPermissionContext.trustOrigin,
          canonicalTargets: canonicalTargets.map(
            (target) => target.canonicalPath,
          ),
          ...(approvalCacheKey === undefined ? {} : { approvalCacheKey }),
          recordTerminalDenial: async (reason) => {
            if (abortSignal?.aborted || context.hasRecordedDenial?.()) return;
            await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, reason, true,
              startTime, { ...reviewedPermissionForCard, decision: "deny", reason }, Infinity,
              invocationPermissionContext, invocationCategory, executionCwd);
          },
          requestHumanApproval: context.directoryAuthorization?.requestHumanApproval ?? (async ({ requestId, abortSignal: cardAbortSignal }) => {
            let humanDecision: import("../permissions/approval-gate.js").ApprovalDecision | undefined;
            const cardAuthorization = await authorizeToolInvocation({ ...context, directoryAuthorization: undefined,
              rationaleBatchContext: undefined, rationaleResumeContext: undefined,
              reviewedPermissionForCard, cardRequestId: requestId,
              ...(cardAbortSignal === undefined ? {} : { abortSignal: cardAbortSignal }),
              onHumanDecision: (decision) => { humanDecision = decision; },
            });
            if (humanDecision === undefined && "tool_use_id" in cardAuthorization && cardAuthorization.is_error === true) {
              throw new RationaleHumanApprovalDeniedError(cardAuthorization.content);
            }
            if (humanDecision === undefined) throw new Error("Approval did not produce an authenticated decision");
            return humanDecision;
          }),
          sandboxCapability,
          sandboxExecutionPlan,
          permission: permissionResult,
          eligibilityContext: {
            headless: invocationPermissionContext.headless === true,
            forceModal: permissionResult.forceModal === true,
            approvalReasonPrefix: approvalReasonPrefix ?? null,
          },
        },
      );
      if (rationaleControl) {
        return { outcome: "rationale-required", control: rationaleControl };
      }
    }
    // A high that cannot offer a model choice is finalized at the ordinary card boundary.
    if (rationaleResumeContext === undefined && sessionId !== undefined && permissionResult.reviewer?.verdict?.level === "high" &&
        permissionResult.reviewer.requestId !== undefined) {
      services.permissionManager?.resolveReviewerChoice(sessionId, permissionResult.reviewer.requestId, "deny");
    }
    if (rationaleResumeContext) {
      if (!sandboxCapability || !sandboxExecutionPlan) {
        return returnRationaleResumeBlock(
          "current sandbox capability could not be resolved",
          finalInput,
          permissionResult,
        );
      }
      const prepared = await prepareRationaleResume(
        rationaleResumeContext.request,
        {
          finalInput,
          toolName: toolUse.name,
          toolVersion: tool.version,
          source,
          category: invocationCategory,
          ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
          ...(tool.mcpServerId === undefined
            ? {}
            : { mcpServerId: tool.mcpServerId }),
          ...(tool.workerId === undefined ? {} : { workerId: tool.workerId }),
          invocationTrustOrigin: invocationPermissionContext.trustOrigin,
          canonicalTargets: canonicalTargets.map(
            (target) => target.canonicalPath,
          ),
          ...(approvalCacheKey === undefined ? {} : { approvalCacheKey }),
          sandboxCapability,
          sandboxExecutionPlan,
          permission: permissionResult,
          eligibilityContext: {
            headless: invocationPermissionContext.headless === true,
            forceModal: permissionResult.forceModal === true,
            approvalReasonPrefix: approvalReasonPrefix ?? null,
          },
        },
        rationaleResumeContext.runtime,
      );
      if (!prepared.ok) {
        return returnRationaleResumeBlock(
          prepared.reason,
          finalInput,
          permissionResult,
        );
      }
      rationaleResumeContext.prepared = prepared.value;
    }
    if (permissionResult.decision === "deny") {
      if (permissionResult.reasonCode === "no-approver" && invocationPermissionContext.headless !== true &&
          invocationPermissionContext.approvalSurface === "unavailable") {
        return returnAuthorizationRequired(permissionResult);
      }
      const msg = t("be_executor.permBlockDeny", {
        name: toolUse.name,
        source,
        trust,
        reason: permissionResult.reason,
      });
      const durationMs = Date.now() - startTime;
      // Use finalInput (post-PreToolUse hook) so audit/UI never show stale
      // pre-hook args for a hook-modified invocation.
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
        permissionResult,
        Infinity,
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
    if (permissionResult.decision === "ask" && !rationaleResumeContext?.prepared) {
      if (invocationPermissionContext.headless === true || permissionResult.reviewer?.route === "headless") {
        const headlessReviewerRoute =
          permissionResult.reviewer?.route === "headless";
        if (!headlessReviewerRoute) {
          const headlessDeny: PermissionCheckResult = {
            decision: "deny",
            reason: NO_APPROVER_MESSAGE,
            };
          const msg = t("be_executor.permBlockHeadlessDeny", {
            name: toolUse.name,
            source,
            reason: headlessDeny.reason,
          });
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
            headlessDeny,
            Infinity,
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
        const reviewerResult = await dispatchReviewerForHeadlessImpl(
          services.permissionManager,
          toolUse.name,
          source,
          invocationCategory,
          tool.pathFields ?? [],
          finalInput,
          invocationAllowedScope.directories,
          sensitivePathPattern ? [sensitivePathPattern] : [],
          invocationPermissionContext,
          evaluationContext,
          // Issue #664 P1 — sandbox-write attestation (see interactive
          // call site for rationale).
          sandboxAttestation,
          callbacks,
          meta,
          approvalPurpose,
          hostShellExecutionPlan,
          abortSignal,
          auditInput,
          sessionId,
          permissionResult,
        );
        if (abortSignal?.aborted) {
          return withHostShellExecutionPlan(
            await returnUserAbort(abortDeps(finalInput)),
          );
        }
        if (reviewerResult.allowed) {
          permissionResult = reviewerResult.permissionResult;
        } else {
          if (reviewerResult.permissionResult.reasonCode === "no-approver" && invocationPermissionContext.headless !== true &&
              invocationPermissionContext.approvalSurface === "unavailable") {
            return returnAuthorizationRequired(reviewerResult.permissionResult);
          }
          const msg = reviewerResult.message;
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
            reviewerResult.permissionResult,
            Infinity,
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
    }
    if (permissionResult.decision === "ask") {
      if (rationaleResumeContext?.prepared) {
        const permHook = await runScriptHook(
          services.scriptHookManager,
          "perm",
          toolUse.name,
          source,
          invocationCategory,
          finalInput,
          sessionId,
          invocationPermissionContext,
          tool.mcpServerId,
          tool.pluginId,
          undefined,
          undefined,
          tool.pluginGeneration !== undefined,
          abortSignal,
        );
        if (abortSignal?.aborted) return withHostShellExecutionPlan(await returnUserAbort(abortDeps(finalInput)));
        if (permHook.decision === "deny") {
          return returnRationaleResumeBlock(
            "permission-request hook denied the sealed action: " +
              permHook.reason,
            finalInput,
            { ...permissionResult, decision: "deny", reason: permHook.reason },
            hookChainFromDispatch("perm", permHook),
          );
        }
        try {
          await auditCurrentPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
            finalInput,
            permissionResult,
            executionCwd,
            invocationPermissionContext,
            targetFilePath,
          );
        } catch (error) {
          return returnRationaleResumeBlock(
            "permission ask audit failed: " +
              errorMessage(error),
            finalInput,
            permissionResult,
          );
        }
        if (abortSignal?.aborted) {
          return returnRationaleResumeBlock(
            "resume was aborted before allow-once receipt consumption",
            finalInput,
            permissionResult,
          );
        }
        const authorized = await authorizeRationaleResume(
          rationaleResumeContext.prepared,
        );
        if (!authorized.ok) {
          return returnRationaleResumeBlock(
            authorized.reason,
            finalInput,
            permissionResult,
          );
        }
        rationaleResumeContext.authorized = authorized.value;
        permissionRecheckResult = permissionResult;
        permissionResult = {
          ...permissionResult,
          decision: "allow",
          reason: "host-authentic rationale allow-once receipt consumed",
          };
      } else if (invocationPermissionContext.approvalSurface === "unavailable") {
        return returnAuthorizationRequired(permissionResult);
      } else if (services.approvalGate) {
        const hostTerminalFacts = hostTerminalApprovalFacts(tool, invocationPermissionContext.approvalMemory, finalInput.command);
        const approvalRuleAssessment = permissionResult.reviewer?.verdict === undefined && permissionResult.forceModal !== true && !permissionResult.pipelineRequest?.userOwnedSurface
          ? classifyApprovalRuleVerdict({
            toolName: toolUse.name,
            source,
            category: invocationCategory,
            pathFields: tool.pathFields ?? [],
            finalInput,
            approvalCacheKey,
            executionCwd,
            allowedDirectories: invocationAllowedScope.directories,
            sensitivePathsAdjacent: sensitivePathPattern ? [sensitivePathPattern] : [],
            context: invocationPermissionContext,
            sandboxAttestation,
            mcpServerId: tool.mcpServerId,
            workerId: tool.workerId,
            pluginId: tool.pluginId,
            hostShellExecutionPlan,
            ...(hostTerminalFacts.sandboxCapability ? { sandboxCapability: hostTerminalFacts.sandboxCapability } : {}),
          }) : undefined;
        const approvalPolicyEpoch = services.permissionManager?.getPolicyEpoch();
        const approvalRequest = {
          id: context.cardRequestId ?? randomUUID(),
          ...(permissionResult.forceModal === true
            ? {
                // Forced floors consume consent for this invocation only.
                allowedChoices: ["allow-once", "deny-once"] as const,
                durableApprovalRecordAllowed: false as const,
                forceExplicit: true as const,
              }
            : {}),
          ...(hostShellExecutionPermitBinding === undefined ? {} : { hostShellExecutionPermitBinding }),
          // A guest-routed shell shows the substrate the reviewer graded, not
          // the host plan of a child that never spawns.
          ...(hostShellExecutionPlanAudit === undefined
            ? {}
            : invocationPermissionContext.disposableSubstrate === undefined
              ? { executionPlan: hostShellExecutionPlanAudit }
              : {
                  sandboxCapability: disposableContainerCapability(
                    invocationPermissionContext.disposableSubstrate,
                  ),
                }),
          category: "tool" as const,
          ownerUnattended: invocationPermissionContext.ownerUnattended === true,
          toolName: toolUse.name,
          toolCategory: invocationCategory,
          // Attribute the modal and every audit row to the conversation whose
          // turn is blocked on it. Sub-agents and side chats reach this line
          // with their own session id.
          ...(sessionId === undefined ? {} : { sessionId }),
          // Host-only; the gate keeps it out of the renderer payload.
          ...(remoteControllerOrigin === undefined
            ? {}
            : { remoteControllerOrigin }),
          ...(invocationPermissionContext.remoteControllerAuthority === undefined
            ? {}
            : { remoteControllerAuthority: invocationPermissionContext.remoteControllerAuthority }),
          reviewerVerdict: permissionResult.reviewer?.verdict,
          ...(approvalRuleAssessment ? { ruleVerdict: approvalRuleAssessment.verdict, approvalRuleBasis: approvalRuleAssessment.basis } : {}),
          reviewerOutcome: permissionResult.reviewer?.outcome,
          reviewerApprovalBasis: permissionResult.reviewer?.approvalBasis,
          // Hard policy/A2A asks are per invocation. A reviewer failure alone
          // remains an ordinary human decision that may be remembered exactly.
          ...(permissionResult.forceModal === true
            ? { durableApprovalRecordAllowed: false as const } : {}),
          ...(approvalPurpose ? { approvalPurpose } : {}),
          args: finalInput,
          reason: approvalReasonPrefix
            ? `${approvalReasonPrefix} ${permissionResult.reason}`
            : permissionResult.reason,
          // Preserve the originating principal separately from display text.
          ...(approvalReasonPrefix ? { approvalReasonPrefix } : {}),
          source: source as ToolSource,
          createdAt: Date.now(),
          ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
          sensitivePathPattern,
          trustOrigin: invocationPermissionContext.trustOrigin,
          // Propagate approvalCacheKey so renderer record key
          // matches dispatchReviewer lookup key — end-to-end symmetry.
          ...(approvalCacheKey ? { approvalCacheKey } : {}),
          ...(invocationPermissionContext.approvalMemory
            ? { approvalMemory: invocationPermissionContext.approvalMemory }
            : {}),
          // Canonical host shells expose only their sealed safe projection;
          // non-host-shell routes retain their existing capability display.
          ...(hostShellExecutionPlanAudit === undefined
            ? {
                sandboxCapability: resolveReviewerSandboxCapability(
                  source,
                  toolUse.name,
                  tool.mcpServerId,
                  tool.workerId,
                  tool.pluginId,
                  undefined,
                  invocationPermissionContext.disposableSubstrate,
                ),
              }
            : {}),
          ...hostTerminalFacts,
          ...userOwnedSurfaceCardFacts(permissionResult),
          evaluationContext,
        };

        const permHook = await runScriptHook(
          services.scriptHookManager,
          "perm",
          toolUse.name,
          source,
          invocationCategory,
          finalInput,
          sessionId,
          invocationPermissionContext,
          tool.mcpServerId,
          tool.pluginId,
          undefined,
          undefined,
          tool.pluginGeneration !== undefined,
          abortSignal,
        );
        if (abortSignal?.aborted) return withHostShellExecutionPlan(await returnUserAbort(abortDeps(finalInput)));
        if (permHook.decision === "deny") {
          const msg = t("be_executor.hookPermissionBlock", {
            reason: permHook.reason,
          });
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
            { ...permissionResult, decision: "deny", reason: permHook.reason },
            Infinity,
            invocationPermissionContext,
            invocationCategory,
            executionCwd,
            undefined,
            undefined,
            hookChainFromDispatch("perm", permHook),
          );
          return withHostShellExecutionPlan({
            tool_use_id: toolUse.id,
            content: msg,
            is_error: true,
            durationMs,
          });
        }

        // A remote-controller turn blocks here for up to the approval timeout,
        // and its layer-2 verdict carries no `reviewer`, so the reviewer-dispatch
        // path that normally emits this never runs. Without it the paired
        // surface sees `working` and then, minutes later, a failure — silence
        // that reads as a dead bridge rather than as waiting for the desk.
        //
        // The platform projector maps `needs_approval` to
        // `approval.waiting-local` carrying only a coarse grammar-checked tool
        // identifier and discards every other field, so this adds no egress
        // beyond that one status plus the tool name.
        if (requiresRemoteLocalOneShot) {
          emitPermissionReview(callbacks, {
            status: "needs_approval",
            toolName: toolUse.name,
            toolCategory: invocationCategory,
            source: source as ToolSource,
            ...meta,
          });
        }

        // §F3: requestAndWait 실패 시 감사 로그 보장 후 deny-once 처리
        let decision;
        try {
          await auditCurrentPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
            finalInput,
            permissionResult,
            executionCwd,
            invocationPermissionContext,
            targetFilePath,
          );
          if (abortSignal?.aborted) {
            return withHostShellExecutionPlan(
              await returnUserAbort(abortDeps(finalInput)),
            );
          }
          decision = await services.approvalGate.requestAndWait({
            ...(verifiedShellCommand ? { verifiedShellCommand } : {}),
            ...approvalRequest,
            // The other half of the abort check just above. That one refuses
            // to open a dialog for a turn already stopped; this one is what
            // lets the gate stop waiting when the stop arrives afterwards,
            // instead of holding the turn's lease until its own timer expires.
            ...(abortSignal === undefined ? {} : { abortSignal }),
          });
          if (hostShellExecutionPermitBinding !== undefined) {
            hostShellApprovalDecision = decision;
          }
        } catch (approvalErr) {
          const msg = t("be_executor.approvalGateError", {
            name: toolUse.name,
            error:
              errorMessage(approvalErr),
          });
          const durationMs = Date.now() - startTime;
          // finalInput keeps audit/UI consistent with the args shown to the
          // approval gate (which already uses finalInput in approvalRequest).
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
            {
              ...permissionResult,
              decision: "deny",
              reason: `approval gate error: ${errorMessage(approvalErr)}`,
            },
            Infinity,
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


        // A turn the user stopped did not deny anything. The gate answers
        // deny-once when it unparks on the abort, which is the correct
        // fail-closed permission answer, but recording it as the outcome would
        // put the owner refusing this specific call into the transcript.
        // Report the stop, exactly as the pre-ask check above does.
        if (abortSignal?.aborted) {
          return withHostShellExecutionPlan(
            await returnUserAbort(abortDeps(finalInput)),
          );
        }

        // This is intentionally immediately after the local decision. A P2
        // share revoke that won while the modal was visible must beat the
        // newly returned allow-once before it can reach the execution stage.
        const approvalInvalidationReason = services.permissionManager !== undefined &&
            approvalPolicyEpoch !== services.permissionManager.getPolicyEpoch() &&
            !services.approvalGate.allowsPolicyTransition(decision, approvalPolicyEpoch!, services.permissionManager.getPolicyEpoch())
          ? "Permission policy changed while approval was pending"
          : !isRemoteControllerAuthorityCurrent(invocationPermissionContext.remoteControllerAuthority)
            ? "remote-controller-revoked" : undefined;
        if (approvalInvalidationReason !== undefined) {
          const reason = approvalInvalidationReason;
          const msg = t("be_executor.permBlockDeny", {
            name: toolUse.name,
            source,
            trust,
            reason,
          });
          const durationMs = Date.now() - startTime;
          const revokedPermission: PermissionCheckResult = {
            decision: "deny",
            reason,
            };
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, revokedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return withHostShellExecutionPlan({
            tool_use_id: toolUse.id,
            content: msg,
            is_error: true,
            durationMs,
          });
        }
        const surfaceResolution = services.permissionManager ? await resolveUserOwnedSurfaceApproval({
          manager: services.permissionManager, gate: services.approvalGate, permission: permissionResult, decision,
          request: { ...approvalRequest, abortSignal }, sessionId,
          review: async permission => await dispatchReviewerForInteractiveAutoImpl(services.permissionManager, toolUse.name, source, invocationCategory, tool.pathFields ?? [], finalInput, invocationAllowedScope.directories, sensitivePathPattern ? [sensitivePathPattern] : [], invocationPermissionContext, evaluationContext, sandboxAttestation, callbacks, meta, approvalPurpose, hostShellExecutionPlan, abortSignal, auditInput, sessionId, permission) ?? permission,
        }) : { permission: permissionResult, decision, humanApproved: undefined };
        permissionResult = surfaceResolution.permission;
        decision = surfaceResolution.decision;
        context.onHumanDecision?.(decision);
        const manuallyApproved = decision.choice.startsWith("allow") &&
          !isHostApprovalRejectedDecision(decision);

        const remoteOneShotRejected =
          requiresRemoteLocalOneShot && decision.choice !== "allow-once";
        if (decision.choice.startsWith("deny") || remoteOneShotRejected) {
          // deny-always: 영구 거부 규칙 추가
          if (
            !requiresRemoteLocalOneShot &&
            decision.choice === "deny-always" &&
            services.permissionManager
          ) {
            const pattern =
              approvalCacheKey ?? decision.rememberPattern ?? toolUse.name;
            await services.permissionManager.addAlwaysDeniedPersist(pattern);
          }
          const hostFailure = approvalFailureOutcome(
            decision, toolUse.name, permissionResult,
          );
          const msg = hostFailure?.content ?? (permissionResult.decision === "deny" ? permissionResult.reason : t("be_executor.approvalDeniedByUser", {
            name: toolUse.name,
          }));
          const durationMs = Date.now() - startTime;
          // finalInput matches the args the user actually saw + denied via
          // approvalRequest — never log stale pre-hook input here.
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
            hostFailure?.permission ?? (permissionResult.decision === "deny" ? permissionResult : {
              ...permissionResult,
              decision: "deny",
              reason: "user denied approval request",
            }),
            Infinity,
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

        // `allow-always` for a normal approval card is already recorded as an
        // exact tuple in Store B before the gate resolves. Do not also create a
        // glob-matched Store A rule from a tool name or cache key: that would
        // silently widen "this tool + this input" into tool-wide permission.
        // Out-of-directory approvals are handled earlier by invocation-runner
        // and retain their explicit reviewed-parent persistence contract.
        humanApproved = surfaceResolution.humanApproved ?? manuallyApproved;
        approvedPolicyEpoch = services.permissionManager?.getPolicyEpoch();
        if (humanApproved) permissionResult = {
          ...permissionResult,
          decision: "allow",
          reason: `user approved approval request (${decision.choice})`,
          };
        // allow-once / allow-always: 실행 계속
      } else {
        // §F4: approvalGate 미연결 시 fail-closed — 모든 ask 결정을 차단
        const msg = t("be_executor.approvalGateMissing", {
          name: toolUse.name,
          source,
          reason: permissionResult.reason,
        });
        const durationMs = Date.now() - startTime;
        log.error(msg);
        // finalInput so audit reflects post-hook args even when the gate is
        // unavailable.
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
          {
            ...permissionResult,
            decision: "deny",
            reason: `approval gate missing: ${permissionResult.reason}`,
          },
          Infinity,
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
  }

  if (rationaleResumeContext && !rationaleResumeContext.authorized) {
    return returnRationaleResumeBlock(
      "current permission path did not produce an eligible sealed resume authorization",
      finalInput,
      permissionResult,
    );
  }

  const ruleProofStands = hostShellAllowRuleDecision !== undefined && permissionResult === hostShellAllowRuleDecision;
  if (hostShellExecutionPermitBinding !== undefined &&
      hostShellApprovalDecision === undefined && !ruleProofStands &&
      permissionResult?.decision === "allow") {
    recordHostShellPolicyAuthorization(hostShellExecutionPermitBinding);
  }

  return {
    outcome: "authorized",
    humanApproved,
    approvedPolicyEpoch,
    permissionRecheckResult,
    permissionResult,
    hostShellApprovalDecision,
    // Only while no later lane replaced the rule decision: a reviewer, hook or
    // approval that rewrote it owns the outcome instead.
    hostShellAllowRuleDecision: permissionResult === hostShellAllowRuleDecision
      ? hostShellAllowRuleDecision
      : undefined,
  };
}
