import { issueReplayRootBinding } from "../permissions/reviewer/replay-root-binding.js";
import { makeRecentlyDeniedInvocationRef } from "../permissions/reviewer/recently-denied-replay.js";
import { sandboxBlockForResult } from "../shared/sandbox-block.js";
import { isAbsolute } from "node:path";
import { expandLeadingTilde } from "../shared/home-tilde.js";
import { selectDeclaredPathValues } from "../shared/dotted-field-value.js";
import { isConfinedHostShellExecution } from "../permissions/host-shell-execution-plan.js";
import { dispatchReviewerForHeadless, dispatchReviewerForInteractiveAuto } from "./pipeline/reviewer-dispatch.js";
import { criticalDeleteTargetFor } from "../permissions/sensitive-paths.js";
import { hookChainFromDispatch } from "./pipeline/audit-entries.js";
import { runScriptHook } from "./invocation-services.js";
import { isCodeCheckpointAvailable, withRequiredCodeCheckpoint } from "../memory/code-checkpoints.js";
import { resolveToolPathForPermission } from "../shared/tool-path-resolution.js";
import { areProjectWriteTargetsInside } from "./project-write-scope.js";
import { prepareVerifiedShellCommand, type VerifiedShellCommand } from "../permissions/verified-shell-command.js";
import { isPowerShellStartupPinned } from "../shared/powershell-startup-policy.js";
import { prepareShellInvocation, preparedShellFacts, bindPreparedShellExecutableReadPaths, disposePreparedShellInvocation, type PreparedShellInvocation } from "./prepared-shell-invocation.js";
import { resolveHostShellWorkingDirectory } from "../permissions/host-shell-execution-permit.js";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import type { Tool } from "./base.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import { isModelExposedTool } from "./base.js";
import {
  isCanonicalBashTool,
  isCanonicalBrokerLifecycleTool,
  isCanonicalPowerShellTool,
  findPowerShellCommandPathViolation,
  validatePowerShellCommandStructure,
} from "./shell-tools.js";
import { isCanonicalTerminalRunTool, terminalCommandScopeOf } from "./terminal-run.js";
import {
  isCanonicalFileTool,
  normalizeCanonicalFileToolInput,
  withProjectWriteRoots,
  isFileCopyCheckpointSupported,
} from "./file-tools.js";
import { extractShellCommands } from "../shared/shell-command-fields.js";
import type { ShellPathPolicyViolation } from "./shell-path-policy.js";
// Effective invocation-origin SoT (AsyncLocalStorage). The plugin-surface executor
// enters a `runWithInvocationOrigin` frame for every card/panel/plugin call, so this
// is defined ("mcp-app" | "ui" | "plugin") ONLY on that path; the model's main-loop
// executor runs in no frame → `undefined`. That is the one signal separating a
// governed card/panel invocation from the model lane. Leaf module (imports
// only node:async_hooks) — no cycle.
import { currentInvocationOrigin } from "../plugins/runtime/origin-chain.js";
import type {
  ToolSource,
  TrustLevel,
  ToolCategory,
} from "./types.js";
import { trustFromSource } from "./types.js";
import { PermissionManager, isTailnetControllerP1BlockedTool, requiredTier, type PermissionCheckResult } from "../permissions/permission-manager.js";
import {
  isRemoteControllerAuthorityCurrent,
  remoteControllerOriginOf,
} from "../shared/chat-origin.js";
import type { ApprovalDecision } from "../permissions/approval-gate.js";
import { approvalFailureOutcome } from "./pipeline/approval-outcome.js";
import {
  buildPermissionEvaluationContext,
  type PermissionEvaluationContext,
} from "../permissions/evaluation-context.js";
import { canonicalizePathForMatch, caseFoldForMatch, foldCanonicalPathSeparators } from "../permissions/sensitive-paths.js";
import { resolveShellFilesystemPath } from "../shared/shell-filesystem-path.js";
import {
  sanitizeAllowedDirectories,
  buildAllowedScope,
  buildRuntimeAllowedDirectories,
  isFilesystemRootPath,
  pickClosestParent,
  validateDirectoryAddition,
} from "../permissions/allowed-directories.js";
import {
  dispatchPermissionDirCommand,
  type PermissionDirectoryLifecycle,
} from "../permissions/permission-slash.js";
import type { HookResult, ToolExecutionAuditMetadata } from "../audit/audit-schema.js";
import type { EffectLedger } from "../permissions/effect-ledger.js";
import { currentToolExecutionCwd } from "./execution-context.js";
import { withShellSessionCwd } from "./shell-session-cwd.js";
import {
  getHostShellExecutionPlan,
  resolveReviewerSandboxCapability,
  type DisposableSubstrate,
} from "../permissions/sandbox-capability.js";
import {
  getHostShellExecutionPlanAuditProjection,
  parseHostShellExecutionInput,
  requiresExplicitHostShellApproval,
  type HostShellExecutionPlanAuditProjection,
} from "../permissions/host-shell-execution-plan.js";
import {
  isDisposablePathPolicyRelaxation,
  getExecutionGrantCorrelationAuthority,
  type DisposablePathPolicyRelaxation,
  type ExecutionGrant,
  type ExecutionPlan,
  type ExecutionPlanAuditProjection,
} from "../permissions/execution-router.js";
import type { BrokeredWorkloadCapability } from "../workload/runtime.js";
import {
  buildHostShellExecutionPermitBinding,
  type HostShellExecutionPermitBinding,
} from "../permissions/host-shell-execution-permit.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
import { issueAuthorizationRequiredControl } from "../shared/authorization-required.js";
// ── Pipeline units — behavior-preserving extractions.
// This runner owns preparation/path policy and composes the extracted
// LOW/MEDIUM-risk helpers. Authorization and execution/finalization are
// delegated to their named stages below.
import { extractTargetFilePaths, shellPathPolicyViolation } from "./pipeline/path-extraction.js";
import { scopedRuleSubjectFor } from "./pipeline/scoped-rule-subject.js";
import { hasShellCommandArgument } from "../shared/shell-command-fields.js";
import { buildApprovalPurposeSuggestion } from "./pipeline/approval-purpose.js";
import { pluginTurnScopeTarget } from "./pipeline/plugin-turn-scope.js";
import {
  approvalIdentityFor,
  ARGS_APPROVAL_MEMORY,
  emitToolStart,
} from "./pipeline/display-mask.js";
import {
  auditSafeToolInput,
  AuditWriter,
} from "./pipeline/audit-writer.js";
// ── Per-invocation mutable-state contract + initial-state factory + the
// self-contained user-abort helper. The two SECURITY-CRITICAL sandbox
// filesystem-containment relaxation blocks stay together in
// invocation-authorization.ts. The shared initial state and abort terminal
// live in invocation-context.ts.
import { createInvocationContext, returnUserAbort } from "./pipeline/invocation-context.js";
import type { RationaleHostRuntime } from "./pipeline/rationale-orchestrator.js";
import type { RationaleExecutorControlOutcome } from "./pipeline/rationale-pr1-contract.js";
import {
  approvalCacheKeyIdentity,
  canonicalStringify,
  lookupUserDecision,
  UserApprovalStoreCorruptError,
} from "../permissions/user-approval-store.js";
import type { ApprovalMemory } from "../shared/permissions-events.js";
import type { SealedRationaleResumeRequest } from "./pipeline/rationale-resume-contract.js";
import {
  type AuthorizedRationaleResume,
  type PreparedRationaleResume,
  type RationaleResumeHostRuntime,
  type StartedRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import {
  type ExecuteOptions,
  type ToolCallMeta,
  type ToolPermissionContext,
  type ToolResult,
  type ToolUseBlock,
} from "./executor-contract.js";
import {
  currentApprovalMode,
  resolveEnforcedCategory,
  type InvocationRunnerServices,
} from "./invocation-services.js";
import {
  authorizeToolInvocation,
  deriveApprovalIsReadOnly,
} from "./invocation-authorization.js";
import { executeAuthorizedToolInvocation } from "./invocation-execution.js";
import {
  resolvePluginOperation,
  type ResolvedPluginOperation,
} from "./plugin-operation-governance.js";
import type { PluginOperationPrincipal } from "../permissions/plugin-operation-grant.js";
import type { HostPluginGenerationState } from "../plugins/plugin-host-generation.js";
import type { PluginGenerationLease } from "../plugins/plugin-generation-coordinator.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("executor");

/**
 * At most this many authorized directories are named in a denial message. A
 * session can hold a long grant list, and the message is read by a model whose
 * budget the enumeration would otherwise eat.
 */
const DENIAL_GUIDANCE_DIRECTORY_LIMIT = 8;

/**
 * Rule id stamped on the Layer 1 audit row for a read admitted outside the
 * authorized directories.
 *
 * Same `<control>/<verdict>` shape as the denial rule ids
 * (`allowed-directories/denied`, `shell-path-policy/sandbox-boundary`) so a log
 * reader filters allow and deny rows of the same control the same way. It names
 * the RULE, not the setting: `blockReadsOutsideWorkingDirectories` being off is
 * why the rule applies, and a row that named the setting would read as a
 * configuration dump rather than a decision.
 */
const READ_ANYWHERE_AUDIT_RULE = "path-scope/read-anywhere";

/**
 * The sentences appended to every host policy refusal — the four bracketed
 * block kinds (`Directory policy blocked`, `Shell path policy blocked`,
 * `Bash AST blocked`, `Sensitive path blocked`) plus the headless directory
 * hold, which denies for the same reason without a person in the loop.
 *
 * WHY ONE FORMATTER. All five arrive at the model as an ordinary `isError`
 * tool result, indistinguishable from a command that simply failed. Read that
 * way they invite the one response that cannot work: rewrite the command and
 * run it again. A refusal has to say three things a failure does not — WHAT was
 * judged, whether a retry can change the answer, and what would be allowed
 * instead — and it has to say them the same way every time, or the model learns
 * the shape of one message and misreads the other four.
 *
 * The bracketed prefix stays on the caller's side: downstream parsers key on
 * it, and this only ever appends.
 *
 * @param rule       Stable identifier of the rule that refused, e.g.
 *                   `shell-path-policy/sandbox-boundary`.
 * @param operand    The token or path actually judged, when the rule named one.
 * @param retry      `never` for a decision no repetition can change; `grant`
 *                   when a human authorization would change it.
 */
export function buildPolicyDenialGuidance(input: {
  rule: string;
  operand?: string;
  retry: "never" | "grant";
  alternative: PolicyDenialAlternative;
  allowedDirectories: readonly string[];
  filesystemRootReference?: boolean;
  /**
   * Say, on a scope refusal, that only writes and execution are confined.
   *
   * Without it the directory list reads as the answer to "what may I touch",
   * and a model that just had a write refused concludes it cannot read out
   * there either — so it stops issuing the wide reads the host does admit. Set
   * only where the refusal was a scope verdict and reads are in fact unfenced;
   * saying it while `blockReadsOutsideWorkingDirectories` is on would be false.
   */
  readsUnfenced?: boolean;
}): string {
  const sentences: string[] = [];
  sentences.push(
    input.operand === undefined || input.operand.length === 0
      ? t("be_executor.denialJudgedRule", { rule: input.rule })
      : t("be_executor.denialJudgedOperand", { operand: input.operand, rule: input.rule }),
  );
  sentences.push(
    input.retry === "never"
      ? t("be_executor.denialRetryNever")
      : t("be_executor.denialRetryNeedsGrant"),
  );
  if (input.filesystemRootReference) {
    sentences.push(t("be_executor.denialFilesystemRoot"));
  }
  if (input.alternative === "restructure-command") {
    sentences.push(t("be_executor.denialRestructureCommand"));
  } else if (input.alternative === "path-never-readable") {
    sentences.push(t("be_executor.denialSensitivePathPermanent"));
  } else {
    const named = input.allowedDirectories.slice(0, DENIAL_GUIDANCE_DIRECTORY_LIMIT);
    const remaining = input.allowedDirectories.length - named.length;
    sentences.push(
      named.length === 0
        ? t("be_executor.denialNoAllowedDirectories")
        : t("be_executor.denialAllowedDirectories", {
            directories: remaining > 0 ? `${named.join(", ")}, …(+${remaining})` : named.join(", "),
          }),
    );
    if (input.readsUnfenced) {
      sentences.push(t("be_executor.denialReadsNotConfined"));
    }
  }
  return ` ${sentences.join(" ")}`;
}

/**
 * What the model could legitimately do instead — the sentence that closes a
 * denial.
 *
 * Naming the authorized directories only helps when the refusal was ABOUT
 * scope. Appending it to a structural refusal ("this command shape is not
 * allowed") or to a Layer-0 sensitive path invites the retry that cannot work:
 * re-issuing `rm -rf` under an authorized directory is still `rm -rf`, and no
 * grant ever makes a protected path readable. Those two get sentences that say
 * what would actually change the answer.
 */
type PolicyDenialAlternative =
  /** The refusal was about scope: a path under an authorized directory works. */
  | "retarget-under-authorized-directory"
  /** The command's shape was refused; a different target changes nothing. */
  | "restructure-command"
  /** A Layer-0 protected path; no authorization makes it readable. */
  | "path-never-readable";

type AuditToolCallArgs = Parameters<AuditWriter["auditToolCall"]>;
type AuditPermissionAskArgs = Parameters<AuditWriter["auditPermissionAsk"]>;

function resolveInvocationCategory(
  tool: Tool,
  finalInput: Record<string, unknown>,
  sessionId: string | undefined,
): ToolCategory {
  return tool.categoryForInput?.(finalInput, sessionId === undefined ? {} : { sessionId }) ?? tool.category;
}

export interface RationaleBatchExecutionContext {
  runtime: RationaleHostRuntime;
  batchId: string;
  originalToolUseIds: readonly string[];
  completedToolUseIds: readonly string[];
}

export interface RationaleRequiredExecuteOneOutcome {
  outcome: "rationale-required";
  control: RationaleExecutorControlOutcome;
}

export interface RationaleResumeExecutionContext {
  request: SealedRationaleResumeRequest;
  runtime?: RationaleResumeHostRuntime;
  prepared?: PreparedRationaleResume;
  authorized?: AuthorizedRationaleResume;
  started?: StartedRationaleResume;
  terminalizationAttempted?: boolean;
  terminalized?: boolean;
}

export async function runToolInvocation(
  services: InvocationRunnerServices,
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts: ExecuteOptions = {},
    rationaleBatchContext?: RationaleBatchExecutionContext,
    rationaleResumeContext?: RationaleResumeExecutionContext,
  ): Promise<ToolResult | RationaleRequiredExecuteOneOutcome> {
    const {
      callbacks,
      sessionId,
      overlayTriggerOrigin,
      spawnDepth,
      memoryIncludeUnscoped,
      supportsA2AParentDelivery,
      approvalReasonPrefix,
      abortSignal,
      a2aCausalContext,
      toolResultChunkReader,
      toolOutputCaptureFactory,
      permissionContext: providedPermissionContext,
      executionCwd: requestedExecutionCwd,
      pluginAuthLifecycle,
    } = opts;
    const permissionContext = providedPermissionContext && services.approvalGate === undefined
      ? { ...providedPermissionContext, approvalSurface: "unavailable" as const }
      : providedPermissionContext;
    const startTime = Date.now();
    const executionCwd =
      requestedExecutionCwd ?? currentToolExecutionCwd() ?? process.cwd();
    const meta: ToolCallMeta = { groupId, toolUseId: toolUse.id, displayOrder };
    let permissionResult: PermissionCheckResult | undefined;
    let source: ToolSource = "builtin";
    let trust: TrustLevel = "high";
    let preparedShellInvocation: PreparedShellInvocation | undefined;
    let verifiedShellCommand: VerifiedShellCommand | undefined;
    let hostShellExecutionPlanAudit: HostShellExecutionPlanAuditProjection | undefined;
    let executionRouteAudit: ExecutionPlanAuditProjection | undefined;
    let executionRoutePlan: ExecutionPlan | undefined;
    // Relaxations of the current route plan; the permission decision and grant issuance both read them.
    let executionRoutePathPolicyRelaxations: readonly DisposablePathPolicyRelaxation[] | undefined;
    let executionRouteGrant: ExecutionGrant | undefined;
    let finalizeExecutionRouteGrant:
      | (() => Promise<ExecutionGrant | undefined>)
      | undefined;
    let executionRouteRequirementKind: "dynamic-path" | "recursive-traversal" | undefined;
    let brokeredFileRouteSelected = false;
    let brokeredFileCapability: BrokeredWorkloadCapability | undefined;
    let normalizedCanonicalFileInput: unknown;
    let governedTool = false;
    const withHostShellExecutionPlan = (result: ToolResult): ToolResult =>
      hostShellExecutionPlanAudit === undefined
        ? result
        : { ...result, executionPlan: hostShellExecutionPlanAudit };
    const currentAuditMetadata = (
      input: Record<string, unknown> = toolUse.input,
    ): ToolExecutionAuditMetadata => ({
      toolUseId: toolUse.id,
      ...(hostShellExecutionPlanAudit !== undefined
        ? { executionPlan: hostShellExecutionPlanAudit }
        : {}),
      ...(executionRouteAudit !== undefined
        ? { executionRoute: executionRouteAudit }
        : {}),
      ...(executionRouteGrant === undefined
        ? {}
        : (() => {
            const authority = getExecutionGrantCorrelationAuthority(executionRouteGrant);
            return authority === undefined
              ? {}
              : {
                  workloadBrokerCorrelation: Object.freeze({
                    version: "ave-workload-correlation/v1" as const,
                    kind: "tool-invocation" as const,
                    toolUseId: authority.toolUseId,
                    toolName: authority.toolName,
                    operation: authority.operation,
                    grant: authority.grant,
                  }),
                };
          })()),
      ...(governedTool
        ? {
            governedOperation:
              typeof input.operation === "string" ? input.operation : null,
          }
        : {}),
    });
    let denialRecorded = false;
    const auditCurrentToolCall = async (...args: AuditToolCallArgs): Promise<void> => {
      const denied = args[8];
      const history = services.permissionManager?.getRecentlyDenied();
      if (denied?.decision === "deny" && history && !denialRecorded) {
        denialRecorded = true;
        const registeredTool = services.toolRegistry.findByName(toolUse.name);
        const invocationRef = registeredTool && makeRecentlyDeniedInvocationRef(toolUse.input, {
          cwd: executionCwd, toolUseId: toolUse.id,
          pluginId: registeredTool.pluginId, mcpServerId: registeredTool.mcpServerId,
        });
        const inputSnapshot = invocationRef ? structuredClone(toolUse.input) : undefined;
        await history.append({
          sessionId, toolName: toolUse.name, source: args[2], category: meta.category ?? "write",
          inputSummary: JSON.stringify(args[4]), reason: denied.reason,
          ...(invocationRef ? { invocationRef } : {}),
          ...(inputSnapshot && invocationRef ? { rerun: async () => {
            const replayRootBinding = issueReplayRootBinding(executionCwd, invocationRef.rootDigest);
            if (!replayRootBinding) throw new Error("The replay project root changed");
            const result = await runToolInvocation(services, { ...toolUse, id: randomUUID(), input: structuredClone(inputSnapshot) }, randomUUID(), 0, {
              executionCwd, replayRootBinding,
              permissionContext: { headless: false, manualRerun: true, trustOrigin: "user-keyboard" },
            });
            if ("is_error" in result && result.is_error) throw new Error("The manual rerun was denied or failed");
            return result;
          } } : {}),
        });
      }
      args[16] = currentAuditMetadata(args[4]);
      return services.auditWriter.auditToolCall(...args);
    };
    const auditCurrentPermissionAsk = (
      ...args: AuditPermissionAskArgs
    ): Promise<void> => {
      args[8] = currentAuditMetadata(args[3]);
      return services.auditWriter.auditPermissionAsk(...args);
    };


    const tool = services.toolRegistry.findByName(toolUse.name);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      await auditCurrentToolCall(sessionId, toolUse.name, "builtin", "high", toolUse.input, t("be_executor.toolNotFoundAudit"), true, startTime, { decision: "deny", reason: t("be_executor.toolNotFoundAudit"), layer: 0 }, Infinity, permissionContext);
      callbacks?.onToolEnd?.(toolUse.name, t("be_executor.toolNotFound", { name: toolUse.name }), true, meta, undefined, durationMs);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: t("be_executor.toolNotFound", { name: toolUse.name }), is_error: true, durationMs });
    }
    governedTool = tool.operationPolicy !== undefined;
    let generationAccess: ReturnType<
      InvocationRunnerServices["pluginGenerationAccessProvider"]
    >;
    let generationLease: PluginGenerationLease<HostPluginGenerationState> | undefined;
    if (tool.pluginGeneration) {
      generationAccess = services.pluginGenerationAccessProvider();
      try {
        if (!generationAccess) {
          throw new Error("plugin generation access is unavailable");
        }
        generationLease = await generationAccess.acquireExact(
          tool.pluginGeneration.pluginId,
          tool.pluginGeneration.generationId,
        );
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const reason = `Plugin generation admission denied: ${
          errorMessage(error)
        }`;
        const denied: PermissionCheckResult = {
          decision: "deny",
          reason,
          layer: 0,
        };
        await auditCurrentToolCall(
          sessionId,
          toolUse.name,
          tool.source,
          trustFromSource(tool.source),
          toolUse.input,
          reason,
          true,
          startTime,
          denied,
          Infinity,
          permissionContext,
        );
        callbacks?.onToolEnd?.(
          toolUse.name,
          reason,
          true,
          meta,
          undefined,
          durationMs,
        );
        return withHostShellExecutionPlan({
          tool_use_id: toolUse.id,
          content: reason,
          is_error: true,
          durationMs,
        });
      }
    }
    const executeAdmitted = async (): Promise<
      ToolResult | RationaleRequiredExecuteOneOutcome
    > => {
    if (
      permissionContext?.expectedMcpServerId &&
      tool.mcpServerId !== permissionContext.expectedMcpServerId
    ) {
      const durationMs = Date.now() - startTime;
      const reason = `MCP tool owner changed: expected '${
        permissionContext.expectedMcpServerId
      }', got '${tool.mcpServerId ?? "unknown"}'`;
      const denied: PermissionCheckResult = {
        decision: "deny",
        reason,
        layer: 0,
      };
      await auditCurrentToolCall(
        sessionId,
        toolUse.name,
        tool.source,
        trustFromSource(tool.source),
        toolUse.input,
        reason,
        true,
        startTime,
        denied,
        Infinity,
        permissionContext,
      );
      callbacks?.onToolEnd?.(
        toolUse.name,
        reason,
        true,
        meta,
        undefined,
        durationMs,
      );
      return withHostShellExecutionPlan({
        tool_use_id: toolUse.id,
        content: reason,
        is_error: true,
        durationMs,
      });
    }
    source = tool.source;
    trust = trustFromSource(source);
    let invocationCategory = resolveInvocationCategory(tool, toolUse.input, sessionId);
    // Layer 1's read fence, read once per invocation from the wired policy
    // holder rather than per path operand. `=== true` rather than `?? false`
    // because the question is "did a wired PermissionManager ask for reads to
    // be re-fenced": with none wired there is no policy asking for it, which is
    // also the setting's shipped value.
    const blockReadsOutsideWorkingDirectories =
      services.permissionManager?.getBlockReadsOutsideWorkingDirectories() === true;
    meta.source = source;
    meta.category = invocationCategory;
    if (tool.pluginId) meta.pluginId = tool.pluginId;
    if (tool.workerId) meta.workerId = tool.workerId;
    if (tool.mcpServerId) meta.mcpServerId = tool.mcpServerId;

    const returnRationaleResumeBlock = async (
      reason: string,
      input: Record<string, unknown>,
      blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason,
        layer: 0,
      },
      hookChain?: HookResult[],
      suppressPermissionDeniedLifecycle = false,
    ): Promise<ToolResult> => {
      const content = "Rationale resume blocked: " + reason;
      const durationMs = Date.now() - startTime;
      callbacks?.onToolEnd?.(toolUse.name, content, true, meta, undefined, durationMs);
      await auditCurrentToolCall(
        sessionId,
        toolUse.name,
        source,
        trust,
        input,
        content,
        true,
        startTime,
        { ...blockedPermission, decision: "deny", reason },
        Infinity,
        permissionContext,
        invocationCategory,
        executionCwd,
        undefined,
        undefined,
        hookChain,
        undefined,
        suppressPermissionDeniedLifecycle,
      );
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content, is_error: true, durationMs });
    };

    // ── The model MUST NOT execute a tool hidden from it ──
    // `findByName` deliberately does NOT filter `modelVisible` (an app-only tool is a
    // registry `Tool` precisely so its CARD's governed call can run under the gate — see
    // `isModelExposedTool` / `ToolRegistry.getModelVisibleTools`). That same resolution
    // means a model `tool_use` naming an app-only tool — e.g. a prompt injection naming
    // `<plugin>_auth_login`, whose handler spawns a credentialed auth BrowserWindow —
    // would otherwise reach the handler. `modelVisible === false` means "hidden from the
    // model" by definition, so the model has no legitimate reason to call it. The
    // governed card/panel arms reach these tools through their OWN origins —
    // `PluginRuntime.callFromApp` ("mcp-app") / `callFromUi` ("ui"), both entering the
    // executor inside a `runWithInvocationOrigin` frame — so the effective invocation
    // origin is the ONE discriminator: the model's main-loop executor runs in NO frame
    // (`currentInvocationOrigin()` → `undefined`) and an LLM/plugin `ctx.callTool` is
    // `"plugin"`; neither is a governed app surface, so both are refused here, at the ONE
    // model-tool_use dispatch site. Fail-closed ALLOW-LIST (only the two governed origins
    // pass — a future origin defaults to denied). Mirrors the `toolNotFound` deny above:
    // the model-facing result is the same "not found" text (no disclosure that the hidden
    // tool exists), audited as a `deny` — never a throw. The card-arm auth-trio deny in
    // `callFromApp` is a SEPARATE, additional defense and is untouched.
    if (!isModelExposedTool(tool)) {
      const invocationOrigin = currentInvocationOrigin();
      if (invocationOrigin !== "mcp-app" && invocationOrigin !== "ui") {
        const durationMs = Date.now() - startTime;
        const modelFacing = t("be_executor.toolNotFound", { name: toolUse.name });
        const deny: PermissionCheckResult = {
          decision: "deny",
          reason: `model-hidden tool '${toolUse.name}' is not model-callable (origin: ${invocationOrigin ?? "model"})`,
          layer: 0,
        };
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, deny.reason, true, startTime, deny, Infinity, permissionContext, invocationCategory, executionCwd);
        callbacks?.onToolEnd?.(toolUse.name, modelFacing, true, meta, undefined, durationMs);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: modelFacing, is_error: true, durationMs });
      }
    }

    // ── User-abort terminal helper — lives in ./pipeline/invocation-context.ts.
    // Its wide capture surface (source/trust/invocationCategory/meta/callbacks/…)
    // is threaded via a named-field deps object; `services.auditWriter` is passed
    // directly.
    const abortDeps = (input: Record<string, unknown>): Parameters<typeof returnUserAbort>[0] => ({
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
      auditWriter: services.auditWriter,
      audit: currentAuditMetadata(input),
    });

    if (abortSignal?.aborted) {
      return withHostShellExecutionPlan(await returnUserAbort(abortDeps(toolUse.input)));
    }

    const foldedExecutionCwd = caseFoldForMatch(canonicalizePathForMatch(executionCwd));
    if (isFilesystemRootPath(foldedExecutionCwd)) {
      const msg = t("be_executor.permBlockCwdRoot", { name: toolUse.name, source });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: "execution cwd is filesystem root",
        layer: 0,
      };
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }

    if (!permissionContext?.trustOrigin) {
      const msg = t("be_executor.permBlockTrustOriginMissing", { name: toolUse.name, source });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: "tool trust origin missing",
        layer: 0,
      };
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }


    // A P2 paired share is revocable independently of the active Tailnet
    // connection. Recheck before any pre-hook, path prompt, or approval can
    // retain authority after the owner has removed that specific share.
    if (!isRemoteControllerAuthorityCurrent(permissionContext.remoteControllerAuthority)) {
      const reason = "remote-controller-revoked";
      const msg = t("be_executor.permBlockDeny", {
        name: toolUse.name,
        source,
        trust,
        reason,
      });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason,
        layer: 2,
      };
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }
    // Deny P1-excluded remote operations before any path-policy prompt can
    // mint a directory grant. The PermissionManager repeats this policy at
    // authorization time; this earlier boundary keeps a blocked command from
    // producing a misleading local approval or authority residue at all.
    if (
      permissionContext.remoteControllerAuthority !== undefined
      && (
        invocationCategory === "meta"
        || isTailnetControllerP1BlockedTool(toolUse.name)
      )
    ) {
      const reason = invocationCategory === "meta"
        ? "Remote controller meta operations are not enabled"
        : "Remote controller deferred or capability-expanding operations are not enabled";
      const msg = t("be_executor.permBlockDeny", {
        name: toolUse.name,
        source,
        trust,
        reason,
      });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = { decision: "deny", reason, layer: 2 };
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }

    // A `cd` in an earlier bash call of this session becomes this call's
    // explicit directory here, before PreToolUse hooks and every permission,
    // approval, route, and preparation binding, so all of them see the
    // directory the command runs in. A hook's rewrite is final.
    const sessionInput = toolUse.name === tool.name && isCanonicalBashTool(tool)
      ? withShellSessionCwd(toolUse.input, {
          sessionId,
          root: executionCwd,
          allowedDirectories: buildRuntimeAllowedDirectories(
            permissionContext?.getAdditionalDirectories?.()
              ?? permissionContext?.additionalDirectories
              ?? [],
            executionCwd,
          ),
        })
      : toolUse.input;

    // ── Step 2: PreToolUse Hook ─────────────────────
    // Governed plugin operations never dispatch effect-capable extension
    // hooks. Their provider state is protected by a Host-owned serialized
    // account scope; arbitrary hook code cannot participate in that proof or
    // be made crash-contained on every supported OS. A Tailnet controller
    // likewise never runs pre-approval extension hooks: its only permitted
    // side-effect boundary is the following exact local allow-once modal.
    const preResult: Awaited<ReturnType<HookRunner["runPreHooks"]>> =
      tool.operationPolicy ||
      permissionContext?.remoteControllerAuthority !== undefined
        ? { action: "allow" }
        : await services.hookRunner.runPreHooks({
            toolName: toolUse.name,
            toolInput: sessionInput,
          });

    if (preResult.action === "deny") {
      if (rationaleResumeContext) {
        return returnRationaleResumeBlock(
          "argument PreToolUse hook denied the sealed action: " +
            (preResult.reason ?? "no reason"),
          toolUse.input,
        );
      }
      const msg = t("be_executor.hookBlockPre", { reason: preResult.reason ?? t("be_executor.hookBlockPreDefaultReason") });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }

    const finalInput = preResult.action === "modify" && preResult.updatedInput
      ? preResult.updatedInput
      : sessionInput;
    let resolvedPluginOperation: ResolvedPluginOperation | undefined;
    let pluginOperationPrincipal: PluginOperationPrincipal | undefined;
    if (tool.operationPolicy) {
      const ambientOrigin = currentInvocationOrigin();
      const operationOrigin = ambientOrigin === undefined ? "model" : ambientOrigin;
      try {
        resolvedPluginOperation = resolvePluginOperation(
          tool.operationPolicy,
          finalInput,
          operationOrigin,
        );
        const hostContext =
          permissionContext?.pluginOperation ??
          services.pluginOperationIdentityProvider(tool, sessionId);
        if (hostContext && tool.pluginId) {
          if (
            !tool.pluginGeneration ||
            hostContext.generationId !== tool.pluginGeneration.generationId
          ) {
            throw new Error("host-derived operation generation does not match the resolved tool");
          }
          const appGrantRequired =
            operationOrigin === "ui" || operationOrigin === "mcp-app";
          if (hostContext.appGrantRequired !== appGrantRequired) {
            throw new Error("host-derived operation grant policy does not match the effective origin");
          }
          pluginOperationPrincipal = {
            ownerPluginId: tool.pluginId,
            ownerVersion: hostContext.ownerVersion,
            generationId: hostContext.generationId,
            appSessionId: hostContext.appSessionId,
            accountScopeHash: hostContext.accountScopeHash,
            accountHash: hostContext.accountHash,
          };
        } else {
          throw new Error("host-derived operation identity is missing");
        }
      } catch (error) {
        const reason = errorMessage(error);
        const msg = `Plugin operation denied: ${reason}`;
        const durationMs = Date.now() - startTime;
        const denied: PermissionCheckResult = {
          decision: "deny",
          reason,
          layer: 0,
        };
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
          denied,
          Infinity,
          permissionContext,
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
    if (pluginAuthLifecycle) {
      const { binding } = pluginAuthLifecycle;
      if (
        !tool.operationPolicy ||
        !tool.pluginId ||
        !tool.pluginGeneration ||
        toolUse.name !== binding.toolName ||
        tool.pluginId !== binding.pluginId ||
        tool.pluginGeneration.generationId !== binding.generationId ||
        !pluginOperationPrincipal ||
        pluginOperationPrincipal.appSessionId !== binding.appSessionId ||
        pluginOperationPrincipal.accountScopeHash !== binding.accountScopeHash
      ) {
        throw new Error(
          "host plugin auth lifecycle does not match the admitted governed Tool",
        );
      }
    }
    if (rationaleResumeContext) {
      let inputsMatch = false;
      try {
        inputsMatch =
          canonicalStringify(toolUse.input) === canonicalStringify(
            rationaleResumeContext.request.control.sealedAction.originalInput,
          ) &&
          canonicalStringify(finalInput) === canonicalStringify(
            rationaleResumeContext.request.control.sealedAction.finalInput,
          );
      } catch {
        inputsMatch = false;
      }
      if (!inputsMatch) {
        return returnRationaleResumeBlock(
          "sealed original/final input changed after argument PreToolUse hooks",
          finalInput,
        );
      }
    }
    if (finalInput !== toolUse.input) {
      invocationCategory = resolveInvocationCategory(tool, finalInput, sessionId);
      meta.category = invocationCategory;
    }

    if (abortSignal?.aborted) {
      return withHostShellExecutionPlan(await returnUserAbort(abortDeps(finalInput)));
    }
  const scriptPre = resolvedPluginOperation
    ? {
        decision: "allow" as const,
        reason: "governed operation hooks are disabled",
        results: [],
      }
    : await runScriptHook(
        services.scriptHookManager,
        "pre",
        toolUse.name,
        source,
        invocationCategory,
        finalInput,
        sessionId,
        permissionContext,
        tool.mcpServerId,
        tool.pluginId,
        undefined,
        undefined,
        tool.pluginGeneration !== undefined,
        abortSignal,
      );
  if (abortSignal?.aborted) return withHostShellExecutionPlan(await returnUserAbort(abortDeps(finalInput)));
  if (scriptPre.decision === "deny") {
    if (rationaleResumeContext) {
      return returnRationaleResumeBlock(
        "script PreToolUse hook denied the sealed action: " + scriptPre.reason,
        finalInput,
        { decision: "deny", reason: scriptPre.reason, layer: 6 },
        hookChainFromDispatch("pre", scriptPre),
      );
    }
    const msg = t("be_executor.hookBlockScript", { reason: scriptPre.reason });
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
    await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: scriptPre.reason, layer: 6 }, Infinity, permissionContext, invocationCategory, executionCwd, undefined, undefined, hookChainFromDispatch("pre", scriptPre));
    return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
  }


    // ── Initial per-invocation state (see ./pipeline/invocation-context.ts).
    // The factory builds the Layer-1 allowed scope + runtime allowed dirs + the
    // parent/own effect ledgers, including the within-round freshness read of
    // additionalDirectories.
    // `invocationAllowedScope` / `invocationRuntimeAllowedDirectories` stay `let`
    // LOCALS here (not context fields): applyApprovedDirectory reassigns them and
    // the sandbox-relaxation blocks below read them inline — boxing them would
    // force edits inside those byte-identical trust-boundary blocks.
    const initialState = createInvocationContext(permissionContext, executionCwd);
    const baseAdditionalDirectories = initialState.baseAdditionalDirectories;
    let invocationAllowedScope = initialState.allowedScope;
    let invocationRuntimeAllowedDirectories = initialState.runtimeAllowedDirectories;
    // Permission policy host-classifies-risk — shadow mode (always) + enforced
    // category (flag-gated). The declared category resolved above is the input;
    // when the flag is off this is a no-op and `invocationCategory` is unchanged.
    // Snapshot the DECLARED category before resolveEnforcedCategory may swap in
    // the host-derived one (flag on) — the effect shadow reconciles the declared
    // category against the host-observed effect summary post-execution.
    const declaredCategoryForEffectShadow = invocationCategory;
    // Parent (ambient) + per-invocation effect ledgers — created in the factory
    // (parent captured BEFORE own; full rationale lives in invocation-context.ts).
    const parentEffectLedger = initialState.parentEffectLedger;
    const effectLedger: EffectLedger = initialState.effectLedger;
    invocationCategory = resolveEnforcedCategory(
      services,
      tool,
      invocationCategory,
      finalInput,
      effectLedger.correlationId,
      resolvedPluginOperation?.rule.minimumRisk,
    );
    meta.category = invocationCategory;
    // Freeze the shell substrate before any reviewer, memory, or approval path.
    // Only these host-owned builtin tools may consume the plan.
    //
    // Canonical-INSTANCE identity — the narrow, unspoofable derivation. It is
    // deliberately NOT the same question as `BashAstValidator._isBashTool`
    // (Step 2.5 below), which is a wide name regex so that plugin/MCP tools
    // named `shell*`/`exec*`/… still receive POSIX structural analysis; and not
    // the same as `ASRT_WRAPPED_SHELL_TOOLS`. Do not unify the three: using
    // instance identity for the structural gate would silently drop every
    // non-builtin shell tool out of it. See
    // `src/tools/__tests__/executor-shell-tool-identity.test.ts`.
    const hostShellToolName =
      invocationCategory !== "shell" || toolUse.name !== tool.name
        ? undefined
        : isCanonicalBashTool(tool)
          ? "bash"
          : isCanonicalPowerShellTool(tool)
            ? "powershell"
            : undefined;
    const hostShellInput = hostShellToolName === undefined
      ? undefined
      : parseHostShellExecutionInput(finalInput);
    const hostShellExecutionPlan =
      hostShellInput !== undefined
        ? getHostShellExecutionPlan(hostShellInput.executionMode)
        : undefined;
    hostShellExecutionPlanAudit = hostShellExecutionPlan === undefined
      ? undefined
      : getHostShellExecutionPlanAuditProjection(hostShellExecutionPlan);
    if (hostShellExecutionPlanAudit !== undefined) {
      // Reuse the exact immutable safe projection for tool lifecycle events.
      meta.executionPlan = hostShellExecutionPlanAudit;
    }
    const canonicalFileTool =
      toolUse.name === tool.name && isCanonicalFileTool(tool)
        ? tool
        : undefined;
    const canonicalBrokerLifecycleTool =
      toolUse.name === tool.name && isCanonicalBrokerLifecycleTool(tool)
        ? tool
        : undefined;
    const acquireConfiguredBrokerCapability = async () => {
      const runtime = await import("../workload/runtime.js");
      return runtime.isWorkloadBrokerActive()
        ? await runtime.acquireBrokeredWorkloadCapability(abortSignal)
        : null;
    };
    const updateExecutionRoute = async (
      unresolvedRequirementKind?: "dynamic-path" | "recursive-traversal",
    ): Promise<void> => {
      if (
        hostShellExecutionPlan === undefined ||
        hostShellInput === undefined ||
        hostShellToolName === undefined
      ) {
        return;
      }
      // Keep the route and operator evidence modules out of the startup graph.
      // Shell calls load them on first use; both remain cached after that.
      const router = await import("../permissions/execution-router.js");
      const brokeredWorkloadCapability = await acquireConfiguredBrokerCapability();
      const operatorAcquisition = brokeredWorkloadCapability === null
        ? await (await import("../permissions/operator-container-attestation.js"))
            .acquirePublishedOperatorContainerCapabilityForGrant()
        : null;
      const disposableCapability = operatorAcquisition?.capability ?? null;
      const route = router.buildHostShellExecutionRoute({
        legacyPlan: hostShellExecutionPlan,
        toolName: hostShellToolName,
        command: hostShellInput.command,
        cwd: brokeredWorkloadCapability === null
          ? resolveHostShellWorkingDirectory(executionCwd, hostShellInput.cwd)
          : (await import("../workload/runtime.js")).resolveBrokeredWorkloadPath(
              brokeredWorkloadCapability, hostShellInput.cwd ?? ".",
            ),
        unresolvedRequirementKind,
        timeoutSeconds: hostShellInput.timeoutSeconds,
        background: hostShellInput.runInBackground,
        ...(disposableCapability === null ? {} : { disposableCapability }),
        ...(operatorAcquisition === null
          ? {}
          : { disposableRevalidationLease: operatorAcquisition.revalidationLease }),
        ...(brokeredWorkloadCapability === null
          ? {}
          : { brokeredWorkloadCapability }),
      });
      executionRouteRequirementKind = unresolvedRequirementKind;
      executionRoutePlan = route.plan;
      executionRoutePathPolicyRelaxations = router.executionPlanPathPolicyRelaxations(route.plan);
      executionRouteAudit = route.audit;
    };
    const returnExecutionRouteFailure = async (error: unknown): Promise<ToolResult> => {
      const reason = `Execution route unavailable: ${errorMessage(error)}`;
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, reason, true, meta, undefined, durationMs);
      await auditCurrentToolCall(
        sessionId,
        toolUse.name,
        source,
        trust,
        finalInput,
        reason,
        true,
        startTime,
        { decision: "deny", reason, layer: 0 },
        Infinity,
        permissionContext,
        invocationCategory,
        executionCwd,
      );
      return withHostShellExecutionPlan({
        tool_use_id: toolUse.id,
        content: reason,
        is_error: true,
        durationMs,
      });
    };
    try {
      await updateExecutionRoute();
      if (canonicalFileTool !== undefined) {
        const capability = await acquireConfiguredBrokerCapability();
        if (capability !== null) {
          normalizedCanonicalFileInput = normalizeCanonicalFileToolInput(
            canonicalFileTool,
            finalInput,
          );
          brokeredFileCapability = capability;
          brokeredFileRouteSelected = true;
        }
      }
      if (canonicalBrokerLifecycleTool !== undefined) {
        const capability = await acquireConfiguredBrokerCapability();
        if (capability !== null) {
          brokeredFileCapability = capability;
          brokeredFileRouteSelected = true;
          normalizedCanonicalFileInput = finalInput;
        }
      }
    } catch (error) {
      return await returnExecutionRouteFailure(error);
    }
    const brokeredHostShellRouteSelected = (): boolean =>
      hostShellToolName !== undefined &&
      executionRoutePlan?.route === "disposable-container" &&
      executionRoutePlan.disposableCapability?.kind === "workload-broker";
    const hostShellRequiresExplicitApproval =
      hostShellExecutionPlan !== undefined &&
      requiresExplicitHostShellApproval(hostShellExecutionPlan, hostShellToolName) &&
      executionRoutePlan?.route !== "disposable-container";
    // The cache key is an authority boundary too: derive it only after the
    // canonical host shell substrate is sealed, then reuse its exact public
    // projection through reviewer, modal, rationale, result, and audit paths.
    //
    // Absorption boundary. `approvalIdentityFor` runs the tool's OWN key
    // derivation, and several tools parse their input schema to build it
    // (BashTool hashes the zod-parsed `command`/`cwd`). That parse sits on the
    // AUTHORIZATION path, before the per-call execution boundary that turns a
    // tool's own throw into an `is_error` tool_result — so a single malformed
    // tool call used to escape as an exception through `executeOne`, past the
    // conversation loop, and reject the whole `ave:chat:send`: one bad
    // argument killed the user's turn. Degrading it here keeps the failure
    // proportionate to its cause (this one call) and, because the model gets a
    // normal error result naming the violation, self-correctable on the next
    // round. Deliberately tool-agnostic: any tool whose key derivation rejects
    // its input takes this path, not just bash.
    let approvalCacheKey: string | undefined;
    let approvalMemory: ApprovalMemory = ARGS_APPROVAL_MEMORY;
    try {
      // The brokered route keys on the guest-normalized input plus the
      // workload, never host paths, so the host-resolved memory scopes do not
      // apply: its remembered decisions stay on exact-args identity.
      ({ approvalCacheKey, approvalMemory } = brokeredFileRouteSelected && brokeredFileCapability !== undefined
        ? {
            approvalCacheKey: `${tool.name}:workload:${sha256Hex(canonicalStringify({
              input: normalizedCanonicalFileInput,
              workload: brokeredFileCapability.workload,
            }))}`,
            approvalMemory: ARGS_APPROVAL_MEMORY,
          }
        : await approvalIdentityFor(
            tool,
            finalInput,
            executionCwd,
            hostShellExecutionPlanAudit,
            sessionId,
          ));
      // Let the tool's schema identify malformed fields before checking the
      // internal plan contract. An input error must remain self-correctable.
      if (hostShellToolName !== undefined && hostShellInput === undefined) {
        throw new Error("Shell input passed tool validation but could not be normalized for an execution plan");
      }
    } catch (err) {
      const detail = errorMessage(err);
      const msg = t("be_executor.invalidToolInput", {
        name: toolUse.name,
        error: detail,
      });
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
        {
          decision: "deny",
          reason: t("be_executor.invalidToolInputAudit"),
          layer: 0,
        },
        Infinity,
        permissionContext,
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
    // Refuse unavailable host approval before even a prerequisite directory ask.
    if (hostShellRequiresExplicitApproval &&
      hostShellExecutionPlan?.executionRequest === "host" &&
      permissionContext.remoteControllerAuthority !== undefined) {
      const reason = "Explicit host execution is unavailable to remote-controller requests";
      const msg = t("be_executor.permBlockDeny", { name: toolUse.name, source, trust, reason });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime,
        { decision: "deny", reason, layer: 0 }, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }
    // Exact Settings decisions are evaluated at the first point where every
    // identity component is host-finalized. This is deliberately before shell
    // and allowed-directory prompts: a persistent exact deny must block the
    // matching invocation without asking the user to grant a prerequisite
    // directory scope first.
    //
    // A corrupt exact-decision store (Store B) is not a reason to block every
    // tool call: the store's denies are unknown, so non-read calls must ask
    // (PermissionManager fails them closed with the file named as the
    // reason), while reads keep the normal permission matrix. Any other
    // lookup failure still blocks this invocation.
    let permissionStoreError: string | undefined;
    if (!rationaleResumeContext) {
      let exactDecisionBlockReason: string | null = null;
      try {
        const storedDecision = await lookupUserDecision(
          toolUse.name,
          canonicalStringify(finalInput),
          source,
          permissionContext.trustOrigin,
          approvalCacheKeyIdentity(approvalCacheKey, approvalMemory),
          executionCwd,
          sessionId,
        );
        if ((storedDecision?.decision ?? "allow") === "deny") {
          exactDecisionBlockReason = "tool decision for this input or target denied in permission settings";
        }
      } catch (err) {
        if (err instanceof UserApprovalStoreCorruptError) {
          log.error("%s", err.message);
          permissionStoreError = err.message;
        } else {
          log.warn(
            "exact permission decision lookup failed; blocking invocation: %s",
            errorMessage(err),
          );
          exactDecisionBlockReason = "exact permission decision store unavailable";
        }
      }

      if (exactDecisionBlockReason) {
        const blockedPermission: PermissionCheckResult = {
          decision: "deny",
          reason: exactDecisionBlockReason,
          layer: 5,
        };
        const msg = t("be_executor.permBlockDeny", {
          name: toolUse.name,
          source,
          trust,
          reason: exactDecisionBlockReason,
        });
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
          blockedPermission,
          Infinity,
          permissionContext,
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
    // The substrate the effects land on, as the executor selected it above:
    // a broker-backed disposable-container shell route, or the brokered
    // canonical file route. Host-derived here and only here, and assigned
    // unconditionally so a value inherited on the caller's context can never
    // grade a host-routed call as a guest. The operator-attested container is
    // deliberately not a substrate (see `DisposableSubstrate`).
    const disposableSubstrate: DisposableSubstrate | undefined =
      executionRoutePlan?.route === "disposable-container" &&
      executionRoutePlan.disposableCapability !== null &&
      executionRoutePlan.disposableCapability.kind === "workload-broker"
        ? { authority: "workload-broker", id: executionRoutePlan.disposableCapability.id }
        : brokeredFileRouteSelected && brokeredFileCapability !== undefined
          ? { authority: "workload-broker", id: brokeredFileCapability.workload.id }
          : undefined;
    const invocationPermissionContext: ToolPermissionContext = {
      ...permissionContext,
      headless: permissionContext.headless === true,
      ...(approvalCacheKey ? { approvalCacheKey } : {}),
      approvalMemory,
      disposableSubstrate,
      ...(permissionStoreError === undefined ? {} : { permissionStoreError }),
    };
    const approvalPurpose = buildApprovalPurposeSuggestion(finalInput, invocationPermissionContext);
    const auditInput = auditSafeToolInput(
      finalInput,
      currentAuditMetadata(finalInput),
    );
    // The Plan-B binding is created only after every Layer-1 directory grant
    // has finalized the effective validator scope. It remains host-only.
    let hostShellExecutionPermitBinding:
      | HostShellExecutionPermitBinding
      | undefined;
    let hostShellApprovalDecision: ApprovalDecision | undefined;
    let hostShellAllowRuleDecision: PermissionCheckResult | undefined;
    const makeEvaluationContext = (input: {
      pathFields: readonly string[];
      targetFilePaths?: readonly string[];
      sensitivePathsAdjacent?: readonly string[];
    }): PermissionEvaluationContext => buildPermissionEvaluationContext({
      policyMode: services.permissionManager?.getMode?.() ?? "unmanaged",
      headless: invocationPermissionContext.headless === true,
      source,
      category: invocationCategory,
      trustOrigin: invocationPermissionContext.trustOrigin,
      executionCwd,
      allowedDirectories: invocationAllowedScope.directories,
      pathFields: input.pathFields,
      targetFilePaths: input.targetFilePaths ?? [],
      sensitivePathsAdjacent: input.sensitivePathsAdjacent ?? [],
    });

    let directoryAuthorization: { permission: PermissionCheckResult; humanApproved: boolean } | undefined;
    const requestOutOfAllowedDirectoryAccess = async (
      outOfAllowedTarget: { filePath: string; canonicalPath: string },
      dirLayerResult: PermissionCheckResult,
      requestSensitivePathPattern: string | null,
      reviewerPathFields: readonly string[],
    ): Promise<
      | { allowed: true; approvedDirectory: string; scope: "turn" | "session" | "always"; permissionResult?: PermissionCheckResult; humanApproved?: boolean }
      | { allowed: false; result: ToolResult }
    > => {
      const headless = invocationPermissionContext.headless === true;
      const manager = services.permissionManager;
      if (!manager) throw new Error("Directory authorization requires the permission manager");
      const command = typeof finalInput.command === "string" ? finalInput.command : undefined;
      const terminalScope = isCanonicalTerminalRunTool(tool) ? terminalCommandScopeOf(approvalMemory) : undefined;
      const shellSubject = command !== undefined && (isCanonicalBashTool(tool) || isCanonicalPowerShellTool(tool) || terminalScope !== undefined)
        ? { kind: "shell" as const, dialect: isCanonicalPowerShellTool(tool) ? "powershell" as const : "bash" as const, command,
            cwd: terminalScope?.cwd ?? resolveHostShellWorkingDirectory(executionCwd, typeof finalInput.cwd === "string" ? finalInput.cwd : undefined) }
        : undefined;
      await manager.ensureProjectRulesLoaded(shellSubject?.cwd ?? executionCwd);
      let directoryPermission = manager.checkDetailed(toolUse.name, source, invocationCategory, overlayTriggerOrigin, {
        ...invocationPermissionContext, sessionId, projectRulesCwd: shellSubject?.cwd ?? executionCwd,
        ...(invocationCategory === "read" && blockReadsOutsideWorkingDirectories ? { admissionDenial: { code: "read-boundary", reason: "This read is outside the configured allowed directories." } } : {}),
        ...(invocationCategory === "shell" ? { ...(shellSubject ? { ruleSubject: shellSubject } : {}), hostShellExecutionPlan,
          shellEscalated: true,
          shellExecution: { runsSandboxed: hostShellExecutionPlan !== undefined && isConfinedHostShellExecution(hostShellExecutionPlan, disposableSubstrate) } } : {
          ruleSubject: scopedRuleSubjectFor(tool, finalInput, executionCwd),
          fileWritePolicy: { insideProject: false, checkpointAvailable: false, directoryApproved: false },
        }),
        ...(approvalReasonPrefix || invocationPermissionContext.otherPrincipal ? { floor: { code: "other-principal" as const, reason: "This action requires the user's approval." } } : {}),
      });
      const memoryRequest = directoryPermission.pipelineRequest;
      if (directoryPermission.decision !== "allow" && memoryRequest && !memoryRequest.admissionDenial && !memoryRequest.floor
        && !memoryRequest.rules?.deny && !memoryRequest.rules?.ask && !memoryRequest.manualRerun && !memoryRequest.automationPause && !rationaleResumeContext) {
        const remembered = await services.tryUserApprovalMemorySkip(toolUse.name, source, invocationCategory, reviewerPathFields,
          finalInput, executionCwd, invocationAllowedScope.directories, [], invocationPermissionContext, approvalCacheKey, {},
          JSON.stringify([meta.groupId, meta.toolUseId]), tool.mcpServerId, tool.workerId, tool.pluginId, hostShellExecutionPlan, auditInput, sessionId);
        if (remembered) directoryPermission = manager.resolveRememberedPermission(directoryPermission, remembered.reason);
      }
      if (directoryPermission.reviewer) {
        const reviewerArgs = [manager, toolUse.name, source, invocationCategory, reviewerPathFields, finalInput,
          invocationAllowedScope.directories, [] as string[], invocationPermissionContext,
          makeEvaluationContext({ pathFields: reviewerPathFields, targetFilePaths: [outOfAllowedTarget.filePath] }),
          {}, callbacks, meta, approvalPurpose, hostShellExecutionPlan, abortSignal, auditInput, sessionId, directoryPermission] as const;
        if (headless) directoryPermission = (await dispatchReviewerForHeadless(...reviewerArgs)).permissionResult;
        else directoryPermission = await dispatchReviewerForInteractiveAuto(...reviewerArgs) ?? directoryPermission;
      }
      if (directoryPermission.decision === "allow") return { allowed: true, approvedDirectory: outOfAllowedTarget.canonicalPath, scope: "turn", permissionResult: directoryPermission };
      if (directoryPermission.decision === "deny") {
        const msg = directoryPermission.reason;
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, directoryPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs: Date.now() - startTime,
          ...(directoryPermission.reasonCode === "no-approver" && !headless && invocationPermissionContext.approvalSurface === "unavailable"
            ? { authorizationRequired: issueAuthorizationRequiredControl({ kind: "tool", toolName: toolUse.name, source, category: invocationCategory, reason: "approval-surface-unavailable" }) } : {}),
        }) };
      }
      dirLayerResult = directoryPermission;
      const directoryPolicyEpoch = manager.getPolicyEpoch();

      const trustOrigin = invocationPermissionContext.trustOrigin;
      // A directory grant is itself an authority expansion, even when the
      // underlying tool is read-only. Tailnet may never make it session-wide.
      const requiresRemoteDirectoryOneShot =
        invocationPermissionContext.remoteControllerAuthority !== undefined;
      // A directory-confirm modal is an approval like any other, so it carries
      // the same host-set origin marker. Leaving it off here would make the
      // marker's absence mean two different things depending on which surface
      // asked, which is exactly what a positive marker exists to avoid.
      const remoteControllerOrigin = remoteControllerOriginOf(
        invocationPermissionContext.remoteControllerAuthority,
      );
      const validation = validateDirectoryAddition(outOfAllowedTarget.canonicalPath);
      if (!validation.ok) {
        // A path the host will never add to the allowed set — the filesystem
        // root, or a Layer-0 sensitive pattern. The VERDICT matches an ordinary
        // out-of-allowed read (both refuse), so the guidance matches too; only
        // the root sentence differs, because root is the one target no
        // authorization can ever cover and the model has to be told to name a
        // subdirectory rather than keep asking for `/`.
        const msg = t("be_executor.dirPolicyBlock", { name: toolUse.name, reason: validation.reason, filePath: outOfAllowedTarget.filePath })
          + buildPolicyDenialGuidance({
            rule: "allowed-directories/not-grantable",
            operand: outOfAllowedTarget.filePath,
            retry: "never",
            alternative: "retarget-under-authorized-directory",
            allowedDirectories: invocationAllowedScope.directories,
            readsUnfenced: !blockReadsOutsideWorkingDirectories,
            filesystemRootReference: isFilesystemRootPath(outOfAllowedTarget.canonicalPath),
          });
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
      }
      // Detect whether the request path itself is a directory (e.g.
      // `list_files /Users/example`) so the auto-suggest goes to the path
      // itself rather than its parent. `statSync` is used here only to
      // hint the UI suggestion — the actual permission check downstream
      // is prefix-based and unaffected by TOCTOU, and the user must
      // re-type the suggested path before persisting (phishing defense).
      let isDirectoryTarget = false;
      try {
        isDirectoryTarget = statSync(outOfAllowedTarget.canonicalPath).isDirectory();
      } catch {
        // Path does not exist yet (e.g. write target before first write);
        // fall back to file-style behavior (suggest the parent dir).
      }
      const suggestedParent = pickClosestParent(
        outOfAllowedTarget.canonicalPath,
        invocationAllowedScope.directories,
        isDirectoryTarget,
      );

      if (services.approvalGate && !headless) {
        const approvalRequest = {
          id: randomUUID(),
          ...((requiresRemoteDirectoryOneShot || dirLayerResult.forceModal === true)
            ? {
                allowedChoices: ["allow-once", "deny-once"] as const,
                durableApprovalRecordAllowed: false as const,
                forceExplicit: true as const,
              }
            : {}),
          category: "tool" as const,
          kind: "out-of-allowed-dir" as const,
          toolName: toolUse.name,
          toolCategory: invocationCategory,
          // Same conversation attribution as the Layer 3 tool ask — a
          // directory-confirm modal blocks a specific conversation too.
          ...(sessionId === undefined ? {} : { sessionId }),
          // Host-only; the gate keeps it out of the renderer payload.
          ...(remoteControllerOrigin === undefined
            ? {}
            : { remoteControllerOrigin }),
          args: finalInput,
          reason: approvalReasonPrefix
            ? `${approvalReasonPrefix} ${dirLayerResult.reason}`
            : dirLayerResult.reason,
          source: source as ToolSource,
          createdAt: Date.now(),
          target: { filePath: outOfAllowedTarget.filePath },
          ownerUnattended: invocationPermissionContext.ownerUnattended,
          ...(dirLayerResult.forceModal === true ? { forceExplicit: true as const } : {}),
          isReadOnly: deriveApprovalIsReadOnly({
            invocationCategory,
            approvalReasonPrefix,
            remoteControllerAuthority:
              invocationPermissionContext.remoteControllerAuthority,
          }),
          mode: currentApprovalMode(services.permissionManager),
          sensitivePathPattern: requestSensitivePathPattern,
          // Canonical host shells carry the sealed renderer-safe projection;
          // every other execution route — including a shell the executor
          // routed to the broker guest, whose host plan describes a child
          // that never spawns — carries the capability the reviewer graded.
          ...(hostShellExecutionPlanAudit === undefined ||
              invocationPermissionContext.disposableSubstrate !== undefined
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
            : { executionPlan: hostShellExecutionPlanAudit }),
          evaluationContext: makeEvaluationContext({
            pathFields: reviewerPathFields,
            targetFilePaths: [outOfAllowedTarget.filePath],
            sensitivePathsAdjacent: validation.adjacencyWarnings,
          }),
          outOfAllowedDir: {
            candidatePath: outOfAllowedTarget.filePath,
            suggestedParent,
            currentAllowed: invocationAllowedScope.directories,
            adjacencyWarnings: validation.adjacencyWarnings,
          },
          trustOrigin,
          // Propagate approvalCacheKey so renderer record key
          // matches dispatchReviewer lookup key — end-to-end symmetry.
          ...(approvalCacheKey ? { approvalCacheKey } : {}),
          approvalMemory,
        };

        let decision;
        try {
          await auditCurrentPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
        finalInput,
            dirLayerResult,
            executionCwd,
            invocationPermissionContext,
            outOfAllowedTarget.filePath,
          );
          decision = await services.approvalGate.requestAndWait({
            ...approvalRequest,
            // A directory confirm parks the turn exactly like a tool ask does.
            ...(abortSignal === undefined ? {} : { abortSignal }),
          });
        } catch (approvalErr) {
          const msg = t("be_executor.dirPolicyError", { name: toolUse.name, error: errorMessage(approvalErr) });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, dirLayerResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
        }


        // As on the tool-ask path: the gate's deny-once on an abort is the
        // right permission answer but the wrong transcript entry. The user
        // stopped the turn; they did not refuse this directory.
        if (abortSignal?.aborted) {
          return {
            allowed: false,
            result: withHostShellExecutionPlan(
              await returnUserAbort(abortDeps(finalInput)),
            ),
          };
        }

        // The directory prompt is also a local approval boundary. A revoked
        // paired share may not retain even this invocation-scoped expansion.
        if (!isRemoteControllerAuthorityCurrent(invocationPermissionContext.remoteControllerAuthority)) {
          const reason = "remote-controller-revoked";
          const msg = t("be_executor.permBlockDeny", {
            name: toolUse.name,
            source,
            trust,
            reason,
          });
          const durationMs = Date.now() - startTime;
          const blockedPermission: PermissionCheckResult = {
            decision: "deny",
            reason,
            layer: 2,
          };
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
        }
        const remoteOneShotRejected =
          requiresRemoteDirectoryOneShot && decision.choice !== "allow-once";
        if (decision.choice.startsWith("deny") || remoteOneShotRejected) {
          // Reached both when a person declines and when an unattended session
          // auto-denies. Either way the same argument cannot succeed on its
          // own, so the guidance points at authorization rather than a rewrite.
          const hostFailure = approvalFailureOutcome(
            decision, toolUse.name, dirLayerResult,
          );
          const msg = hostFailure?.content ?? (
            t("be_executor.dirPolicyUserDenied", {
              name: toolUse.name,
              filePath: outOfAllowedTarget.filePath,
            })
            + buildPolicyDenialGuidance({
              rule: "allowed-directories/denied",
              operand: outOfAllowedTarget.filePath,
              retry: "grant",
              alternative: "retarget-under-authorized-directory",
              allowedDirectories: invocationAllowedScope.directories,
              readsUnfenced: !blockReadsOutsideWorkingDirectories,
            })
          );
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, hostFailure?.permission ?? { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
        }
        if (directoryPolicyEpoch !== manager.getPolicyEpoch()) {
          const denied: PermissionCheckResult = { decision: "deny", reason: "Permission policy changed during approval.", layer: 1 };
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, denied.reason, true, startTime, denied, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: denied.reason, is_error: true, durationMs: Date.now() - startTime }) };
        }
        const approvedPermissionResult: PermissionCheckResult = { ...dirLayerResult, decision: "allow", reason: "The user approved this exact invocation." };
        const approvedDirectory = decision.choice === "allow-always"
          ? (typeof decision.rememberPattern === "string" && decision.rememberPattern.length > 0
              ? decision.rememberPattern
              : suggestedParent ?? outOfAllowedTarget.filePath)
          : outOfAllowedTarget.filePath;
        if (decision.choice === "allow-always") {
          let lifecycle: PermissionDirectoryLifecycle | undefined;
          try {
            lifecycle = services.workspaceRootLifecycleProvider();
          } catch {
            lifecycle = undefined;
          }
          const dirResult = lifecycle
            ? await dispatchPermissionDirCommand({
                verb: "allow",
                path: approvedDirectory,
                session: false,
                acknowledgeWarnings: true,
              }, undefined, lifecycle)
            : { ok: false as const, error: "workspace lifecycle unavailable" };
          if (!dirResult.ok || dirResult.verb !== "allow") {
            const msg = t("be_executor.dirPolicySaveFailed", { name: toolUse.name, error: dirResult.ok ? "unexpected result" : dirResult.error });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
          }
          return { allowed: true, approvedDirectory, scope: "always", permissionResult: approvedPermissionResult, humanApproved: true };
        }
        if (decision.choice === "allow-session") {
          // Mirror allow-always' persist convention so the permission
          // audit trail records the directory addition; the caller's
          // onSessionDirectoryGrant callback then keeps the in-memory
          // ConversationLoop scope in sync. `session: true` ensures
          // settings.json is NOT mutated — the grant dies with the
          // conversation. Widen to suggestedParent (when present) so
          // the next tool call in the same conversation hitting a
          // sibling path under the same directory passes Layer 1
          // without re-prompting.
          const sessionScopePath = suggestedParent ?? outOfAllowedTarget.filePath;
          const dirResult = await dispatchPermissionDirCommand({
            verb: "allow",
            path: sessionScopePath,
            session: true,
            acknowledgeWarnings: true,
          });
          if (!dirResult.ok || dirResult.verb !== "allow") {
            const msg = t("be_executor.dirPolicySessionRegFailed", { name: toolUse.name, error: dirResult.ok ? "unexpected result" : dirResult.error });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
          }
          return { allowed: true, approvedDirectory: sessionScopePath, scope: "session", permissionResult: approvedPermissionResult, humanApproved: true };
        }
        // allow-once: turn-scope, no persistence, narrowest path.
        return { allowed: true, approvedDirectory, scope: "turn", permissionResult: approvedPermissionResult, humanApproved: true };
      }

      throw new Error("Human approval requires an available approval surface");

    };

    const invocationDirectoryGrants = new Set<string>();
    const applyApprovedDirectory = (approvedDirectory: string): void => {
      invocationDirectoryGrants.add(approvedDirectory);
      // Re-read fresh: an earlier tool in the same ordered executeAll run may
      // have just resolved its own out-of-allowed-dir dialog and mutated the
      // conversation loop's session/turn lists. Spreading from
      // `baseAdditionalDirectories` (executeOne-entry snapshot) would silently
      // drop that grant — read-side is fresh via getAdditionalDirectories but
      // write-side must also be fresh for symmetry. (architect 2-round Q1)
      const fresh: readonly string[] =
        invocationPermissionContext.getAdditionalDirectories?.()
        ?? baseAdditionalDirectories;
      invocationAllowedScope = buildAllowedScope([...fresh, ...invocationDirectoryGrants], executionCwd);
      invocationRuntimeAllowedDirectories = buildRuntimeAllowedDirectories(
        [...fresh, ...invocationDirectoryGrants],
        executionCwd,
      );
    };

    // Propagate the user's grant lifetime choice up to the conversation
    // loop. The local `applyApprovedDirectory` only widens the *current*
    // invocation's scope; without these callbacks the grant would not
    // outlive this single tool call — the exact "한 번만 허용 = 1 tool
    // call" bug being fixed here. Fail-loud on missing callback: silently
    // dropping a grant is exactly the bug class this refactor eliminates,
    // so we log and degrade conservatively (session → turn) rather than
    // pretending the propagation succeeded.
    const propagateGrantScope = (approvedDirectory: string, scope: "turn" | "session" | "always"): void => {
      const emitGrantAudit = (lifetime: "turn" | "session" | "always" | "degraded-to-turn"): void => {
        // Fire-and-forget: audit append errors are logged inside the
        // helper (or thrown only when requirePermissionAuditChain), so we
        // don't block tool execution on audit I/O.
        void services.auditWriter.auditPermissionGrant({
          toolName: toolUse.name,
          source,
          category: invocationCategory,
          directory: approvedDirectory,
          grantLifetime: lifetime,
          permissionContext: invocationPermissionContext,
          audit: currentAuditMetadata(),
        });
      };
      if (scope === "turn") {
        if (!invocationPermissionContext.onTurnDirectoryGrant) {
          log.warn(`[permission-scope] onTurnDirectoryGrant unwired — turn-scope grant for ${approvedDirectory} will not survive this tool call`);
          return;
        }
        invocationPermissionContext.onTurnDirectoryGrant(approvedDirectory);
        emitGrantAudit("turn");
        return;
      }
      if (scope === "session") {
        if (!invocationPermissionContext.onSessionDirectoryGrant) {
          if (!invocationPermissionContext.onTurnDirectoryGrant) {
            log.error(`[permission-scope] both session and turn callbacks unwired — session-scope grant for ${approvedDirectory} dropped entirely`);
            return;
          }
          log.error(`[permission-scope] onSessionDirectoryGrant unwired — degrading session-scope grant for ${approvedDirectory} to turn-scope`);
          invocationPermissionContext.onTurnDirectoryGrant(approvedDirectory);
          emitGrantAudit("degraded-to-turn");
          return;
        }
        invocationPermissionContext.onSessionDirectoryGrant(approvedDirectory);
        emitGrantAudit("session");
        return;
      }
      // "always" — dispatchPermissionDirCommand already persisted the rule
      // inside requestOutOfAllowedDirectoryAccess; emit the audit row here
      // so forensic replay sees a unified grant timeline across all three
      // lifetimes.
      emitGrantAudit("always");
    };

    if ((hostShellToolName === "bash" || hostShellToolName === "powershell") && hostShellExecutionPlan !== undefined
      && hostShellExecutionPlan.substrate !== "mxc" && invocationPermissionContext.disposableSubstrate === undefined
      && !brokeredHostShellRouteSelected() && typeof finalInput.command === "string") {
      verifiedShellCommand = prepareVerifiedShellCommand({ command: finalInput.command, dialect: hostShellToolName,
        cwd: resolveHostShellWorkingDirectory(executionCwd, typeof finalInput.cwd === "string" ? finalInput.cwd : undefined) });
    }

    // A broker capability names a Linux guest namespace. Host shell discovery,
    // environment snapshots, and temporary-home preparation describe the
    // controller process instead, so they cannot qualify or reject this route.
    if (
      hostShellToolName === "bash" &&
      hostShellExecutionPlan &&
      typeof finalInput.command === "string" &&
      !brokeredHostShellRouteSelected()
    ) {
      try {
        if (finalInput.cwd !== undefined && typeof finalInput.cwd !== "string") throw new Error("Shell cwd must be a string");
        preparedShellInvocation = prepareShellInvocation({
          command: finalInput.command, requestedCwd: finalInput.cwd as string | undefined,
          executionCwd, resolvedCwd: resolveHostShellWorkingDirectory(executionCwd, finalInput.cwd as string | undefined),
          toolUseId: toolUse.id, plan: hostShellExecutionPlan, verifiedShellCommand,
        }, abortSignal);
      } catch (error) {
        const msg = `Shell preparation failed: ${errorMessage(error)}`;
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
      }
    }

    // Path containment runs on the SHAPE of the call — "this invocation carries
    // a command string" — not on the risk verdict derived from it. Gating on
    // `invocationCategory === "shell"` made the sensitive-path hard block and
    // the allowed-directory check reachable only for commands the classifier
    // had already decided were dangerous, so every way to get a mutating
    // command classified `read` was also a way to erase containment. A low-risk
    // judgement is never a reason to skip a control documented as
    // unoverridable.
    // Session-control calls carry a shell handle rather than a command; their
    // shell category still requires authorization, but has no paths to parse.
    // Broker requests carry guest paths. Reinterpreting them through host path
    // containment would turn valid /git, /tmp, or /logs operands into desktop
    // directory prompts. The exact one-shot grant and broker protocol schema
    // validate the guest request at execution time.
    if (hasShellCommandArgument(finalInput) && !brokeredHostShellRouteSelected()) {
      while (true) {
        let shellPathViolation: ShellPathPolicyViolation | null = null;
        if (hostShellToolName === "powershell") {
          const resolvedCwd = resolveHostShellWorkingDirectory(executionCwd, typeof finalInput.cwd === "string" ? finalInput.cwd : undefined);
          // Unpinned startup cannot run a native host preflight. The tool repeats
          // this gate after host consent or parses inside the selected container.
          for (const command of isPowerShellStartupPinned() && hostShellExecutionPlan?.substrate !== "mxc" ? extractShellCommands(finalInput) : []) {
            shellPathViolation = await findPowerShellCommandPathViolation(command, resolvedCwd, executionCwd, invocationRuntimeAllowedDirectories, blockReadsOutsideWorkingDirectories);
            if (shellPathViolation) break;
          }
        } else {
          // A command typed into a terminal runs in the directory that
          // terminal's shell reported (sealed with its approval scope), so
          // its relative operands resolve there, as a bash `cwd` would.
          const pathPolicyInput = isCanonicalTerminalRunTool(tool)
            ? { ...finalInput, cwd: terminalCommandScopeOf(approvalMemory).cwd }
            : finalInput;
          shellPathViolation = shellPathPolicyViolation(
            pathPolicyInput, executionCwd, invocationRuntimeAllowedDirectories, blockReadsOutsideWorkingDirectories,
            preparedShellInvocation ? preparedShellFacts(preparedShellInvocation) : undefined,
          );
        }
        if (!shellPathViolation) break;
        if (shellPathViolation.kind === "dynamic-path" || shellPathViolation.kind === "recursive-traversal") break;


        if (
          executionRoutePlan?.route === "disposable-container" &&
          isDisposablePathPolicyRelaxation(shellPathViolation.kind) &&
          (
            shellPathViolation.kind !== "sensitive-path" ||
            executionRoutePlan.disposableCapability?.kind === "workload-broker"
          )
        ) {
          // The current process is the revalidated v1 disposable guest. Only
          // guest namespace scope and analysis uncertainty may defer to its
          // outer confinement. Sensitive and invalid paths remain hard blocks.
          break;
        }

        if (shellPathViolation.kind === "sandbox-boundary" && shellPathViolation.path) {
          const canonicalPath = caseFoldForMatch(canonicalizePathForMatch(shellPathViolation.path));
          const dirLayerResult: PermissionCheckResult = {
            decision: "ask",
            reason: `out-of-allowed-dir: ${shellPathViolation.path} (not in additionalDirectories)`,
            layer: 1,
            denyReasons: [
              {
                layer: 1,
                reason: "out-of-allowed-dir",
                source: "directory-policy",
              },
            ],
          };
          const resolution = await requestOutOfAllowedDirectoryAccess(
            { filePath: shellPathViolation.path, canonicalPath },
            dirLayerResult,
            null,
            [],
          );
          if (!resolution.allowed) return resolution.result;
          if (resolution.permissionResult) {
            permissionResult = resolution.permissionResult;
            directoryAuthorization = { permission: resolution.permissionResult, humanApproved: resolution.humanApproved === true };
          }
          applyApprovedDirectory(resolution.approvedDirectory);
          if (resolution.permissionResult?.forceModal !== true && invocationPermissionContext.manualRerun !== true) propagateGrantScope(resolution.approvedDirectory, resolution.scope);
          for (const path of resolution.permissionResult?.pipelineRequest?.paths ?? []) applyApprovedDirectory(path.canonical);
          continue;
        }

        const msg = t("be_executor.shellPathPolicyBlock", { name: toolUse.name, reason: shellPathViolation.reason })
          + buildPolicyDenialGuidance({
            rule: `shell-path-policy/${shellPathViolation.kind}`,
            operand: shellPathViolation.candidate ?? shellPathViolation.path,
            retry: "never",
            // Only a boundary verdict is about scope. A recursive-traversal or
            // dynamic-path refusal is about the command's shape, and naming
            // directories there sends the model to re-target instead of to
            // rewrite.
            alternative: shellPathViolation.kind === "sandbox-boundary"
              ? "retarget-under-authorized-directory"
              : shellPathViolation.kind === "sensitive-path"
                ? "path-never-readable"
                : "restructure-command",
            allowedDirectories: invocationAllowedScope.directories,
            readsUnfenced: !blockReadsOutsideWorkingDirectories,
          });
        const durationMs = Date.now() - startTime;
        const blockedPermission: PermissionCheckResult = {
          decision: "deny",
          reason: shellPathViolation.reason,
          layer: 0,
          denyReasons: [
            { layer: 0, reason: "shell-path-policy", source: "directory-policy" },
          ],
        };
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
      }
    }

    // ── Step 2.5: structural shell command pre-validator ────────────
    //
    // One ladder position for "this command string is structurally refused",
    // Bash's execution view owns this structural stage. PowerShell's native
    // AST owns both structural and path admission in the preceding stage.
    // Both complete before approval/permit consumption; no Bash interpretation
    // is applied to PowerShell source.
    //
    // Hooks are allowed to rewrite tool inputs. Validate the final invocation,
    // not the original provider payload, so a hook cannot approve one command
    // and execute another.
    const denyStructuralShellCommand = async (
      msg: string,
      auditReason: string,
    ): Promise<ToolResult> => {
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: auditReason, layer: 0 }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    };
    if (
      isCanonicalPowerShellTool(tool) &&
      executionRoutePlan?.route === "disposable-container" &&
      typeof finalInput.command === "string"
    ) {
      const structuralReason = await validatePowerShellCommandStructure(finalInput.command);
      if (structuralReason !== null) {
        return await denyStructuralShellCommand(
          `PowerShell command blocked: ${structuralReason}`,
          structuralReason,
        );
      }
    }
    // Boolean, not the type guard: narrowing `tool` to `PowerShellTool` here
    // would widen it to a union for the rest of the function.
    if (
      !isCanonicalPowerShellTool(tool) &&
      services.bashAstValidator &&
      executionRoutePlan?.disposableCapability?.kind !== "workload-broker"
    ) {
      const bashResult = services.bashAstValidator.validate(toolUse.name, finalInput, preparedShellInvocation ? { cwd: executionCwd, facts: preparedShellFacts(preparedShellInvocation) } : undefined);
      if (bashResult.decision === "deny") {
        const msg = t("be_executor.bashAstBlock", { reason: bashResult.reason ?? "", patternId: bashResult.patternId ?? "" })
          + buildPolicyDenialGuidance({
            rule: `bash-ast/${bashResult.patternId ?? "unnamed"}`,
            operand: bashResult.operand,
            retry: "never",
            // Structural: the shape was refused, so a different target is the
            // one retry guaranteed to fail again.
            alternative: "restructure-command",
            allowedDirectories: invocationAllowedScope.directories,
          });
        return await denyStructuralShellCommand(msg, bashResult.reason ?? "bash AST");
      }
      if (bashResult.decision === "warn") {
        log.warn(`${bashResult.reason}`);
      }
    }

    if (preparedShellInvocation && hostShellExecutionPlan?.mode === "asrt") {
      bindPreparedShellExecutableReadPaths(preparedShellInvocation);
    }

    const targetFilePaths = brokeredFileRouteSelected
      ? []
      : extractTargetFilePaths(tool, finalInput, executionCwd);
    // Frozen-canonical contract: canonicalize once here and reuse the same
    // string for Layer 0 (sensitive-path) + Layer 1
    // (allowed-directories) checks below. No layer re-resolves the path.
    const unsealedRuleSubject = scopedRuleSubjectFor(tool, finalInput, executionCwd);
    const canonicalTargets: Array<{ filePath: string; canonicalPath: string; runtimePath: string }> = [];
    for (const filePath of targetFilePaths) {
      let runtimePath: string;
      try {
        // Native edits must distinguish a new suffix from a dangling or
        // unreadable ancestor before sealing the one shared path snapshot.
        if (unsealedRuleSubject?.kind === "edit") {
          const resolved = resolveShellFilesystemPath(filePath, executionCwd);
          if (process.platform !== "win32" && resolved.includes("\\")) throw new Error("Ambiguous write path");
          runtimePath = foldCanonicalPathSeparators(resolved);
        } else {
          runtimePath = canonicalizePathForMatch(filePath);
        }
      } catch {
        const reason = "Cannot resolve write target";
        const blocked: PermissionCheckResult = { decision: "deny", reason, layer: 0 };
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, reason, true, meta, undefined, durationMs);
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, reason, true, startTime, blocked, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: reason, is_error: true, durationMs });
      }
      canonicalTargets.push({ filePath, canonicalPath: caseFoldForMatch(runtimePath), runtimePath });
    }
    const declaredPaths = (tool.pathFields ?? []).flatMap((field) => selectDeclaredPathValues(finalInput, field)).filter((path): path is string => typeof path === "string");
    invocationPermissionContext.paths = canonicalTargets.flatMap((target) => {
      const operands = declaredPaths.filter((path) => resolveToolPathForPermission(path, executionCwd) === target.filePath);
      return (operands.length > 0 ? operands : [target.filePath]).map((path) => {
        const expanded = expandLeadingTilde(path);
        return { lexical: isAbsolute(expanded) ? expanded : executionCwd + "/" + expanded, canonical: target.canonicalPath,
          effect: canonicalFileTool !== undefined && ["copy_path", "extract_archive"].includes(canonicalFileTool.name) && typeof finalInput.sourcePath === "string" && resolveToolPathForPermission(finalInput.sourcePath, executionCwd) === target.filePath ? "read" as const : requiredTier(invocationCategory) };
      });
    });
    if (canonicalFileTool?.name === "delete_file") {
      const criticalTarget = canonicalTargets.map((target) => criticalDeleteTargetFor({ lexical: target.filePath, canonical: target.canonicalPath }, [executionCwd])).find((target) => target !== undefined);
      if (criticalTarget) invocationPermissionContext.floor = { code: "critical-delete", reason: "Deleting this root requires a fresh human approval." };
    }

    // Layer 0/1 path-scope predicate lives in PermissionManager (SOT V2).
    // The executor keeps canonicalization (above) + the layer-0 deny and
    // layer-1 modal wiring below; PM only answers "which target is sensitive
    // / out-of-allowed". Static call so this runs even when no
    // PermissionManager instance is wired (the Layer 0/1 hard-block and
    // out-of-directory prompt are not gated on `services.permissionManager`).
    //
    // The effect these targets carry comes from the invocation's category via
    // `requiredTier`, the same mapping that decides which grant tier covers a
    // call, so "what counts as a read" is answered once for grants and for
    // containment. Only `read` maps to a read effect; `write`, `shell`,
    // `network` and `meta` are all write-equivalent here.
    const pathEffect = requiredTier(invocationCategory);
    // A brokered canonical file tool targets the disposable guest namespace.
    // Host sensitive-path and allowed-directory policy must not reinterpret
    // `/git`, `/var`, `/root`, etc. as controller paths. The exact branded
    // grant and protocol's clean POSIX path schema remain mandatory at execute.
    const sensitiveTarget = brokeredFileRouteSelected
      ? undefined
      : PermissionManager.checkPathScope({
          canonicalTargets,
          allowedDirectories: invocationAllowedScope.directories,
          effect: pathEffect,
          blockReadsOutsideWorkingDirectories,
        }).sensitiveHit;
    const targetFilePath = canonicalTargets[0]?.filePath;
    const sensitivePathPattern = sensitiveTarget?.pattern ?? null;

    // Turn-scope admission. `pluginTurnScopeTarget` answers "which plugin does
    // this invocation reach into" for BOTH plugin-owned surfaces the model can
    // pull in: a plugin's tools, and a plugin's SKILL body via
    // `skill_load("plugin:<id>:<localId>")` — the latter is a builtin tool, so
    // keying on `source === "plugin"` alone left it ungated while the prompt
    // catalog was already filtering the very same skills out of view.
    const pluginScopeTarget = pluginTurnScopeTarget(tool, finalInput);
    if (pluginScopeTarget && invocationPermissionContext.allowedPluginIds) {
      const targetPluginId = pluginScopeTarget.pluginId;
      const pluginAllowed = !!targetPluginId && invocationPermissionContext.allowedPluginIds.has(targetPluginId);
      if (!pluginAllowed) {
        const msg = t("be_executor.permBlockPluginOutOfScope", { name: toolUse.name, pluginId: targetPluginId ?? "(unknown)" });
        const durationMs = Date.now() - startTime;
        const blockedPermission: PermissionCheckResult = {
          decision: "deny",
          reason: `plugin ${pluginScopeTarget.surface} outside active allowed plugin scope`,
          layer: 0,
        };
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
      }
    }

    if (sensitivePathPattern) {
      const msg = t("be_executor.sensitivePathBlock", { name: toolUse.name, source, filePath: sensitiveTarget?.filePath ?? "", pattern: sensitivePathPattern ?? "" })
        + buildPolicyDenialGuidance({
          rule: `sensitive-paths/${sensitivePathPattern}`,
          operand: sensitiveTarget?.filePath,
          retry: "never",
          // Layer 0: no directory grant reaches this path, so listing the
          // authorized ones would only suggest a retry that cannot work.
          alternative: "path-never-readable",
          allowedDirectories: invocationAllowedScope.directories,
        });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: `sensitive path hard-block: ${sensitivePathPattern}`,
        layer: 0,
        denyReasons: [
          { layer: 0, reason: "sensitive-path", source: "sensitive-paths" },
        ],
      };
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }

    // Project roots deliberately exclude the broader Layer 1 defaults and per-turn temp grants.
    const rawProjectRoots = [executionCwd, ...(permissionContext.projectDirectories ?? [])];
    const projectRoots = sanitizeAllowedDirectories(rawProjectRoots);
    const lexicalProjectRoots = rawProjectRoots.map((root) => caseFoldForMatch(foldCanonicalPathSeparators(resolveToolPathForPermission(root, executionCwd))));
    const nativeFileWrite = isCanonicalFileTool(tool) && invocationCategory === "write" && !brokeredFileRouteSelected;
    const insideProject = nativeFileWrite && areProjectWriteTargetsInside(canonicalTargets, lexicalProjectRoots, projectRoots,
      unsealedRuleSubject?.kind === "edit" ? unsealedRuleSubject.paths : undefined);
    // Outside project roots, preserve the existing reviewer lane for supported host edits.
    const unsupportedTransfer = nativeFileWrite && insideProject && (tool.name === "extract_archive" || (tool.name === "copy_path"
      && !(typeof finalInput.sourcePath === "string" && await isFileCopyCheckpointSupported(finalInput.sourcePath, executionCwd))));
    const checkpointAvailable = !nativeFileWrite || unsupportedTransfer
      ? false
      : insideProject ? await isCodeCheckpointAvailable(canonicalTargets.map((target) => target.runtimePath)) : undefined;
    const fileWritePolicy = isCanonicalFileTool(tool) && invocationCategory === "write" ? { insideProject, checkpointAvailable, directoryApproved: false } : undefined;

    // A saved Edit scope grants only the sealed file targets of this call.
    // It never becomes a session directory grant or widens a plugin's scope.
    const editSubject = unsealedRuleSubject?.kind === "edit" ? { ...unsealedRuleSubject, targets: canonicalTargets } : undefined;
    if (!brokeredFileRouteSelected && editSubject?.kind === "edit" && services.permissionManager) {
      await services.permissionManager.ensureProjectRulesLoaded(executionCwd);
      const editDecision = services.permissionManager.checkDetailed(toolUse.name, source, invocationCategory, overlayTriggerOrigin, {
        ...invocationPermissionContext, ruleSubject: editSubject, projectRulesCwd: executionCwd,
      });
      if (editDecision.decision === "allow" && services.permissionManager.checkScopedRules(editSubject, executionCwd).decision === "allow") {
        invocationAllowedScope = { directories: [...invocationAllowedScope.directories, ...canonicalTargets.map((target) => target.canonicalPath)] };
        invocationRuntimeAllowedDirectories = [...invocationRuntimeAllowedDirectories, ...canonicalTargets.map((target) => target.runtimePath)];
      }
    }

    // ── Step 2.6: Layer 1 — Allowed Directories ─────
    //
    // Frozen-canonical: reuse `canonicalTargetPath` from above (already
    // realpath'd + case-folded). No re-canonicalization in this block.
    //
    // Skipped when no path-typed input was extracted (e.g. MCP network
    // calls). Shell tools run the same Layer 1 request path above because
    // their filesystem operands are parsed from the command string. Native
    // host tools and plugin tools both declare
    // path-bearing arguments on Tool.pathFields; plugin entries are copied
    // from host-validated manifest authority metadata by plugin-tool-adapter.
    if (canonicalTargets.length > 0 && !brokeredFileRouteSelected) {
      while (true) {
        // Re-run the Layer 1 predicate each iteration: applyApprovedDirectory
        // widens `invocationAllowedScope` after a grant, so the scope must be
        // re-supplied to PermissionManager.checkPathScope (SOT V2).
        const pathScope = PermissionManager.checkPathScope({
          canonicalTargets,
          allowedDirectories: invocationAllowedScope.directories,
          effect: pathEffect,
          blockReadsOutsideWorkingDirectories,
        });
        const outOfAllowedTarget = pathScope.outOfAllowed;
        if (!outOfAllowedTarget) {
          // A read the directory list would have refused leaves no prompt and
          // no grant behind it, so the audit row is the only record that the
          // asymmetry — not a user authorization — is what admitted it.
          if (pathScope.readOutsideScope) {
            await services.auditWriter.auditPermissionGrant({
              toolName: toolUse.name,
              source,
              category: invocationCategory,
              directory: pathScope.readOutsideScope.filePath,
              policyRule: READ_ANYWHERE_AUDIT_RULE,
              permissionContext: invocationPermissionContext,
              audit: currentAuditMetadata(finalInput),
            });
          }
          break;
        }
        const dirLayerResult: PermissionCheckResult = {
          decision: "ask",
          reason: `out-of-allowed-dir: ${outOfAllowedTarget.filePath} (not in additionalDirectories)`,
          layer: 1,
          denyReasons: [
            {
              layer: 1,
              reason: "out-of-allowed-dir",
              source: "directory-policy",
            },
          ],
        };
        if (rationaleResumeContext) {
          return returnRationaleResumeBlock(
            "current allowed-directory scope no longer covers the sealed action",
            finalInput,
            dirLayerResult,
          );
        }
        const resolution = await requestOutOfAllowedDirectoryAccess(
          outOfAllowedTarget,
          dirLayerResult,
          sensitivePathPattern,
          tool.pathFields ?? [],
        );
        if (!resolution.allowed) return resolution.result;
        if (resolution.permissionResult) {
          permissionResult = resolution.permissionResult;
          directoryAuthorization = { permission: resolution.permissionResult, humanApproved: resolution.humanApproved === true };
        }
        applyApprovedDirectory(resolution.approvedDirectory);
        if (resolution.permissionResult?.forceModal !== true && invocationPermissionContext.manualRerun !== true) propagateGrantScope(resolution.approvedDirectory, resolution.scope);
        // The one card authorizes the complete sealed invocation; saved folders retain only the chosen scope.
        for (const target of canonicalTargets) applyApprovedDirectory(target.canonicalPath);
        if (fileWritePolicy && invocationPermissionContext.headless !== true) fileWritePolicy.directoryApproved = true;
        break;
        // allow-once / allow-session / allow-always — fall through to Step 3
        // (full Layer 3 check still runs; Layer 1 is necessary, not
        // sufficient).
      }
    }
    if (
      hostShellExecutionPlan !== undefined &&
      hostShellToolName !== undefined &&
      hostShellRequiresExplicitApproval
    ) {
      hostShellExecutionPermitBinding = buildHostShellExecutionPermitBinding({
        plan: hostShellExecutionPlan,
        toolName: hostShellToolName,
        toolUseId: toolUse.id,
        rawInput: finalInput,
        executionCwd,
        extraAllowedDirectories: invocationRuntimeAllowedDirectories,
      });
    }
    const evaluationContext = makeEvaluationContext({
      pathFields: tool.pathFields ?? [],
      targetFilePaths,
      sensitivePathsAdjacent: sensitivePathPattern ? [sensitivePathPattern] : [],
    });

    const authorization = await authorizeToolInvocation({
      directoryAuthorization,
      paths: invocationPermissionContext.paths,
      secretRead: invocationPermissionContext.secretRead,
      floor: invocationPermissionContext.floor,
      admissionDenial: invocationPermissionContext.admissionDenial,
      fileWritePolicy,
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
      hostShellExecutionPlanAudit,
      hostShellPathPolicyRelaxations: executionRoutePathPolicyRelaxations,
      hostShellExecutionPermitBinding,
      hostShellApprovalDecision,
      verifiedShellCommand,
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
      targetFilePaths,
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
      permissionResult,
      resolvedPluginOperation,
      pluginOperationPrincipal,
    });
    if ("tool_use_id" in authorization || authorization.outcome === "rationale-required") {
      return authorization;
    }
    permissionResult = authorization.permissionResult;
    hostShellApprovalDecision = authorization.hostShellApprovalDecision;
    hostShellAllowRuleDecision = authorization.hostShellAllowRuleDecision;
    const decidedPathPolicyRelaxations = executionRoutePathPolicyRelaxations ?? [];

    if (brokeredFileRouteSelected &&
        (canonicalFileTool !== undefined || canonicalBrokerLifecycleTool !== undefined)) {
      try {
        const capability = await acquireConfiguredBrokerCapability();
        if (capability === null) {
          throw new Error("workload broker is no longer available");
        }
        normalizedCanonicalFileInput = canonicalFileTool === undefined
          ? finalInput
          : normalizeCanonicalFileToolInput(canonicalFileTool, finalInput);
        const router = await import("../permissions/execution-router.js");
        executionRouteGrant = router.issueBrokeredToolExecutionGrant({
          capability,
          toolName: (canonicalFileTool ?? canonicalBrokerLifecycleTool)!.name,
          toolUseId: toolUse.id,
          normalizedInput: normalizedCanonicalFileInput,
          cwd: executionCwd,
        });
      } catch (error) {
        return await returnExecutionRouteFailure(error);
      }
    } else if (executionRoutePlan?.route === "disposable-container") {
      if (executionRoutePlan.disposableCapability?.kind === "workload-broker") {
        try {
          await updateExecutionRoute(executionRouteRequirementKind);
          if (executionRoutePlan?.route !== "disposable-container" ||
              executionRoutePlan.disposableCapability?.kind !== "workload-broker") {
            throw new Error("brokered workload capability is no longer available");
          }
          const router = await import("../permissions/execution-router.js");
          executionRouteGrant = router.issueExecutionGrant(executionRoutePlan, {
            toolUseId: toolUse.id,
            toolName: hostShellToolName!,
            decidedPathPolicyRelaxations,
          });
        } catch (error) {
          return await returnExecutionRouteFailure(error);
        }
      } else {
        finalizeExecutionRouteGrant = async () => {
          // Hooks, admission, and audit readiness may await arbitrary work.
          // Re-observe confinement after all of them, then mint the one-shot
          // grant at the final handler boundary without a local fallback.
          await updateExecutionRoute(executionRouteRequirementKind);
          if (executionRoutePlan?.route !== "disposable-container" ||
              executionRoutePlan.disposableCapability?.kind !== "operator-container") {
            throw new Error("disposable execution capability is no longer available");
          }
          const router = await import("../permissions/execution-router.js");
          executionRouteGrant = router.issueExecutionGrant(executionRoutePlan, {
            toolUseId: toolUse.id,
            toolName: hostShellToolName!,
            decidedPathPolicyRelaxations,
          });
          return executionRouteGrant;
        };
      }
    } else if (executionRoutePlan !== undefined && hostShellToolName !== undefined) {
      finalizeExecutionRouteGrant = async () => {
        await updateExecutionRoute(executionRouteRequirementKind);
        const router = await import("../permissions/execution-router.js");
        router.assertDecidedPathPolicyRelaxations(executionRoutePlan!, decidedPathPolicyRelaxations);
        return undefined;
      };
    }

    const executeAuthorized = () => executeAuthorizedToolInvocation({
      services,
      tool,
      toolUse,
      source,
      trust,
      invocationCategory,
      declaredCategoryForEffectShadow,
      blockReadsOutsideWorkingDirectories,
      evaluationContext,
      approvalCacheKey,
      approvalPurpose,
      approvalReasonPrefix,
      targetFilePaths,
      sensitivePathPattern,
      invocationAllowedScope,
      hostShellExecutionPlanAudit,
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
      permissionResult,
      humanApproved: authorization.humanApproved,
      approvedPolicyEpoch: authorization.approvedPolicyEpoch,
      permissionRecheckResult: authorization.permissionRecheckResult,
      replayRootBinding: opts.replayRootBinding,
      abortSignal,
      hostShellExecutionPermitBinding,
      hostShellApprovalDecision,
      hostShellAllowRuleDecision,
      hostShellExecutionPlan,
      hostShellRequiresExplicitApproval,
      executionRouteGrant,
      finalizeExecutionRouteGrant,
      preparedShellInvocation,
      verifiedShellCommand,
      invocationRuntimeAllowedDirectories,
      supportsA2AParentDelivery,
      spawnDepth,
      memoryIncludeUnscoped,
      a2aCausalContext,
      toolResultChunkReader,
      toolOutputCaptureFactory,
      executionCwd,
      parentEffectLedger,
      effectLedger,
      targetFilePath,
      preResult,
      scriptPre,
      resolvedPluginOperation,
      pluginOperationPrincipal,
      pluginAuthLifecycle,
    });
    const executedResult = permissionResult?.requiresCodeCheckpoint === true
      ? await withProjectWriteRoots(projectRoots, () => withRequiredCodeCheckpoint(executeAuthorized))
      : await executeAuthorized();
    const blockedSandbox = sandboxBlockForResult(executedResult);
    if (blockedSandbox !== undefined && hostShellToolName !== undefined && hostShellExecutionPlan?.mode === "asrt"
      && executedResult.is_error === true && blockedSandbox.command === finalInput.command && !abortSignal?.aborted
      && rationaleBatchContext === undefined && rationaleResumeContext === undefined) {
      // A recorded filesystem refusal creates a new exact host request. Every permission stage runs again.
      const retryResult = await runToolInvocation(services, {
        ...toolUse, id: randomUUID(), input: { ...structuredClone(finalInput), cwd: blockedSandbox.cwd, executionMode: "host",
          justification: "The filesystem sandbox blocked this command. It may already have performed part of the operation; this approval retries the same command without filesystem isolation." },
      }, randomUUID(), displayOrder, { ...opts, executionCwd, permissionContext: { ...invocationPermissionContext } });
      if ("tool_use_id" in retryResult) return { ...retryResult, tool_use_id: toolUse.id };
      throw new Error("A sandbox retry cannot suspend a rationale batch");
    }
    return executedResult;
    };
    try {
      return generationAccess && generationLease
        ? await generationAccess.runWithLease(generationLease, executeAdmitted)
        : await executeAdmitted();
    } finally {
      disposePreparedShellInvocation(preparedShellInvocation);
      generationLease?.release();
    }
  }
