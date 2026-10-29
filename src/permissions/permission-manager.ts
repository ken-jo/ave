import { inspectShellPermissionPaths } from "../tools/shell-path-policy.js";
import { isReadOnlyCommand } from "./reviewer/host-risk-inspector.js";
import { wrapperCommand } from "./rules/shell-prefix-policy.js";
import { verifiedShellParsed } from "./verified-shell-command.js";
import { currentHostTerminalTurn } from "../tools/host-terminal-turn.js";
import type { HostTerminalCommandScope } from "../tools/terminal-run.js";
import { isIssuedUserOwnedBrowserScope, type UserOwnedBrowserScope } from "./user-owned-browser-scope.js";
import { UserOwnedSurfaceStore } from "./user-owned-surface-store.js";
import type { UserOwnedSurface, UserOwnedSurfaceChoice } from "../shared/permissions-events.js";
import { UserOwnedSurfaceReviewError, type UserOwnedSurfaceReviewInput } from "./reviewer/user-owned-surface-reviewer.js";
import { runWithCeiling } from "../tools/executor-ceiling.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { isUntaintedToolTrustOrigin } from "../shared/chat-origin.js";
import { isCurrentShellRule, withCurrentShellRuleVersion, type ShellRuleVersion } from "../shared/shell-rule-version.js";


import { BuiltinLlmJudge, assertRiskClassificationTrace, traceRiskClassifier, type TracingRiskClassifier } from "./judge/builtin-llm-judge.js";
import { JudgeCircuitBreaker } from "./judge/judge-breaker.js";
import { JudgeContractError, JudgeFailure, isSameOrStricter, type JudgeLane, type JudgeRequest } from "./judge/judge-contract.js";
import { resolveJudge, type JudgeEngineDeps, type JudgeGate, type JudgeOutcome } from "./judge/judge-engine.js";
import { DEFAULT_JUDGE_SETTINGS, type JudgeBreakerSettings } from "./judge/judge-settings.js";
import { dirname, resolve } from "node:path";
import type { DenyRule, ToolCategory, ToolSource, ToolTrustOrigin } from "../tools/types.js";
import type { RemoteControllerAuthority } from "../shared/chat-origin.js";
import { permissionsFilePath as defaultPermissionsFilePath, readPermissionsFile, updatePermissionsFile, type PermissionsFile } from "./permissions-store.js";
import { PermissionRulesFileCorruptError, storedRuleInvalidReason, validatePermissionRule } from "./rules/rule-files.js";
import { listStoredProjectRules, projectRulesLocation } from "./rules/project-rule-files.js";
import type { ScopedPermissionRule, ScopedPermissionRuleError, ShellRuleDialect } from "../shared/permissions-events.js";
import { ProjectRuleScopes, evaluatePowerShellSubject, evaluateShellSubject, type HostTerminalRuleTarget } from "./rules/rule-scopes.js";
import { isRuleSpecifier, matchesWebFetchHost, parseRuleSpecifier } from "./rules/rule-specifier.js";
import { evaluateScopedRules, type ScopedRuleSubject, type ScopedRuleEvaluation } from "./rules/scoped-rule-matcher.js";
import { inspectShellCommand, parseShellFloorCommand } from "./rules/shell-exfiltration.js";
import { shellFloorInputExceeded, shellFloorParserBudgetExceeded } from "./rules/shell-floor-policy.js";
import { prepareShellFloorInput, type ShellFloorInput } from "./rules/shell-literal-data.js";
import { inspectPowerShellCommand, inspectPowerShellPermissionPaths, parsePowerShellCommand } from "./rules/powershell-exfiltration.js";
import type { DisposablePathPolicyRelaxation } from "./execution-router.js";
import { analyzeShellForRules } from "./rules/shell-rule-matcher.js";
import { isDestructiveShellArgv, noReusableRuleReason, MAX_LITERAL_COMMAND_LENGTH } from "./rules/shell-prefix-values.js";
import { isStagedTurnSource } from "../shared/staged-origins.js";
import { PERMISSION_REVIEWER_FRAMEWORK_VERSION } from "../shared/permission-reviewer-framework.js";
import type { ApprovalMemory, UserApprovalHitPayload, UserApprovalVerdict } from "../shared/permissions-events.js";
import { decidePermission, NO_APPROVER_MESSAGE, type PermissionDecisionRequest } from "./decision-pipeline.js";
import { isHostNetworkSubject } from "./host-network-subject.js";
import { canonicalEgressHost, isValidEgressPort } from "./egress-grants.js";
import {
  DisabledRiskClassifier,
  RuleBasedRiskClassifier,
  maxVerdict,
  isDestructiveShellText,
  type LlmRiskClassificationTrace,
  screenEgressRequest,
  type RiskClassifier,
  type RiskVerdict,
  type ToolInvocationContext,
} from "./reviewer/risk-classifier.js";
import {
  resolveReviewerSandboxCacheState,
  type DisposableSubstrate,
  type ReviewerSandboxCacheState,
} from "./sandbox-capability.js";
import {
  getHostShellExecutionPlanAuditProjection,
  type HostShellExecutionPlan,
} from "./host-shell-execution-plan.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import type { VerdictCache } from "./reviewer/verdict-cache.js";
import type { RecentlyDeniedStore } from "./reviewer/recently-denied.js";
import { globMatch } from "../lib/glob-matcher.js";
import {
  approvalCacheKeyIdentity,
  approvalConversationRoot,
  isExactArgsDecision,
  lookupApproval,
  canonicalStringify,
  captureApprovalWorkingDirectory,
} from "./user-approval-store.js";
import { buildSandboxAuditEntry } from "../audit/sandbox-audit.js";
import { emitSandboxAudit } from "../audit/sandbox-audit-sink.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import {
  isAdmissionDeniedPath,
  criticalDeleteTargetFor,
  createPermissionPathEvidence,
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "./sensitive-paths.js";
import { isPathAllowedForEffect, type PathEffect } from "./allowed-directories.js";
import { errorMessage } from "../shared/error-message.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import type { ApprovalSurface } from "../shared/authorization-required.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { capturePersistedPolicyVersion, isPersistedPolicyVersionCurrent, persistedPolicyVersionForContent, type PersistedPolicyVersion } from "./persisted-policy-version.js";
import {
  captureShellWorkingDirectoryIdentity,
  matchesShellWorkingDirectoryIdentity,
  type ShellWorkingDirectoryIdentity,
} from "./shell-working-directory-identity.js";

export type PermissionDecision = "allow" | "deny" | "ask";

// Which host shell's language a shell rule subject is written in.


// The first Tailnet-controller release intentionally excludes tools that either create work beyond the current turn or expand the tool/instruction surface. This is a host-owned boundary; it is evaluated before any local permission memory, allow rule, reviewer, or global allow-mode decision.
const TAILNET_CONTROLLER_P1_BLOCKED_TOOLS = new Set([
  "bash",
  "bash_kill",
  "bash_output",
  "powershell",
  "request_plugin",
  "routine_schedule",
  "skill_load",
  "tool_search",
]);

// Shared fail-closed check for the executor fallback when no manager is wired.
export function isTailnetControllerP1BlockedTool(toolName: string): boolean {
  return TAILNET_CONTROLLER_P1_BLOCKED_TOOLS.has(toolName);
}

// graduated grant tier. A persisted "Allow always" grant carries a tier so a grant made on a read tool ("read") does NOT silently authorize a later write/shell/network/meta invocation of the same pattern, while a grant made on a write/shell/network/meta tool ("write") covers everything. This makes a grant category-aware instead of the previous flat, all-or-nothing behaviour. The ranking is monotone (read < write): a grant is only ever upgraded, never downgraded, and the covered set widens with the tier.
export type GrantTier = "read" | "write";

// item-4 — a single path-scoped "Allow always" grant pruned by PermissionManager.prunePathGrantsUnderRoot. Returned so the caller (workspace.removeRoot) can write a redacted per-pattern audit tuple instead of only a count. `path` is the RAW extracted grant path (unredacted) — the caller is responsible for `redactFsPath`-ing it before it reaches the audit log; it never crosses the IPC boundary to the renderer.
export interface PrunedGrant {
  // The full persisted rule pattern, e.g. `write_file:path:/abs/target`.
  pattern: string;
  // Tool-name prefix of the grant (`write_file`), or the whole pattern if the marker split is unexpectedly absent (defensive — should not happen).
  toolName: string;
  // Graduated grant tier at prune time (legacy/absent → grandfathered write).
  tier: GrantTier;
  // Raw absolute path the grant targeted (UNREDACTED — caller must redact).
  path: string;
}

export interface PermissionRule extends ShellRuleVersion {
  // Either a legacy glob over the tool name / approval cache key (`web_fetch`, `write_file:path:/abs`) or a rules-language specifier (`Bash(git status *)`, see `rules/rule-specifier.ts`). Classified by shape.
  pattern: string;

  // Precedence is deny > ask > allow regardless of order or specificity.
  action: "allow" | "deny" | "ask";

  source?: ToolSource;
  // Untiered allow grants retain legacy write authority; deny rules ignore tiers.
  tier?: GrantTier;
}

// Reviewer routes retain their foreground or headless audit identity. Automatic review permits LOW/MEDIUM; HIGH asks in foreground and denies when no approval surface is available.
export type ReviewerLane = "foreground-auto" | "headless";

export type ReviewerDispatchOutcome =
  | "fresh"
  | "cache"
  | "approval-memory"
  // Rule verdict is final by construction; the LLM was never consulted.
  | "host-determined"
  | "unavailable"
  | "error"
  | "timeout"
  | "malformed"
  | "sandbox-state-changed";

export type ReviewerAutoDecisionOutcome = Extract<
  ReviewerDispatchOutcome,
  "fresh" | "cache" | "approval-memory" | "host-determined"
>;

// Exhaustive fail-closed SOT for reviewer outcomes that may auto-decide.
export function isReviewerAutoDecisionOutcome(
  outcome: ReviewerDispatchOutcome | undefined,
): outcome is ReviewerAutoDecisionOutcome {
  if (outcome === undefined) return false;
  switch (outcome) {
    case "fresh":
    case "cache":
    case "approval-memory":
    // Host-determined is the STRONGEST auto-decision basis, not the weakest: the verdict came from a deterministic rule the host owns, so there is no model judgement to second-guess before acting on it.
    case "host-determined":
      return true;
    case "unavailable":
    case "error":
    case "timeout":
    case "malformed":
    case "sandbox-state-changed":
      return false;
    default: {
      const exhaustive: never = outcome;
      void exhaustive;
      return false;
    }
  }
}

export interface PermissionCheckResult {
  reasonCode?: string;
  pipelineRequest?: PermissionDecisionRequest;
  requiresCodeCheckpoint?: true;
  decision: PermissionDecision;
  reason: string;
  layer: number;
  // Layer 5 reviewer routing marker. Only PermissionManager may set this. Executor must not infer reviewer eligibility from `decision: "ask"` because overlay-trigger, strict, and low-trust MCP asks are hard user-approval gates.
  reviewer?: {
    route: ReviewerLane;
    verdict?: RiskVerdict;
    outcome?: ReviewerDispatchOutcome;
    // Host-issued deterministic evidence for this exact invocation.
    approvalBasis?: ReviewerApprovalBasis;
  };
  // Per-invocation hard-ask marker. When `true`, this `ask` decision MUST be confirmed by the user on every invocation and is NEVER auto-skipped by the explicit-approval memory store (Store B). Policy sets it only after choosing a hard user-approval lane; `decisionOverride: "ask"` may instead use the common foreground reviewer route when that route is eligible.
  forceModal?: boolean;
  // Permission policy.5 Layer 2 — structured deny reasons for audit forensics. The pipeline records the *current* deny entry only (short-circuit evaluation; later layers are skipped). Hypothetical other-layer decisions belong to dry-run mode, not normal audit. Each entry: { layer, reason, source } layer — which Permission policy layer fired (0=sensitive, 1=allowed-dir, …) reason — short machine-readable code (e.g. "out-of-allowed-dir") source — emitter ("directory-policy", "sensitive-paths", …)
  denyReasons?: ReadonlyArray<{
    layer: number;
    reason: string;
    source: string;
  }>;
}

export interface PermissionCheckContext {
  userOwnedBrowser?: UserOwnedBrowserScope;
  hostTerminalTurn?: HostTerminalCommandScope;
  trustOrigin?: ToolTrustOrigin;
  approvalSurface?: ApprovalSurface;
  mcpReadOnlyHint?: boolean;
  manualRerun?: boolean;
  secretRead?: boolean;
  floor?: PermissionDecisionRequest["floor"];
  admissionDenial?: PermissionDecisionRequest["admissionDenial"];
  paths?: PermissionDecisionRequest["paths"];
  shellReadOnlyProven?: boolean;
  shellEscalated?: boolean;
  // Host-derived native file facts; never accepted from tool arguments.
  fileWritePolicy?: { insideProject: boolean; checkpointAvailable?: boolean; directoryApproved: boolean };
  disposableSubstrate?: DisposableSubstrate;
  // Host-only bound native execution; JSON and terminal callers cannot issue it.
  verifiedShellCommand?: import("./verified-shell-command.js").VerifiedShellCommand;
  // Host-issued per-invocation substrate, sealed before permission evaluation.
  hostShellExecutionPlan?: HostShellExecutionPlan;
  // No human approval surface is available; the pipeline denies any human fallback.
  headless?: boolean;
  // The app remains open while its owner is away; cards wait using the configured owner-away limit.
  ownerUnattended?: boolean;
  // Permission policy — full approval-cache identity for authority-sensitive tools. When present, user allow rules / allow-always entries match this key instead of the bare tool name so a benign prior approval cannot silently authorize a later call with a broader argument scope.
  approvalCacheKey?: string;
  // Host-owned remote-controller provenance; bypasses every remembered allow.
  remoteControllerAuthority?: RemoteControllerAuthority;
  // Tool-author `decisionOverride` for `meta`-category builtin tools, carried from the executor so the post-computation guard owns re-elevation (V1 SOT). A foreground `"ask"` meta invocation uses the same reviewer route as write/shell/network in automatic execution mode; otherwise it remains a per-invocation `forceModal` ask. `"always-allow-with-audit"` is short-circuited before checkDetailed runs. Non-meta callers pass `undefined`.
  decisionOverride?: "ask" | "always-allow-with-audit";
  // Host-built rule subject. Native file subjects retain the sealed path snapshot; mediated fetches and MCP use actual destination/tool identity. Shell dialects share floors; Bash rules match only the bash dialect.
  // `hostTerminal`: a bash command typed into the user's own host terminal; the shared user-owned-surface session choice authorizes agent actions.
  ruleSubject?: { kind: "shell"; dialect: ShellRuleDialect; command: string; cwd?: string; hostTerminal?: HostTerminalRuleTarget } | ScopedRuleSubject;
  // project whose per-project rule file applies. The caller must have awaited PermissionManager.ensureProjectRulesLoaded for it.
  projectRulesCwd?: string;
  // Host-only per-invocation route; a missing shell route is plain (no sandbox). pathPolicyRelaxations comes from the selected execution plan (executionPlanPathPolicyRelaxations); missing means none.
  shellExecution?: { runsSandboxed: boolean; pathPolicyRelaxations?: readonly DisposablePathPolicyRelaxation[]; environmentSnapshot?: Readonly<Record<string, string | undefined>> };
  // Conversation the invocation belongs to: selects its "This session" shell rules (`addSessionRule`).
  sessionId?: string;
  // Host-detected approval-store corruption is an admission failure, naming the file.
  permissionStoreError?: string;
}

type HostTerminalPermissionContext = Pick<PermissionCheckContext, "hostTerminalTurn" | "userOwnedBrowser" | "trustOrigin" | "sessionId" | "remoteControllerAuthority" | "headless" | "approvalSurface">;

// Permission policy input bundle for reviewer-agent dispatch. Set when the caller wants the headless lane to consult the Layer 5 classifier (rather than the temporary "reviewer → ask" mapping).
export interface ReviewerDispatchInput {
  // Original host policy result; dispatch must preserve its per-call authority and reason.
  permissionDecision?: Pick<PermissionCheckResult, "decision" | "layer" | "reason" | "reviewer" | "pipelineRequest">;
  // Host invocation identity shared by scope assessment and ordinary review.
  invocationId: string;
  // Conversation whose turn is being reviewed.
  sessionId?: string;
  source: ToolSource;
  category: ToolCategory;
  // Manifest-declared path-bearing argument selectors. Dotted selectors are supported.
  pathFields: readonly string[];
  // Finalized executable input. Redact at display and persistence sinks, never before classification.
  finalInput: Record<string, unknown>;
  // The cwd the tool will execute against. Threaded into ToolInvocationContext.executionCwd so the reviewer resolves path arguments with the enforcer's resolver (resolveToolPathForPermission) instead of `process.cwd`. Required so a producer cannot silently reintroduce the divergence.
  executionCwd: string;
  // Metadata-only projection for audit sinks; never an authority input.
  auditInput?: Record<string, unknown>;
  // Invocation identity for local approval/cache matching, when it must differ from finalInput. It no longer normally does — the pipeline lanes pass one raw object — so this defaults to `finalInput`. Retained for callers that genuinely key approval identity on a narrowed projection.
  cacheIdentityInput?: Record<string, unknown>;
  // Captured policy/sandbox context for user review.
  evaluationContext?: PermissionEvaluationContext;
  // Recent user-authored message used for reviewer context-quality checks.
  conversationContext?: {
    recentUserMessage?: string;
    currentTaskStep?: string;
  };
  allowedDirectories: string[];
  sensitivePathsAdjacent: string[];
  // Cache identity must include the caller's trust origin. A high-trust verdict cached for `user-keyboard` is unsafe to serve to an `llm-tool-arg` invocation of the same shape — the underlying intent differs even when arguments match. Required so the verdict-cache lookupKey hash always includes origin.
  trustOrigin: ToolTrustOrigin;
  // Tool-declared authority cache identity, when present.
  approvalCacheKey?: string;
  // What a remembered decision is keyed on; host-derived with approvalCacheKey.
  approvalMemory?: ApprovalMemory;
  // When true, out-of-allowed-dir access also routes to the reviewer.
  outOfAllowedDir?: boolean;
  // Sandbox-write LOW requires a host-computed owning root and verified path containment; manifest self-attestation carries no authority.
  ownerPluginSandboxRoot?: string;
  // Originating external MCP stdio server id (from `Tool.mcpServerId`). Threaded so the reviewer reports the GENUINE asrt capability for a server whose worker was actually ASRT-wrapped (and so the verdict cache scopes by the real substrate). Omitted for non-MCP calls.
  mcpServerId?: string;
  // worker-confinement — originating plugin worker identity (from Tool pluginId/workerId). Both fields are required for plugin calls to report a genuine ASRT capability; omitted values keep the historical unwrapped plugin substrate (`none`).
  pluginId?: string;
  workerId?: string;
  // Executor-sealed substrate for canonical builtin shell invocations only.
  hostShellExecutionPlan?: HostShellExecutionPlan;
  // Executor-selected disposable guest for this invocation (shell or canonical file route).
  disposableSubstrate?: DisposableSubstrate;
}

// Host-only assessment evidence; structural lookalikes cannot grant persistence.
export interface ReviewerApprovalBasis {
  readonly ruleVerdict: RiskVerdict["level"];
  readonly outcome: ReviewerDispatchOutcome;
  readonly workingDirectory: Readonly<{ path: string; identity: string }>;
  readonly requestIdentity: string;
}
const issuedApprovalBases = new WeakSet<ReviewerApprovalBasis>();
export function matchesReviewerApprovalBasis(
  basis: ReviewerApprovalBasis | undefined,
  request: { reviewerOutcome?: ReviewerDispatchOutcome; toolName: string; args: unknown; source?: string; toolCategory?: string; trustOrigin?: string; approvalCacheKey?: string; evaluationContext?: PermissionEvaluationContext },
): basis is ReviewerApprovalBasis {
  return basis !== undefined && issuedApprovalBases.has(basis) && basis.outcome === request.reviewerOutcome &&
    basis.requestIdentity === canonicalStringify({
      toolName: request.toolName, args: request.args, source: request.source,
      category: request.toolCategory, trustOrigin: request.trustOrigin,
      approvalCacheKey: request.approvalCacheKey,
      executionCwd: request.evaluationContext?.executionCwd,
    });
}

// Evidence returned by review, consumed by the central permission pipeline.
export interface ReviewerDispatchResult {
  verdict: RiskVerdict;
  outcome: ReviewerDispatchOutcome;
  approvalBasis?: ReviewerApprovalBasis;
  // "hit" / "miss-stale" / "miss-expired" / "miss-not-found" — surfaces the audit-trail "from cache" hint (design v2.1 selective invalidation).
  cacheReason: "hit" | "miss-stale" | "miss-expired" | "miss-not-found";
  judge: JudgeOutcome;
}

type ReviewerAssessmentResult = Omit<ReviewerDispatchResult, "judge">;

interface JudgeDispatchResult {
  outcome: JudgeOutcome;
  reviewer?: ReviewerAssessmentResult;
  baseline?: ReviewerDispatchResult;
  ruleVerdict: RiskVerdict;
}

function reviewerResultForJudge(judged: JudgeDispatchResult): ReviewerDispatchResult {
  return {
    verdict: judged.reviewer?.verdict ?? judged.ruleVerdict,
    outcome: judged.reviewer && !isReviewerAutoDecisionOutcome(judged.reviewer.outcome) ? judged.reviewer.outcome : judged.outcome.judged && judged.outcome.fallback
      ? judged.outcome.fallback === "timeout" ? "timeout" : judged.outcome.fallback === "unparseable" ? "malformed" : judged.outcome.fallback === "unavailable" ? "unavailable" : "error"
      : judged.reviewer?.outcome ?? "host-determined",
    cacheReason: judged.reviewer?.cacheReason ?? "miss-not-found",
    ...(judged.reviewer?.approvalBasis ? { approvalBasis: judged.reviewer.approvalBasis } : {}),
    judge: judged.outcome,
  };
}


function reviewerAssessmentTrace(
  result: Pick<ReviewerDispatchResult, "verdict" | "outcome">,
  ruleVerdict: RiskVerdict,
): LlmRiskClassificationTrace {
  if (!isReviewerAutoDecisionOutcome(result.outcome)) {
    const kind = result.outcome === "timeout" ? "timeout" : result.outcome === "malformed" ? "unparseable" : result.outcome === "unavailable" ? "unavailable" : "error";
    throw new JudgeFailure(kind, result.verdict.reason);
  }
  return {
    ruleVerdict, finalVerdict: result.verdict, llmVerdict: null,
    outcome: result.outcome === "host-determined" ? "host-determined" : "fresh",
  };
}

// RejectResponse interface and MAX_REVIEWER_RETRIES deferred to follow-up.

function sameReviewerSandboxCacheState(
  a: ReviewerSandboxCacheState,
  b: ReviewerSandboxCacheState,
): boolean {
  const ac = a.capability;
  const bc = b.capability;
  return (
    a.source === b.source &&
    a.substrate === b.substrate &&
    a.wrapped === b.wrapped &&
    a.mcpServerId === b.mcpServerId &&
    a.pluginId === b.pluginId &&
    a.workerId === b.workerId &&
    ac.kind === bc.kind &&
    ac.confidence === bc.confidence &&
    ac.reason === bc.reason &&
    ac.platform === bc.platform &&
    ac.confines?.filesystem === bc.confines?.filesystem &&
    ac.confines?.process === bc.confines?.process &&
    ac.confines?.network === bc.confines?.network &&
    canonicalStringify(a.hostShellExecutionPlan ?? null) ===
      canonicalStringify(b.hostShellExecutionPlan ?? null) &&
    canonicalStringify(a.disposableSubstrate ?? null) ===
      canonicalStringify(b.disposableSubstrate ?? null)
  );
}
// LLM caller retry wiring lives in conversation-loop.ts scope. Tracked in follow-up issue for "LLM caller retry wiring" with max 2 retry / counter scope / args-change-reset contract.

// A Settings row, marked when its stored rule is inert (listed and removable, never matched).
function withInvalidReason(row: ScopedPermissionRule): ScopedPermissionRule {
  const reason = storedRuleInvalidReason(row);
  return reason === null ? row : { ...row, invalidReason: reason };
}

// The shell action a layer-3 allow-rule decision was evaluated for.
export interface ShellAllowRuleSubject {
  readonly toolName: string;
  readonly dialect: ShellRuleDialect;
  readonly command: string;
  readonly cwd: string;
}

export interface ShellAllowRuleAuthorization extends ShellAllowRuleSubject {
  readonly issuer: PermissionManager;
  readonly policyEpoch: string;
  readonly cwdIdentity: ShellWorkingDirectoryIdentity;
  readonly persistedPolicyVersions: readonly PersistedPolicyVersion[];
}

export function isShellAllowRulePolicyCurrent(
  authorization: ShellAllowRuleAuthorization,
): boolean {
  return authorization.issuer.getPolicyEpoch() === authorization.policyEpoch &&
    authorization.persistedPolicyVersions.every(isPersistedPolicyVersionCurrent);
}

// Remains live only under the issuing manager's policy and physical directory.
export function isShellAllowRuleAuthorizationCurrent(
  authorization: ShellAllowRuleAuthorization,
): boolean {
  return isShellAllowRulePolicyCurrent(authorization) &&
    matchesShellWorkingDirectoryIdentity(authorization.cwd, authorization.cwdIdentity);
}

// Host-issued decisions for a matched shell rule, bound to the action, policy and working directory.
const issuedShellAllowRuleDecisions = new WeakMap<
  PermissionCheckResult,
  ShellAllowRuleAuthorization
>();

// True when `result` is a live layer-3 allow-rule decision issued by `checkDetailed`.
export function isIssuedShellAllowRuleDecision(
  result: PermissionCheckResult | undefined,
  issuer?: PermissionManager,
): boolean {
  const authorization = result === undefined ? undefined : issuedShellAllowRuleDecisions.get(result);
  return authorization !== undefined &&
    (issuer === undefined || authorization.issuer === issuer) &&
    isShellAllowRuleAuthorizationCurrent(authorization);
}

// Verify and burn the allow-rule proof for one shell action. Delete before comparison so a mismatched or replayed attempt cannot probe or reuse it.
export function consumeIssuedShellAllowRuleDecision(
  result: PermissionCheckResult | undefined,
  expected: ShellAllowRuleSubject,
  issuer: PermissionManager | undefined,
): ShellAllowRuleAuthorization | undefined {
  if (result === undefined) return undefined;
  const actual = issuedShellAllowRuleDecisions.get(result);
  if (actual === undefined) return undefined;
  issuedShellAllowRuleDecisions.delete(result);
  return actual.issuer === issuer &&
    isShellAllowRuleAuthorizationCurrent(actual) &&
    actual.toolName === expected.toolName &&
    actual.dialect === expected.dialect &&
    actual.command === expected.command &&
    actual.cwd === expected.cwd ? actual : undefined;
}

// Where a `Network(...)` rule is stored: the user rules, a project's rules, or a conversation's "This session" rules.
export type NetworkRuleScope = "user" | "project" | "session";
export interface NetworkPermissionEvaluation {
  permission: PermissionCheckResult;
  identity: string;
  reasonKey: string;
  destination: Readonly<{ host: string; port: number }>;
  rule?: { decision: "deny" | "ask" | "allow"; pattern: string; scope: NetworkRuleScope };
}

export class PermissionManager {
  private rules: PermissionRule[] = [];
  // Unread deny rules fail admission closed for every tool category.
  private rulesLoadError: PermissionRulesFileCorruptError | undefined;
  private readonly projectRuleScopes: ProjectRuleScopes;
  private mode: ExecutionMode = "strict";
  // "Allow always" grants keyed by pattern → highest granted {@link GrantTier}. Was a flat `Set<string>` (category-blind). The Map structurally enforces the "1 grant, highest tier" invariant so a re-grant can only widen coverage (monotone), never desynchronize.
  private readonly alwaysAllowed = new Map<string, GrantTier>();
  // "This session" allow rules (`addSessionRule`), by root conversation. Held in memory only: they end with the conversation (`endSession`) or the app.
  private readonly sessionRules = new Map<string, PermissionRule[]>();

  private toolModeOverrides = new Map<string, ExecutionMode>();

  private readonly permissionsFilePath: string;
  private userRulesVersion: PersistedPolicyVersion | undefined;
  // Reviewer evidence services, wired at boot.
  private reviewerClassifier: TracingRiskClassifier | null = null;
  private surfaceReviewer: RiskClassifier["reviewUserOwnedSurface"];
  private readonly userOwnedSurfaceChoices = new UserOwnedSurfaceStore();
  private reviewerJudgmentEnabled = false;
  private reviewerModel: string | undefined;
  private reviewerUnavailableReason: string | undefined;
  private judgeDeps: JudgeEngineDeps | undefined;
  private readonly judgeBreaker = new JudgeCircuitBreaker(DEFAULT_JUDGE_SETTINGS.breaker);
  private resolveJudgeRootSession: (sessionId: string) => string = (sessionId) => sessionId;
  private verdictCache: VerdictCache | null = null;
  private recentlyDenied: RecentlyDeniedStore | null = null;
  private readonly pipelineRequests = new WeakMap<PermissionCheckResult, { request: PermissionDecisionRequest; policyEpoch: string; hostTerminalContext?: HostTerminalPermissionContext }>();
  private reviewerCacheScope: Record<string, unknown> = {};
  // Runtime degrade flag — true when the persisted reviewer mode is "llm" but boot wiring could not instantiate the LLM provider adapter (fresh install: no chat provider/key configured) and fell back to the rule classifier. Surfaced to the renderer (PermissionsTab banner) so the user understands the reviewer is running rule-only until they configure a provider. Reset to false on every successful "llm" wiring.
  private reviewerDegradedToRule = false;
  // Retained persisted reviewer preference for settings round trips; mode owns routing.
  private blockReadsOutsideWorkingDirectories = false;
  private policyGeneration = 0;
  private permissionStoreError: string | undefined;
  // Optional broadcast for memory-hit auto-approve disclosure.
  private broadcastUserApprovalHit: ((payload: UserApprovalHitPayload) => void) | null = null;
  // Architectural choke point for permission config fan-out — every persisted mutation through PermissionManager (addAlwaysAllowedPersist, addAlwaysDeniedPersist, removeRule) fires this callback so multi-window PermissionsTab refreshes without each call site re-implementing the broadcast wiring. Wired by boot from `ipc/domains/permissions.ts:broadcastPermissionConfigChanged`.
  private broadcastConfigChanged: (() => void) | null = null;
  // Every persisted rule change aborts all plugin bearer signals so captured keys release immediately; lazily recreate controllers for later resolves. Coarse revocation prevents stale closure-held credentials.
  private readonly pluginAbortControllers = new Map<string, AbortController>();
  private readonly pluginRevokeEpochs = new Map<string, number>();

  getPluginRevokeEpoch(pluginId: string): number {
    return this.pluginRevokeEpochs.get(pluginId) ?? 0;
  }

  constructor(permissionsFilePath?: string, private readonly readPermissionStoreError?: () => string | undefined) {
    this.permissionsFilePath =
      permissionsFilePath ?? defaultPermissionsFilePath();
    this.projectRuleScopes = new ProjectRuleScopes(dirname(this.permissionsFilePath));
    const initialVersion = capturePersistedPolicyVersion(this.permissionsFilePath);
    this.userRulesVersion = initialVersion?.digest === null ? initialVersion : undefined;
  }

  // Permission policy wire the Layer 5 reviewer agent. Call once at boot after loading settings. The executor checks hasReviewer before headless reviewer dispatch and fail-closes when the reviewer is absent.
  setReviewer(deps: {
    classifier: RiskClassifier;
    model?: string;
    cache: VerdictCache;
    recentlyDenied?: RecentlyDeniedStore;
    cacheScope?: Record<string, unknown>;
    // True when persisted mode is "llm" but wiring degraded to the rule classifier (provider/key not configured). Defaults to false so all non-degraded callers (rule/disabled/strict, successful llm) clear it.
    degradedToRule?: boolean;
    // The user selected a reviewer model that cannot run (not offered, or its provider is not connected). Every review then fails as `unavailable` with this reason: the foreground asks with a modal, headless denies. No other model, and no rule-only classifier, stands in for the choice.
    unavailableReason?: string;
  }): void {
    this.reviewerClassifier = traceRiskClassifier(deps.classifier);
    this.surfaceReviewer = this.reviewerClassifier.reviewUserOwnedSurface;
    this.reviewerJudgmentEnabled = !(deps.classifier instanceof DisabledRiskClassifier);
    this.reviewerModel = deps.model;
    this.reviewerUnavailableReason = deps.unavailableReason;
    this.verdictCache = deps.cache;
    this.recentlyDenied = deps.recentlyDenied ?? null;
    this.reviewerCacheScope = deps.cacheScope ?? {};
    this.reviewerDegradedToRule = deps.degradedToRule ?? false;
    this.policyGeneration += 1;
  }

  setJudge(deps: JudgeEngineDeps, resolveRootSessionId?: (sessionId: string) => string): void {
    this.judgeDeps = deps;
    this.resolveJudgeRootSession = resolveRootSessionId ?? ((sessionId) => sessionId);
    this.policyGeneration += 1;
  }

  getJudgeBreaker(limits?: JudgeBreakerSettings): JudgeCircuitBreaker {
    if (limits) this.judgeBreaker.setLimits(limits);
    return this.judgeBreaker;
  }

  beginPermissionTurn(sessionId: string): void {
    this.judgeBreaker.beginTurn(this.resolveJudgeRootSession(sessionId));
  }

  isAutomatedApprovalPaused(sessionId?: string): boolean {
    return this.getAutomatedApprovalPauseReason(sessionId) !== undefined;
  }

  getAutomatedApprovalPauseReason(sessionId?: string): "consecutive" | "total" | undefined {
    return sessionId === undefined ? undefined : this.judgeBreaker.pauseReason(this.resolveJudgeRootSession(sessionId));
  }

  hasJudge(category?: ToolCategory): boolean {
    const settings = this.judgeDeps?.settings;
    return Boolean(settings && (settings.chain.length > 0 || this.judgeDeps?.chainRejected || this.judgeDeps?.settingsUnreadable) &&
      (category === undefined ||
        ((category === "shell" || category === "write" || category === "network") &&
          (this.judgeDeps?.settingsUnreadable || settings.categories[category]))));
  }

  // Whether the reviewer is currently running rule-only because the persisted "llm" mode could not be wired (provider/key absent). Read by the reviewer-show IPC to surface the degrade banner in PermissionsTab.
  isReviewerDegradedToRule(): boolean {
    return this.reviewerDegradedToRule;
  }

  hasReviewer(): boolean {
    return (
      this.hasJudge() || (this.reviewerClassifier !== null &&
      this.verdictCache !== null)
    );
  }

  // Always check sensitive paths and effect-aware directory scope, even without a manager instance; callers supply canonical/case-folded targets and current allowed roots, with no new filesystem lookup. Return first hits; callers own audit and approval mutations.
  // Reads use hard denies rather than directory fencing unless configured otherwise; report unfenced outside-scope reads separately for audit, never as write hits.
  static checkPathScope(args: {
    canonicalTargets: readonly { filePath: string; canonicalPath: string }[];
    allowedDirectories: readonly string[];
    // What the invocation will DO with these targets. A `read` is bounded by Layer 0 alone unless the user re-fences reads; a `write` is confined to `allowedDirectories` exactly as it always was.
    effect: PathEffect;
    // The user setting that re-fences reads.
    blockReadsOutsideWorkingDirectories: boolean;
  }): {
    sensitiveHit: { filePath: string; pattern: string } | null;
    outOfAllowed: { filePath: string; canonicalPath: string } | null;
    readOutsideScope: { filePath: string; canonicalPath: string } | null;
  } {
    let sensitiveHit: { filePath: string; pattern: string } | null = null;
    for (const target of args.canonicalTargets) {
      const pattern = isAdmissionDeniedPath(target.canonicalPath, args.effect);
      if (pattern) {
        sensitiveHit = { filePath: target.filePath, pattern };
        break;
      }
    }
    const scope = {
      directories: args.allowedDirectories,
      blockReadsOutsideWorkingDirectories: args.blockReadsOutsideWorkingDirectories,
    };
    let outOfAllowed: { filePath: string; canonicalPath: string } | null = null;
    let readOutsideScope: { filePath: string; canonicalPath: string } | null = null;
    for (const target of args.canonicalTargets) {
      if (!isPathAllowedForEffect(target.canonicalPath, scope, args.effect)) {
        outOfAllowed = { filePath: target.filePath, canonicalPath: target.canonicalPath };
        break;
      }
      // The same target asked as a write. When the two answers differ, the directory list did refuse this path and only the read/write asymmetry admitted it — which is the fact the audit row records.
      if (
        readOutsideScope === null &&
        args.effect === "read" &&
        !isPathAllowedForEffect(target.canonicalPath, scope, "write")
      ) {
        readOutsideScope = { filePath: target.filePath, canonicalPath: target.canonicalPath };
      }
    }
    return { sensitiveHit, outOfAllowed, readOutsideScope };
  }

  // Boot propagates the persisted reviewer preference without creating another routing policy.
  // Re-fence read-tier path operands to the allowed directories. Boot reads `permissions.blockReadsOutsideWorkingDirectories` from `~/.ave/config/settings.json` and pushes it here, alongside other permission settings, so the enforcement path never re-reads the file per tool call. It ships OFF: a read reaches any path Layer 0 permits.
  setBlockReadsOutsideWorkingDirectories(value: boolean): void {
    if (this.blockReadsOutsideWorkingDirectories !== value) this.policyGeneration += 1;
    this.blockReadsOutsideWorkingDirectories = value;
  }

  getBlockReadsOutsideWorkingDirectories(): boolean {
    return this.blockReadsOutsideWorkingDirectories;
  }

  // Wire the permission-config fan-out. Called once at boot; see broadcastConfigChanged for what fires it.
  setBroadcastConfigChanged(fn: () => void): void {
    this.broadcastConfigChanged = fn;
  }

  // Wire the renderer broadcast for memory-hit auto-approve disclosure. Called once at boot. When set, every user-approval memory hit emits `ave:permissions:user-approval-hit` to the renderer and a console.info log.
  setBroadcastUserApprovalHit(fn: (payload: UserApprovalHitPayload) => void): void {
    this.broadcastUserApprovalHit = fn;
  }

  // SINGLE PRODUCER of the memory-hit auto-approve disclosure. A stored user approval can skip the ask from TWO lanes: the reviewer lane (dispatchReviewer) and the foreground approval lane (`tools/pipeline/approval-memory-skip.ts`). Both read the SAME Store B entry under the same key, so both owe the user the same disclosure — one lane announcing it while the other silently auto-approves is the bug this method closes. Both lanes call HERE rather than each holding their own broadcast, so the console line and the renderer toast cannot drift apart.
  discloseUserApprovalHit(payload: UserApprovalHitPayload): void {
    console.info(
      `[permission] memory-hit auto-approve: ${payload.toolName} (scope=${payload.scope}, verdict=${payload.verdictAtApproval})`,
    );
    try {
      this.broadcastUserApprovalHit?.(payload);
    } catch {
      // broadcast failure must not block tool execution
    }
  }

  // Return the AbortSignal that will fire when this plugin's outstanding bearer leases must be aborted (i.e. on any permission rule change). Lazily creates the controller on first call. Callers combine this signal with the caller-provided per-request signal via `AbortSignal.any` so the bearer's `release` runs on whichever triggers first. The controller is recreated after every abort, so the returned signal is stable only across the current "lease epoch" — the next call after an abort gets a fresh signal.
  getPluginRevokeSignal(pluginId: string): AbortSignal {
    let controller = this.pluginAbortControllers.get(pluginId);
    if (!controller) {
      controller = new AbortController();
      this.pluginAbortControllers.set(pluginId, controller);
    }
    return controller.signal;
  }

  // Abort the named plugin's outstanding bearer leases and recreate a fresh controller so the next `getPluginRevokeSignal` call returns an un-aborted signal. The abort reason is wrapped in `Error('permission-revoked: <reason>')` so downstream listeners that surface `signal.reason` see a structured, human-readable cause.
  revokePluginAccess(pluginId: string, reason: string): void {
    this.pluginRevokeEpochs.set(pluginId, this.getPluginRevokeEpoch(pluginId) + 1);
    const controller = this.pluginAbortControllers.get(pluginId);
    if (!controller) return;
    try {
      controller.abort(new Error(`permission-revoked: ${reason}`));
    } catch {
      // AbortController.abort never throws in practice; the catch is defense-in-depth so a bad polyfill can't break the mutation path.
    }
    // Recreate so the NEXT resolve gets an un-aborted controller. Without this, every subsequent resolve would receive the already-aborted signal and fire release before the bearer is ever read.
    this.pluginAbortControllers.set(pluginId, new AbortController());
  }

  // Abort every known plugin's outstanding bearer leases. Called from the persisted-mutation entry points (addAlwaysAllowedPersist, addAlwaysDeniedPersist, removeRule) so any rule change invalidates outstanding bearers across all plugins (coarse but safe — the alternative is per-rule plugin-id resolution which is fragile when rules use glob patterns that can match any future plugin's tool names).
  revokeAllPluginAccess(reason: string): void {
    for (const pluginId of [...this.pluginAbortControllers.keys()]) {
      this.revokePluginAccess(pluginId, reason);
    }
  }

  getRecentlyDenied(): RecentlyDeniedStore | null {
    return this.recentlyDenied;
  }

  // Permission policy accessor for the verdict cache. Used by the slash handler when the user changes settings and we need to drop stale entries.
  getVerdictCache(): VerdictCache | null {
    return this.verdictCache;
  }

  // Settings

  setMode(mode: ExecutionMode): void {
    if (this.mode !== mode) this.policyGeneration += 1;
    this.mode = mode;
  }

  getMode(): ExecutionMode {
    return this.mode;
  }

  // Monotonic host policy identity for sealed rationale revalidation.
  getPolicyEpoch(): string {
    this.refreshPermissionStoreError();
    return `${this.policyGeneration}:${this.projectRuleScopes.getRevision()}:${this.mode}`;
  }

  private refreshPermissionStoreError(): string | undefined {
    let error: string | undefined;
    try {
      error = this.readPermissionStoreError?.();
    } catch {
      error = "Permission settings could not be read.";
    }
    if (error !== this.permissionStoreError) {
      this.permissionStoreError = error;
      this.policyGeneration += 1;
    }
    return error;
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = rules.map((rule) => ({ ...rule }));
    this.policyGeneration += 1;
  }

  setToolModeOverride(toolName: string, mode: ExecutionMode): void {
    if (mode === "default") {
      if (this.toolModeOverrides.delete(toolName)) this.policyGeneration += 1;
      return;
    }
    if (this.toolModeOverrides.get(toolName) !== mode) this.policyGeneration += 1;
    this.toolModeOverrides.set(toolName, mode);
  }

  clearToolModeOverride(toolName: string): void {
    if (this.toolModeOverrides.delete(toolName)) this.policyGeneration += 1;
  }

  // Prebuild an exact tool-mode snapshot; publication is assignment-only.
  prepareToolModeOverrides(
    predecessorToolNames: Iterable<string>,
    replacements: readonly { toolName: string; mode: ExecutionMode }[],
  ): { publish(): void } {
    const predecessors = Object.freeze([...predecessorToolNames]);
    const prepared = Object.freeze(replacements.map((entry) => Object.freeze({ ...entry })));
    let published = false;
    return Object.freeze({
      publish: () => {
        if (published) return;
        for (const toolName of predecessors) this.toolModeOverrides.delete(toolName);
        for (const { toolName, mode } of prepared) {
          if (mode === "default") this.toolModeOverrides.delete(toolName);
          else this.toolModeOverrides.set(toolName, mode);
        }
        this.policyGeneration += 1;
        published = true;
      },
    });
  }

  getVisibilityDenyRules(): DenyRule[] {
    return this.rules
      // A specifier deny (`Bash(rm *)`) restricts some calls of a tool; it must never hide the whole tool from the model.
      .filter((rule) => rule.action === "deny" && !rule.source && !isRuleSpecifier(rule.pattern))
      .map((rule) => ({ pattern: rule.pattern }));
  }

  // Persistent Rule Management

  // Add a tool-name pattern as a persistent allow rule. Update the in-memory allow cache only after permissions.json is persisted. `tier` records how broadly the grant applies. It defaults to `"write"` so the non-executor callers (slash `/allow`, the PermissionsTab addRule IPC) keep their category-blind grant (grandfather). The executor passes requiredTier(invocationCategory) so a grant made on a read tool is read-tier. Re-granting is monotone: the tier is only ever upgraded (read→ write), never downgraded — a downgrade must go through removeRule.
  async addAlwaysAllowedPersist(pattern: string, tier: GrantTier = "write"): Promise<void> {
    if (isRuleSpecifier(pattern)) {
      await this.addRulePersist({ pattern, action: "allow" }, { kind: "user" });
      return;
    }
    // Persisted rule list: add or upgrade allow rules while preserving monotone tiers.
    await this.updateRulesFile((file) => {
      const existing = file.rules.find(
        (r) => r.action === "allow" && r.pattern === pattern && !r.source,
      );
      if (existing) {
        // Upgrade only — never downgrade a saved grant. A legacy/absent tier grandfathers to write, so a "read" re-grant onto it is a no-op.
        if (tierRank(tier) > tierRank(normalizeTier(existing.tier))) {
          existing.tier = tier;
        }
      } else {
        file.rules.push({ pattern, action: "allow", tier });
      }
    });
    // In-memory cache is updated only after the durable write succeeds. maxTier keeps the invariant that the Map holds the highest granted tier.
    this.alwaysAllowed.set(pattern, maxTier(this.alwaysAllowed.get(pattern), tier));
    this.policyGeneration += 1;
    this.broadcastConfigChanged?.();
    // A rule change aborts outstanding bearers so plugins re-resolve their keys under the new policy. An allow rule going wider is benign but still needs the next bearer to reflect the new state.
    this.revokeAllPluginAccess(`allow-rule-added:${pattern}`);
  }

   // Add a tool-name pattern as a persistent deny rule. Update the in-memory rules array and permissions.json together.
  async addAlwaysDeniedPersist(pattern: string): Promise<void> {
    if (isRuleSpecifier(pattern)) {
      await this.addRulePersist({ pattern, action: "deny" }, { kind: "user" });
      return;
    }
    // In-memory: insert at the front of the rules array so deny has priority.
    const exists = this.rules.some(
      (r) => r.action === "deny" && r.pattern === pattern && !r.source,
    );
    if (!exists) {
      this.rules.unshift({ pattern, action: "deny" });
      this.policyGeneration += 1;
    }
    // Persistent file.
    await this.updateRulesFile((file) => {
      const fileExists = file.rules.some(
        (r) => r.action === "deny" && r.pattern === pattern && !r.source,
      );
      if (!fileExists) {
        file.rules.unshift({ pattern, action: "deny" });
      }
    });
    this.policyGeneration += 1;
    this.broadcastConfigChanged?.();
    // Deny added → outstanding bearers MUST be aborted so a plugin that held a bearer captured in a closure can't continue calling the upstream provider after the user revoked access.
    this.revokeAllPluginAccess(`deny-rule-added:${pattern}`);
  }

  // Remove a persistent rule by pattern and action.
  // add a rules-language rule (`Bash(git status *)`, deny/ask/allow) to the user-global scope (permissions.json) or a project's rule file in Ave home. Validation (canonical spelling, enforced kind, refused allow prefixes) runs before anything is written; the live state changes only after the durable write succeeds.
  async addRulePersist(
    rule: { pattern: string; action: PermissionRule["action"] },
    scope: { kind: "user" } | { kind: "project"; projectCwd: string },
  ): Promise<void> {
    const validated = validatePermissionRule(withCurrentShellRuleVersion({ pattern: rule.pattern, action: rule.action }));
    if (!isRuleSpecifier(validated.pattern)) {
      throw new Error(`addRulePersist takes rules-language specifiers; got legacy pattern ${validated.pattern}`);
    }
    if (scope.kind === "project") {
      await this.projectRuleScopes.addRule(scope.projectCwd, validated);
    } else {
      await this.updateRulesFile((file) => {
        if (!file.rules.some((r) => r.pattern === validated.pattern && r.action === validated.action && !r.source && isCurrentShellRule(r))) {
          file.rules = file.rules.filter((r) => !(r.pattern === validated.pattern && r.action === validated.action && !r.source));
          if (validated.action === "allow") file.rules.push(validated);
          else file.rules.unshift(validated);
        }
      });
      if (!this.rules.some((r) => r.pattern === validated.pattern && r.action === validated.action && !r.source && isCurrentShellRule(r))) {
        this.rules = this.rules.filter((r) => !(r.pattern === validated.pattern && r.action === validated.action && !r.source));
        if (validated.action === "allow") this.rules.push(validated);
        else this.rules.unshift(validated);
      }
    }
    this.policyGeneration += 1;
    this.broadcastConfigChanged?.();
    this.revokeAllPluginAccess(`rule-added:${validated.action}:${validated.pattern}`);
  }

  // Add a validated shell or network allow rule for one conversation; prefixes apply on host and sandbox routes.
  addSessionRule(sessionId: string, pattern: string): void {
    if (sessionId.length === 0) throw new Error("A session rule requires its conversation session");
    const validated = validatePermissionRule(withCurrentShellRuleVersion({ pattern, action: "allow" }));
    const spec = isRuleSpecifier(validated.pattern) ? parseRuleSpecifier(validated.pattern) : undefined;
    if (spec?.kind !== "bash" && spec?.kind !== "powershell" && spec?.kind !== "network") {
      throw new Error(`A session rule must be a Bash(...), PowerShell(...) or Network(...) rule; got ${validated.pattern}`);
    }
    // Keyed like a session approval: the root conversation and the sub-agents it spawned share it.
    const root = approvalConversationRoot(sessionId);
    const rules = this.sessionRules.get(root) ?? [];
    if (!rules.some((rule) => rule.pattern === validated.pattern && isCurrentShellRule(rule))) {
      const previous = rules.findIndex((rule) => rule.pattern === validated.pattern);
      if (previous >= 0) rules.splice(previous, 1);
      rules.push(validated);
    }
    this.sessionRules.set(root, rules);
    this.policyGeneration += 1;
    this.broadcastConfigChanged?.();
  }

  // The "This session" rules a conversation holds.
  getUserOwnedSurfaceChoice(sessionId: string, surface: UserOwnedSurface): UserOwnedSurfaceChoice {
    return this.userOwnedSurfaceChoices.get(sessionId, surface);
  }

  setUserOwnedSurfaceChoice(sessionId: string, surface: UserOwnedSurface, choice: UserOwnedSurfaceChoice): void {
    this.userOwnedSurfaceChoices.set(sessionId, surface, choice);
  }

  clearUserOwnedSurfaceChoices(sessionId: string): boolean {
    return this.userOwnedSurfaceChoices.clear(sessionId);
  }

  listSessionRules(sessionId: string): readonly string[] {
    return (this.sessionRules.get(approvalConversationRoot(sessionId)) ?? []).map((rule) => rule.pattern);
  }

  // Forget the session shell rules of a root conversation that ended. Rules are held under the root (its sub-agents share them), so only a root id is accepted: a sub-agent's end must not drop its parent's rules. Returns whether it held any.
  endSession(rootSessionId: string): boolean {
    if (approvalConversationRoot(rootSessionId) !== rootSessionId) {
      throw new Error("Session shell rules end only with their root conversation");
    }
    this.judgeBreaker.forget(this.resolveJudgeRootSession(rootSessionId));
    const dropped = this.sessionRules.delete(rootSessionId);
    const clearedSurfaces = this.userOwnedSurfaceChoices.clearMatching(sessionId => approvalConversationRoot(sessionId) === rootSessionId);
    if (dropped) {
      this.policyGeneration += 1;
      this.broadcastConfigChanged?.();
    }
    return dropped || clearedSurfaces;
  }

  // remove a rules-language rule from the user-global or a project scope.
  async removeRulePersist(
    rule: { pattern: string; action: PermissionRule["action"]; source?: string },
    scope: { kind: "user" } | { kind: "project"; projectCwd: string; storedFile?: string },
  ): Promise<void> {
    if (scope.kind === "project") {
      await this.projectRuleScopes.removeRule(scope.projectCwd, rule.pattern, rule.action, scope.storedFile);
      this.policyGeneration += 1;
      this.broadcastConfigChanged?.();
      this.revokeAllPluginAccess(`rule-removed:${rule.action}:${rule.pattern}`);
      return;
    }
    await this.removeRule(rule.pattern, rule.action, rule.source);
  }

  // load a project's rule file before a synchronous decision names it in `context.projectRulesCwd`. Idempotent; a corrupt file is recorded and every decision for that project fails closed to an ask.
  async ensureProjectRulesLoaded(projectCwd: string): Promise<void> {
    await this.projectRuleScopes.ensureLoaded(projectCwd);
  }

  // The `Network(<host>[:port])` rule that decides a sandboxed shell's or terminal's connection, from the user rules, the project's rules (a shell call with a project) and the conversation's "This session" rules, with the precedence of every rule kind: deny, then ask (no grant is consulted and the card asks), then allow. Undefined when no rule matches; the grant store and the card then decide. The network card's "Always deny" and its edited rules are stored as these rules (owner 2026-10-25). A corrupt project rules file throws, which the egress callback turns into an audited deny.
  // `scope` names where the deciding rule is stored, so the egress callback can hold an allow to the lifetimes the connection's identity may use.
  async networkRuleDecision(subject: { host: string; port: number; sessionId?: string; projectCwd?: string }): Promise<{ decision: "deny" | "ask" | "allow"; pattern: string; scope: NetworkRuleScope } | undefined> {
    let projectRules: readonly PermissionRule[] = [];
    if (subject.projectCwd !== undefined) {
      const state = await this.projectRuleScopes.ensureLoaded(subject.projectCwd);
      if (!state.ok) throw state.error;
      projectRules = state.rules;
    }
    const sessionRules = subject.sessionId === undefined ? [] : this.sessionRules.get(approvalConversationRoot(subject.sessionId)) ?? [];
    const matched: { deny?: { pattern: string; scope: NetworkRuleScope }; ask?: { pattern: string; scope: NetworkRuleScope }; allow?: { pattern: string; scope: NetworkRuleScope } } = {};
    const scoped: Array<[NetworkRuleScope, readonly PermissionRule[]]> = [["user", this.rules], ["project", projectRules], ["session", sessionRules]];
    for (const [scope, rules] of scoped) {
      for (const rule of rules) {
        if (rule.source || storedRuleInvalidReason(rule) !== null || !isRuleSpecifier(rule.pattern)) continue;
        const spec = parseRuleSpecifier(rule.pattern);
        if (spec.kind !== "network" || !matchesWebFetchHost(spec, subject.host, subject.port)) continue;
        matched[rule.action] ??= { pattern: rule.pattern, scope };
      }
    }
    for (const decision of ["deny", "ask", "allow"] as const) {
      const found = matched[decision];
      if (found !== undefined) return { decision, ...found };
    }
    return undefined;
  }

  // Every actual connection has its own request; an enclosing shell's rule or grant is not network consent.
  async checkNetworkPermission(
    destination: { host: string; port: number; source: ToolSource; network: "public" | "local" | "unverified"; ruleScopes?: readonly NetworkRuleScope[] },
    context: PermissionCheckContext = {},
  ): Promise<NetworkPermissionEvaluation> {
    const canonicalHost = canonicalEgressHost(destination.host);
    const valid = canonicalHost !== undefined && isValidEgressPort(destination.port);
    const host = canonicalHost ?? destination.host;
    const exactDestination = Object.freeze({ host, port: destination.port });
    const identity = canonicalStringify({ kind: "network", ...exactDestination, source: destination.source });
    let admissionDenial = context.admissionDenial;
    let rule: NetworkPermissionEvaluation["rule"];
    if (!valid) admissionDenial ??= { code: "invalid-network-destination", reason: "Network destination is invalid" };
    else {
      try {
        const matched = await this.networkRuleDecision({ host, port: destination.port, sessionId: context.sessionId, projectCwd: context.projectRulesCwd });
        if (matched?.decision !== "allow" || destination.network === "public" && destination.ruleScopes?.includes(matched.scope)) rule = matched;
      } catch (error) {
        if (!(error instanceof PermissionRulesFileCorruptError)) throw error;
        admissionDenial ??= { code: "policy-unreadable", reason: error.message };
      }
    }
    const base = this.evaluatePermission("sandbox_network", destination.source, "network", undefined, {
      headless: context.headless, ownerUnattended: context.ownerUnattended, approvalSurface: context.approvalSurface,
      sessionId: context.sessionId, projectRulesCwd: context.projectRulesCwd, permissionStoreError: context.permissionStoreError,
      remoteControllerAuthority: context.remoteControllerAuthority, floor: context.floor, paths: context.paths,
      manualRerun: context.manualRerun, admissionDenial, approvalCacheKey: identity,
      hostTerminalTurn: context.hostTerminalTurn, trustOrigin: context.trustOrigin,
    });
    const issued = this.pipelineRequests.get(base);
    if (!issued) throw new Error("Network permission request was not issued");
    const permission = rule === undefined ? base : this.pipelineResult({
      ...issued.request, rules: { ...issued.request.rules, [rule.decision]: rule.pattern },
    }, issued.hostTerminalContext);
    if (permission.reasonCode === undefined) throw new Error("Network permission decision has no reason code");
    return { permission, identity, destination: exactDestination, reasonKey: permission.reasonCode, ...(rule ? { rule } : {}) };
  }

  // Re-check actual destinations at the host fetch boundary, including redirects.
  async checkNetworkRules(url: string, projectCwd: string, privateNetwork = false): Promise<ScopedRuleEvaluation> {
    await this.projectRuleScopes.ensureLoaded(projectCwd);
    return this.checkScopedRules({ kind: "webfetch", url, privateNetwork }, projectCwd);
  }

  // Read an already loaded scope; a generic tool allow is never a scoped grant.
  checkScopedRules(subject: ScopedRuleSubject, projectCwd: string): ScopedRuleEvaluation {
    const state = this.projectRuleScopes.stateFor(projectCwd);
    if (this.rulesLoadError || !state.ok) return { admissionDenial: "Permission rule store is unavailable" };
    return evaluateScopedRules(subject, state.projectRoot, this.rules, state.rules);
  }

  // the project scope's persisted rules (Settings list), or its load error.
  async listProjectRules(projectCwd: string): Promise<
    { ok: true; projectRoot: string; rules: readonly PermissionRule[] } | { ok: false; projectRoot: string; error: string }
  > {
    const state = await this.projectRuleScopes.reload(projectCwd);
    return state.ok ? state : { ok: false, projectRoot: state.projectRoot, error: state.error.message };
  }

  // All stored rule scopes, including projects not visited in this process.
  async listScopedRules(): Promise<{ rules: ScopedPermissionRule[]; errors: ScopedPermissionRuleError[] }> {
    const rules: ScopedPermissionRule[] = [];
    const errors: ScopedPermissionRuleError[] = [];
    try {
      for (const rule of await this.listPersistedRules()) rules.push(withInvalidReason({ ...rule, scope: "user" }));
    } catch (error) {
      console.error("[permission]", error);
      errors.push({ filePath: this.permissionsFilePath, errorCode: "rules-file-unavailable" });
    }
    try {
      const projects = await listStoredProjectRules(dirname(this.permissionsFilePath));
      errors.push(...projects.errors);
      for (const file of projects.files) {
        for (const rule of file.rules) {
          rules.push(withInvalidReason({ ...rule, scope: "project", projectCwd: file.projectRoot, storedFile: file.identity }));
        }
      }
    } catch (error) {
      console.error("[permission]", error);
      errors.push({ filePath: resolve(dirname(this.permissionsFilePath), "permissions", "project-rules"), errorCode: "rules-file-unavailable" });
    }
    return { rules, errors };
  }

  // the user-global Store A load error, if permissions.json is corrupt.
  getRulesLoadError(): string | undefined {
    return this.rulesLoadError?.message;
  }

  async removeRule(pattern: string, action: PermissionRule["action"], source?: string): Promise<void> {
    // Persist first; corruption or an I/O error must leave live authority intact.
    await this.updateRulesFile((file) => {
      file.rules = file.rules.filter(
        (r) => !(r.pattern === pattern && r.action === action && r.source === source),
      );
    });
    this.rules = this.rules.filter(
      (r) => !(r.pattern === pattern && r.action === action && r.source === source),
    );
    if (action === "allow" && source === undefined) this.alwaysAllowed.delete(pattern);
    this.policyGeneration += 1;

    this.broadcastConfigChanged?.();
    // Rule removal is also a permission change. An allow removal narrows the policy (revoke); a deny removal widens it. In both cases outstanding bearers should re-resolve under the new policy rather than keep operating under the now-stale snapshot.
    this.revokeAllPluginAccess(`rule-removed:${action}:${pattern}`);
  }

  // Removing a root must also prune its inclusive single-path allow grants so re-add cannot revive revoked authority; preserve separately registered descendants, non-path allows and denies. Compare canonical and raw stored forms to cover symlinks/case without changing hot-path identity. Return redacted per-pattern audit provenance; only the count crosses IPC.
  async prunePathGrantsUnderRoot(
    root: string,
    options?: { preserveRoots?: readonly string[] },
  ): Promise<PrunedGrant[]> {
    // Dual-form roots (item-5): canonical (realpath'd) and raw (pathResolve only).
    const rootCanon = caseFoldForMatch(canonicalizePathForMatch(root));
    const rootRaw = caseFoldForMatch(resolve(root).replace(/\\/g, "/"));
    const preservedRoots = (options?.preserveRoots ?? []).flatMap((preserveRoot) => {
      try {
        const canonical = caseFoldForMatch(canonicalizePathForMatch(preserveRoot));
        const raw = caseFoldForMatch(resolve(preserveRoot).replace(/\\/g, "/"));
        // Only a genuine descendant may carve a hole in the removed root. Ignoring the root itself and unrelated paths prevents a malformed caller option from accidentally preserving the whole revoked scope.
        if (
          !isStrictPathDescendant(rootCanon, canonical)
          && !isStrictPathDescendant(rootRaw, raw)
        ) {
          return [];
        }
        return [{ canonical, raw }];
      } catch {
        return [];
      }
    });
    // A multi-path grant (`apply_patch`) is pruned when ANY of its paths is under the removed root: it would otherwise keep authorizing that path.
    const isUnderRoot = (pattern: string): boolean =>
      extractGrantPaths(pattern).some((target) => isPathUnderRoot(target));
    const isPathUnderRoot = (target: string): boolean => {
      // A grant matches if EITHER form equals the root or places it under the root. The two forms are compared like-for-like (canonical↔canonical, raw↔raw) so a realpath'd stored grant and a raw stored grant are both caught. isStrictPathDescendant folds case defensively (item-7), so passing the already-folded strings is safe + idempotent.
      const targetCanon = caseFoldForMatch(canonicalizePathForMatch(target));
      const targetRaw = caseFoldForMatch(resolve(target).replace(/\\/g, "/"));
      const covered = targetCanon === rootCanon
        || targetRaw === rootRaw
        || isStrictPathDescendant(rootCanon, targetCanon)
        || isStrictPathDescendant(rootRaw, targetRaw);
      if (!covered) return false;
      const preserved = preservedRoots.some(
        (preserveRoot) => targetCanon === preserveRoot.canonical
          || isStrictPathDescendant(preserveRoot.canonical, targetCanon)
          || targetRaw === preserveRoot.raw
          || isStrictPathDescendant(preserveRoot.raw, targetRaw),
      );
      return !preserved;
    };

    // The persisted file is the SOT for path grants: addAlwaysAllowedPersist writes the allow rule to the file + the in-memory alwaysAllowed Map, but NOT to `this.rules` (that array is only hydrated from the file at boot via loadRulesFromFile). Scan the file, not `this.rules`, so a grant made this session is still pruned. Do the read + filter inside ONE updatePermissionsFile pass (atomic under the store lock) and collect the pruned grants so in-memory state (rules + alwaysAllowed) is reconciled and the caller can audit per-pattern tuples.
    const pruned: PrunedGrant[] = [];
    await this.updateRulesFile((file) => {
      file.rules = file.rules.filter((r) => {
        if (r.action === "allow" && !r.source && isUnderRoot(r.pattern)) {
          pruned.push(describePrunedGrant(r.pattern, r.tier));
          return false;
        }
        return true;
      });
    });
    // Reconcile by scope on every retry, not only by patterns removed in this disk pass. A prior attempt may have committed the file shrink and then thrown while broadcasting/revoking bearers; the retry must still remove stale live cache entries and re-run the revoke signal.
    this.rules = this.rules.filter(
      (r) => !(r.action === "allow" && !r.source && isUnderRoot(r.pattern)),
    );
    for (const pattern of [...this.alwaysAllowed.keys()]) {
      if (isUnderRoot(pattern)) this.alwaysAllowed.delete(pattern);
    }

    this.policyGeneration += 1;
    this.broadcastConfigChanged?.();
    // A revoke narrows policy — outstanding bearers must re-resolve under it.
    this.revokeAllPluginAccess(`root-removed-prune:${root}`);
    return pruned;
  }

  // Called during app boot. Merges permissions.json into memory. Missing file is a normal no-op.
  async loadRulesFromFile(): Promise<void> {
    const policyVersion = capturePersistedPolicyVersion(this.permissionsFilePath);
    let file: Awaited<ReturnType<typeof readPermissionsFile>>;
    try {
      file = await readPermissionsFile(this.permissionsFilePath);
    } catch (error) {
      if (!(error instanceof PermissionRulesFileCorruptError)) throw error;
      // Boot continues so the user can fix the policy; admission denies until the unread rules can be loaded.
      console.error(`[permission] ${error.message}`);
      this.rulesLoadError = error;
      this.policyGeneration += 1;
      return;
    }
    this.policyGeneration += 1;
    this.userRulesVersion = policyVersion !== undefined &&
      policyVersion.contentsDigest === sha256Hex(canonicalStringify(file)) &&
      isPersistedPolicyVersionCurrent(policyVersion) ? policyVersion : undefined;
    this.rulesLoadError = undefined;
    if (!file) return;

    // Sync mode.
    if (file.mode) this.mode = file.mode;

    // Merge rules: add file rules after existing in-memory rules, deduplicated.
    for (const rule of file.rules) {
      const dup = this.rules.some(
        (r) => r.pattern === rule.pattern && r.action === rule.action && r.source === rule.source && r.shellRuleVersion === rule.shellRuleVersion,
      );
      if (!dup) {
        if (rule.action === "deny") {
          this.rules.unshift(rule); // deny has highest priority.
        } else {
          this.rules.push(rule);
          // Reflect allow rules in the alwaysAllowed Map as well, preserving tier. normalizeTier grandfathers a legacy/absent tier to write; maxTier keeps the highest tier if the pattern is hydrated more than once. Specifier rules match a subject, never a tool name or cache key.
          if (!rule.source && rule.action === "allow" && !isRuleSpecifier(rule.pattern)) {
            this.alwaysAllowed.set(
              rule.pattern,
              maxTier(this.alwaysAllowed.get(rule.pattern), normalizeTier(rule.tier)),
            );
          }
        }
      } else if (rule.action === "allow" && !rule.source && !isRuleSpecifier(rule.pattern)) {
        // On duplicate load, merge tiers from the existing Map and explicit file tier, never an untyped boot rule's implicit write default. Update both Map and surviving rule so explicit read grants cannot silently widen.
        const merged = maxTier(this.alwaysAllowed.get(rule.pattern), normalizeTier(rule.tier));
        this.alwaysAllowed.set(rule.pattern, merged);
        const surviving = this.rules.find(
          (r) => r.pattern === rule.pattern && r.action === "allow" && r.source === rule.source,
        );
        if (surviving) surviving.tier = merged;
      }
    }
  }

  // Return the rule list stored in permissions.json for the Settings UI. Missing file returns an empty array.
  async listPersistedRules(): Promise<PermissionRule[]> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    return file?.rules ?? [];
  }

  // Persist mode to permissions.json before updating in-memory state. The caller appends the audit entry first, so if saving fails the runtime mode must not change either.
  async setModePersist(mode: ExecutionMode): Promise<void> {
    await this.updateRulesFile((file) => {
      file.mode = mode;
    });
    if (this.mode !== mode) this.policyGeneration += 1;
    this.mode = mode;
  }

  // Retain the version actually written, never adopt another writer's unseen rules.
  private async updateRulesFile(mutator: Parameters<typeof updatePermissionsFile>[1]): Promise<void> {
    const previous = this.userRulesVersion;
    let written: PermissionsFile | undefined;
    let knownPolicy = false;
    await updatePermissionsFile(this.permissionsFilePath, async (file) => {
      knownPolicy = previous !== undefined && (
        previous.contentsDigest === sha256Hex(canonicalStringify(file)) ||
        (previous.contentsDigest === sha256Hex("null") && file.rules.length === 0)
      );
      await mutator(file);
      written = file;
    });
    this.userRulesVersion = knownPolicy && written !== undefined
      ? persistedPolicyVersionForContent(this.permissionsFilePath, `${JSON.stringify(written, null, 2)}\n`)
      : undefined;
  }

  // Decision

  // Staged non-user turn origins force foreground authority-bearing calls to ask despite memory, rules or auto mode. Use the shared staged-origin predicate so new origins cannot skip this gate; other calls follow the category matrix.
  checkDetailed(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    overlayTriggerOrigin?: string | null,
    context: PermissionCheckContext = {},
  ): PermissionCheckResult {
    return this.evaluatePermission(toolName, source, category, overlayTriggerOrigin, context);
  }

  private hostTerminalEvidence(context: HostTerminalPermissionContext, admissionDenial: PermissionDecisionRequest["admissionDenial"], floor: PermissionDecisionRequest["floor"]): Pick<PermissionDecisionRequest, "admissionDenial" | "floor"> {
    if (context.hostTerminalTurn) {
      const scope = context.hostTerminalTurn;
      if (context.remoteControllerAuthority) {
        admissionDenial ??= { code: "host-terminal-turn", reason: "Host terminal typing is unavailable to remote-controller requests" };
      } else if (context.headless === true || context.approvalSurface === "unavailable") {
        admissionDenial ??= { code: "host-terminal-turn", reason: NO_APPROVER_MESSAGE };
      } else {
        const hostTurn = currentHostTerminalTurn(scope.sessionId);
        const externalContent = hostTurn?.externalContentSeen() === true;
        const trusted = context.trustOrigin !== undefined && isUntaintedToolTrustOrigin(context.trustOrigin)
          || context.trustOrigin === "file-content" && externalContent;
        if (!trusted || !hostTurn || hostTurn.turnId !== scope.turnId || context.sessionId !== scope.sessionId || hostTurn.otherPrincipalGuidance()) {
          admissionDenial ??= { code: "host-terminal-turn", reason: "Host terminal typing is available only to the user's own turn in its pane chat" };
        }
        if (externalContent) floor ??= { code: "other-principal", reason: "Host terminal command after external content in this turn; saved rules do not apply" };
      }
    }
    return { admissionDenial, floor };
  }

  private pipelineResult(evidence: PermissionDecisionRequest, context?: HostTerminalPermissionContext): PermissionCheckResult {
    const hostTerminalContext = context?.hostTerminalTurn || context?.userOwnedBrowser ? Object.freeze({
      ...(context.hostTerminalTurn ? { hostTerminalTurn: Object.freeze({ ...context.hostTerminalTurn }) } : {}), userOwnedBrowser: context.userOwnedBrowser,
      trustOrigin: context.trustOrigin, sessionId: context.sessionId,
      remoteControllerAuthority: context.remoteControllerAuthority, headless: context.headless, approvalSurface: context.approvalSurface,
    }) : undefined;
    let { admissionDenial, floor } = hostTerminalContext ? this.hostTerminalEvidence(hostTerminalContext, evidence.admissionDenial, evidence.floor) : evidence;
    const browser = hostTerminalContext?.userOwnedBrowser;
    if (browser && (!isIssuedUserOwnedBrowserScope(browser) || browser.tabOpener !== "user" || typeof browser.tabId !== "string" || !Number.isInteger(browser.documentId) || !Number.isInteger(browser.controlGeneration))) {
      admissionDenial ??= { code: "invalid-browser-scope", reason: "The browser target is invalid or changed; nothing was done." };
    }
    const surface: UserOwnedSurface | undefined = hostTerminalContext?.hostTerminalTurn ? "host-terminal" : browser && isIssuedUserOwnedBrowserScope(browser) && browser.tabOpener === "user" ? "browser" : undefined;
    if (surface && !evidence.sessionId?.trim()) admissionDenial ??= { code: "user-owned-session", reason: NO_APPROVER_MESSAGE };
    const permissionStoreError = this.refreshPermissionStoreError();
    const { automationPause: _previousPause, ...currentEvidence } = evidence;
    const pause = this.getAutomatedApprovalPauseReason(evidence.sessionId);
    const request: PermissionDecisionRequest = Object.freeze({ ...currentEvidence,
      ...(surface ? { userOwnedSurface: Object.freeze({ kind: surface, choice: this.getUserOwnedSurfaceChoice(evidence.sessionId ?? "", surface) }) } : {}),
      ...(permissionStoreError ? { admissionDenial: Object.freeze({ code: "policy-unreadable", reason: permissionStoreError }) } : {}),
      ...(pause ? { automationPause: Object.freeze({ kind: pause, reason: "Automated approval is paused for this turn; human approval is required." }) } : {}),
      tool: Object.freeze({ ...evidence.tool }),
      ...(evidence.paths ? { paths: Object.freeze(evidence.paths.map((path) => Object.freeze({ ...path }))) } : {}),
      ...(evidence.rules ? { rules: Object.freeze({ ...evidence.rules }) } : {}),
      ...(floor ? { floor: Object.freeze({ ...floor }) } : {}),
      ...(admissionDenial ? { admissionDenial: Object.freeze({ ...admissionDenial }) } : {}),
      ...(evidence.shell ? { shell: Object.freeze({ ...evidence.shell }) } : {}),
      ...(evidence.fileWrite ? { fileWrite: Object.freeze({ ...evidence.fileWrite }) } : {}),
      ...(evidence.reviewer ? { reviewer: Object.freeze({ ...evidence.reviewer }) } : {}),
    });
    const decision = decidePermission(request);
    const result: PermissionCheckResult = {
      decision: decision.outcome === "sandbox-auto" ? "allow" : decision.outcome === "ask-forced" ? "ask" : decision.outcome,
      reason: decision.reason,
      reasonCode: decision.reasonCode,
      layer: decision.reasonCode === "rule-allow" ? 3 : decision.reasonCode === "remembered-approval" ? 5 : request.admissionDenial || request.rules?.deny ? 1 : request.floor ? 2 : 6,
      pipelineRequest: request,
      ...(decision.requiresCodeCheckpoint ? { requiresCodeCheckpoint: true as const } : {}),
      ...(decision.outcome === "ask-forced" || request.manualRerun && decision.outcome === "ask" ? { forceModal: true } : {}),
      ...(decision.reviewRequired ? { reviewer: { route: request.headless ? "headless" as const : "foreground-auto" as const } } : {}),
    };
    this.pipelineRequests.set(result, { request, policyEpoch: this.getPolicyEpoch(), ...(hostTerminalContext ? { hostTerminalContext } : {}) });
    return result;
  }

  recheckPermission(result: PermissionCheckResult): PermissionCheckResult {
    const issued = this.pipelineRequests.get(result);
    if (!issued) throw new JudgeContractError("Permission recheck requires an issued pipeline request");
    this.pipelineRequests.delete(result);
    const stale = issued.policyEpoch !== this.getPolicyEpoch();
    const refreshed = this.pipelineResult({ ...issued.request,
      ...(stale ? { admissionDenial: { code: "policy-changed", reason: "Permission policy changed before execution." } } : {}),
    }, issued.hostTerminalContext);
    const shellRule = issuedShellAllowRuleDecisions.get(result);
    issuedShellAllowRuleDecisions.delete(result);
    if (!stale) {
      if (result.reviewer) refreshed.reviewer = result.reviewer;
      if (result.denyReasons) refreshed.denyReasons = result.denyReasons;
      if (shellRule && refreshed.decision === "allow" && refreshed.reasonCode === "rule-allow") {
        issuedShellAllowRuleDecisions.set(refreshed, shellRule);
      }
    }
    return refreshed;
  }

  resolveReviewedPermission(result: PermissionCheckResult, review: ReviewerDispatchResult): PermissionCheckResult {
    const issued = this.pipelineRequests.get(result);
    if (!issued || !result.reviewer) throw new Error("Permission review requires an issued pipeline request");
    const judge = review.judge;
    if (!judge || typeof judge !== "object" || typeof judge.judged !== "boolean" ||
        (judge.judged ?
          !["allow", "ask", "deny"].includes(judge.decision) ||
          !["active", "shadow"].includes(judge.mode) || typeof judge.applied !== "boolean" ||
          !["judge", "hook", "fallback", "breaker"].includes(judge.source) ||
          typeof judge.rationale !== "string" || typeof judge.breakerTripped !== "boolean" ||
          judge.fallback !== undefined && !["timeout", "error", "unparseable", "unavailable"].includes(judge.fallback) ||
          judge.pause !== undefined && judge.pause !== "consecutive" && judge.pause !== "total"
        : !["judge-off", "rule-decided", "strict-mode", "capability-grant", "remote-controller", "category-not-judged", "category-disabled", "breaker-open"].includes(judge.skip))) {
      throw new JudgeContractError("Permission review requires valid judge evidence");
    }
    this.pipelineRequests.delete(result);
    const stale = issued.policyEpoch !== this.getPolicyEpoch();
    const failed = stale || !isReviewerAutoDecisionOutcome(review.outcome) || judge.judged && judge.fallback !== undefined;
    const level = judge.judged && judge.decision !== "allow" ? "high" : review.verdict.level;
    const resolved = this.pipelineResult({ ...issued.request, ...(stale ? { admissionDenial: { code: "policy-changed", reason: "Permission policy changed during review." } } : {}), reviewer: {
      level, status: failed ? "error" : "success",
      breakerOpen: judge.judged && judge.pause !== undefined,
    } }, issued.hostTerminalContext);
    resolved.reviewer = { route: result.reviewer.route, verdict: review.verdict, outcome: review.outcome,
      ...(review.approvalBasis ? { approvalBasis: review.approvalBasis } : {}) };
    return resolved;
  }

  resolveRememberedPermission(result: PermissionCheckResult, rememberedReason: string): PermissionCheckResult {
    const issued = this.pipelineRequests.get(result);
    if (!issued) throw new Error("Permission memory requires an issued pipeline request");
    const stale = issued.policyEpoch !== this.getPolicyEpoch();
    return this.pipelineResult({ ...issued.request,
      ...(stale ? { admissionDenial: { code: "policy-changed", reason: "Permission policy changed during approval lookup." } } : {}),
      rules: { ...issued.request.rules, remembered: rememberedReason },
    }, issued.hostTerminalContext);
  }

  private evaluatePermission(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    overlayTriggerOrigin: string | null | undefined,
    context: PermissionCheckContext,
  ): PermissionCheckResult {
    let admissionDenial = context.admissionDenial;
    let floor = context.floor;
    const invalidMeta = category === "meta" && (source !== "builtin" || context.decisionOverride === undefined);
    if (invalidMeta) admissionDenial ??= { code: "invalid-meta", reason: "The tool has no valid host decision contract." };
    const suppliedRuleSubject = context.ruleSubject?.kind === "shell" ? context.ruleSubject : undefined;
    const requestedRuleSubject = suppliedRuleSubject && context.hostTerminalTurn ? {
      ...suppliedRuleSubject,
      dialect: "bash" as const,
      cwd: context.hostTerminalTurn.physicalCwd,
      hostTerminal: { shell: context.hostTerminalTurn.shell, cwd: context.hostTerminalTurn.physicalCwd },
    } : suppliedRuleSubject;
    if (requestedRuleSubject && requestedRuleSubject.dialect !== "bash" && requestedRuleSubject.dialect !== "powershell") {
      throw new Error("Shell rule subject has no known dialect");
    }
    const cwdIdentity = context.hostShellExecutionPlan?.executionRequest === "host" && requestedRuleSubject?.cwd !== undefined
      ? captureShellWorkingDirectoryIdentity(requestedRuleSubject.cwd) : undefined;
    const ruleSubject = requestedRuleSubject === undefined ? undefined : {
      ...requestedRuleSubject, ...(cwdIdentity ? { cwd: cwdIdentity.realpath } : {}),
    };
    const projectRulesCwd = context.projectRulesCwd === requestedRuleSubject?.cwd && cwdIdentity
      ? cwdIdentity.realpath : context.projectRulesCwd;
    const projectRuleState = projectRulesCwd === undefined ? undefined : this.projectRuleScopes.stateFor(projectRulesCwd);
    const projectPolicyVersion = cwdIdentity === undefined ? undefined : this.projectRuleScopes.policyVersionFor(cwdIdentity.realpath);
    const projectRules = projectRuleState?.ok ? projectRuleState.rules : [];
    const policyError = this.rulesLoadError?.message ?? (projectRuleState?.ok === false ? projectRuleState.error.message : undefined) ?? context.permissionStoreError;
    if (policyError) admissionDenial ??= { code: "policy-unreadable", reason: policyError };
    if (context.remoteControllerAuthority && (category === "meta" || isTailnetControllerP1BlockedTool(toolName))) {
      admissionDenial ??= { code: "controller-capability", reason: "Remote controller capability-expanding operations are not enabled." };
    }
    if (context.remoteControllerAuthority || isStagedTurnSource(overlayTriggerOrigin ?? null)) {
      floor ??= { code: "other-principal", reason: "This principal requires local approval for the action." };
    }
    let secretRead = context.secretRead === true;
    const evidenceForPath = createPermissionPathEvidence(projectRulesCwd ?? requestedRuleSubject?.cwd ?? process.cwd());
    for (const path of context.paths ?? []) {
      const evidence = evidenceForPath(path);
      if (evidence.admissionDenial) admissionDenial ??= { code: "credential-store", reason: evidence.admissionDenial };
      if (evidence.projectEscape) floor ??= { code: "project-escape", reason: "The target escapes the project boundary." };
      if (evidence.protectedControl) floor ??= { code: "protected-path", reason: evidence.protectedControl };
      secretRead ||= path.effect === "read" && evidence.secret !== null;
    }
    const scopedSubject = context.ruleSubject?.kind !== "shell" ? context.ruleSubject : undefined;
    if (scopedSubject && ((scopedSubject.kind === "mcp" && source !== "mcp") || (scopedSubject.kind === "edit" && source !== "builtin") ||
      (scopedSubject.kind === "webfetch" && source !== "builtin" && !isHostNetworkSubject(scopedSubject)))) {
      throw new Error("Permission rule subject does not match the tool source");
    }
    if (scopedSubject && projectRuleState === undefined) throw new Error("Scoped permission rules require an explicit project scope");
    const scopedRules = scopedSubject ? evaluateScopedRules(scopedSubject, projectRuleState!.projectRoot, this.rules, projectRules) : undefined;
    if (scopedRules?.admissionDenial) admissionDenial ??= { code: "invalid-rule-target", reason: scopedRules.admissionDenial };
    if (scopedRules?.floor) {
      if (!scopedRules.floorCode) throw new Error("Scoped permission floor has no reason code");
      floor ??= { code: scopedRules.floorCode, reason: scopedRules.floor };
    }
    const networkScreen = scopedSubject?.kind === "webfetch" ? screenEgressRequest({ url: scopedSubject.url, allowPrivateNetwork: scopedSubject.privateNetwork }) : undefined;
    if (networkScreen?.outcome === "screened") floor ??= { code: "exfiltration", reason: `Network request carries an exfiltration signal: ${networkScreen.signal}` };
    const shellExecution = context.shellExecution ?? { runsSandboxed: false };
    const command = ruleSubject?.command;
    let floorInput: ShellFloorInput | null | undefined;
    let analysisLimited = command !== undefined && command.length > MAX_LITERAL_COMMAND_LENGTH;
    if (command !== undefined && !analysisLimited && shellExecution.runsSandboxed) {
      floorInput = prepareShellFloorInput(command, ruleSubject!.dialect);
      analysisLimited ||= floorInput === null || shellFloorInputExceeded(floorInput.parsed ?? floorInput.command);
    }
    const bound = ruleSubject?.cwd !== undefined && command !== undefined && !analysisLimited
      ? verifiedShellParsed(context.verifiedShellCommand, { command, dialect: ruleSubject.dialect, cwd: ruleSubject.cwd }) : undefined;
    const parsed = command !== undefined && ruleSubject?.dialect === "bash" && !analysisLimited
      ? bound && "analysis" in bound ? bound : parseShellFloorCommand(floorInput?.parsed ?? command) : undefined;
    const parsedPowerShell = command !== undefined && ruleSubject?.dialect === "powershell" && !analysisLimited
      ? bound && "syntax" in bound ? bound : parsePowerShellCommand(command) : undefined;
    analysisLimited ||= parsed !== undefined && !parsed.analysis.ok && shellFloorParserBudgetExceeded(parsed.analysis.reason) || parsedPowerShell?.analysisLimited === true;
    const shellSignals = !analysisLimited && parsed ? inspectShellCommand(parsed, ruleSubject?.cwd)
      : !analysisLimited && parsedPowerShell ? inspectPowerShellCommand(parsedPowerShell, ruleSubject?.cwd) : undefined;
    analysisLimited ||= shellSignals?.analysisLimited === true;
    if (shellSignals?.exfiltration) floor ??= { code: "exfiltration", reason: shellSignals.exfiltration };
    const shellShape = parsed && !analysisLimited ? analyzeShellForRules(parsed, ruleSubject?.cwd) : undefined;
    const shellPaths = command !== undefined && ruleSubject?.cwd !== undefined && ruleSubject.dialect === "bash"
      ? inspectShellPermissionPaths(command, ruleSubject.cwd, { dialect: ruleSubject.dialect, environment: shellExecution.environmentSnapshot ?? {} }) : undefined;
    const powerShellPaths = command !== undefined && ruleSubject?.dialect === "powershell" && ruleSubject.cwd !== undefined
      ? inspectPowerShellPermissionPaths(parsedPowerShell ?? command, ruleSubject.cwd, shellExecution.environmentSnapshot ?? {}) : undefined;
    if (shellPaths?.unproven?.kind === "analysis-limit" || powerShellPaths?.evidenceLimitExceeded) admissionDenial ??= { code: "shell-analysis-limit", reason: "Shell path evidence exceeded its analysis limit." };
    if (powerShellPaths?.credentialStore) admissionDenial ??= { code: "credential-store", reason: powerShellPaths.credentialStore };
    const unknownProtectedWrite = shellPaths?.unknownProtectedWrite ?? powerShellPaths?.unknownProtectedWrite;
    if (unknownProtectedWrite) floor ??= { code: "protected-path", reason: unknownProtectedWrite };
    const parsedRoot = parsed?.analysis.ok ? parsed.analysis.program : undefined;
    const simpleRoot = parsedRoot?.kind === "sequence" && parsedRoot.statements.length === 1 ? parsedRoot.statements[0] : parsedRoot;
    const hostBoundWriteTargets = shellExecution.environmentSnapshot !== undefined && shellPaths?.resolvedWriteTargetsOnly === true
      && simpleRoot?.kind === "command";
    for (const evidence of [...(shellPaths?.paths ?? []), ...(powerShellPaths?.paths ?? [])]) {
      if (evidence.admissionDenial) admissionDenial ??= { code: "credential-store", reason: evidence.admissionDenial };
      const criticalDelete = evidence.deleteIntent ? criticalDeleteTargetFor(evidence, [projectRulesCwd ?? ruleSubject?.cwd ?? process.cwd()]) : undefined;
      if (criticalDelete) floor ??= { code: "critical-delete", reason: criticalDelete };
      if (evidence.projectEscape) floor ??= { code: "project-escape", reason: "The shell target escapes the project boundary." };
      if (evidence.protectedControl) floor ??= { code: "protected-path", reason: evidence.protectedControl };
      secretRead ||= evidence.effect === "read" && evidence.secret !== null;
    }
    const sessionRules = context.sessionId === undefined ? [] : this.sessionRules.get(approvalConversationRoot(context.sessionId)) ?? [];
    const shellRules = !analysisLimited && parsed ? evaluateShellSubject({ command: parsed, cwd: ruleSubject?.cwd, exactAllowOnly: shellSignals?.exactLiteralEvaluation === true,
        ...(ruleSubject?.hostTerminal === undefined ? {} : { hostTerminal: ruleSubject.hostTerminal }) }, this.rules, projectRules, sessionRules)
      : !analysisLimited && parsedPowerShell ? evaluatePowerShellSubject({ command: parsedPowerShell, cwd: ruleSubject?.cwd, exactAllowOnly: shellSignals?.exactLiteralEvaluation === true, floorSignal: shellSignals?.exfiltration ?? null }, this.rules, projectRules, sessionRules) : undefined;
    const approvalKey = normalizeApprovalCacheKey(context.approvalCacheKey);
    const denyTargets = approvalKey ? [toolName, approvalKey] : [toolName];
    const allowTarget = approvalKey ?? toolName;
    const matchingRule = (action: PermissionRule["action"]) => [...this.rules, ...projectRules, ...sessionRules].find((rule) =>
      rule.action === action && (!rule.source || rule.source === source) && !isRuleSpecifier(rule.pattern) &&
      (action === "allow" ? globMatch(allowTarget, rule.pattern) && grantCovers(normalizeTier(rule.tier), category) : denyTargets.some((target) => globMatch(target, rule.pattern))));
    const deny = matchingRule("deny");
    const ask = matchingRule("ask");
    const allow = matchingRule("allow");
    const rules: NonNullable<PermissionDecisionRequest["rules"]> = {};
    if (deny || shellRules?.decision === "deny" || scopedRules?.decision === "deny") rules.deny = deny?.pattern ?? (shellRules?.decision === "deny" ? shellRules.pattern : undefined) ?? scopedRules?.pattern ?? "Deny rule matched";
    if (ask || shellRules?.decision === "ask" || scopedRules?.decision === "ask") rules.ask = ask?.pattern ?? (shellRules?.decision === "ask" ? shellRules.pattern : undefined) ?? scopedRules?.pattern ?? "Ask rule matched";
    if (allow || shellRules?.decision === "allow" || scopedRules?.decision === "allow") rules.allow = allow?.pattern ?? (shellRules?.decision === "allow" ? shellRules.patterns.join(", ") : scopedRules?.pattern) ?? "Allow rule matched";
    if (source === "builtin" && category === "meta" && context.decisionOverride === "always-allow-with-audit") rules.allow ??= "The host operation supplies its own audited decision.";
    if (context.fileWritePolicy?.directoryApproved) rules.remembered = "The user approved this write together with its directory grant.";
    const grant = this.alwaysAllowed.get(allowTarget);
    if (grant !== undefined && grantCovers(grant, category)) rules.remembered = "Previous approval covers this tool.";
    const shellDestructive = ruleSubject !== undefined && Boolean((floorInput?.destructive ?? isDestructiveShellText(ruleSubject.command)) || (shellShape?.ok && shellShape.commands.some((leaf) => {
      const wrapped = wrapperCommand(leaf.argv);
      const argv = wrapped.ordinaryAsk === undefined && wrapped.code === undefined && wrapped.candidateRange === undefined && !wrapped.runtimeArgv && !wrapped.nestedDialect ? leaf.argv.slice(wrapped.index) : leaf.argv;
      return isDestructiveShellArgv(argv) || noReusableRuleReason(argv.map((arg) => arg ?? "")) !== null;
    })));
    const readOnlyProven = context.shellReadOnlyProven ?? (command !== undefined && !analysisLimited && isReadOnlyCommand(command));
    // Meta is host dispatch metadata; normalize its authenticated contract to an effect kind.
    const effectKind = category === "meta" && !invalidMeta
      ? context.decisionOverride === "always-allow-with-audit" ? "read" : "write"
      : category;
    const request: PermissionDecisionRequest = {
      sessionId: context.sessionId,
      tool: { name: toolName, source, kind: source === "mcp" ? "mcp" : context.fileWritePolicy ? "file-write" : effectKind, readOnlyHint: context.mcpReadOnlyHint },
      mode: this.toolModeOverrides.get(toolName) ?? this.mode,
      headless: context.headless === true || context.approvalSurface === "unavailable", ownerAway: context.ownerUnattended, paths: [...(context.paths ?? []), ...(shellPaths?.paths ?? []), ...(powerShellPaths?.paths ?? [])].map(({lexical,canonical,effect}) => ({lexical,canonical,effect})),
      admissionDenial, floor, rules, secretRead, manualRerun: context.manualRerun,
      ...(context.fileWritePolicy ? { fileWrite: { ...context.fileWritePolicy, checkpointAvailable: context.fileWritePolicy.checkpointAvailable === true } } : {}),
      ...(category === "shell" ? { shell: { sandboxed: shellExecution.runsSandboxed, readOnlyProven, unproven: analysisLimited || shellPaths?.unproven != null || powerShellPaths?.unproven === true || !hostBoundWriteTargets && !readOnlyProven && (shellSignals?.outcome === "unproven" || Boolean(shellShape?.ok ? shellShape.ordinaryAsk : shellShape?.reason)), destructive: shellDestructive, escalated: context.shellEscalated } } : {}),
    };
    const result = this.pipelineResult(request, context);
    if (result.decision === "allow" && result.reasonCode === "rule-allow" && context.hostShellExecutionPlan?.executionRequest === "host" && requestedRuleSubject?.cwd !== undefined && cwdIdentity && this.userRulesVersion && projectPolicyVersion && isPersistedPolicyVersionCurrent(this.userRulesVersion) && isPersistedPolicyVersionCurrent(projectPolicyVersion)) {
      issuedShellAllowRuleDecisions.set(result, Object.freeze({ toolName, dialect: requestedRuleSubject.dialect, command: requestedRuleSubject.command, cwd: requestedRuleSubject.cwd, cwdIdentity, issuer: this, policyEpoch: this.getPolicyEpoch(), persistedPolicyVersions: Object.freeze([this.userRulesVersion, projectPolicyVersion]) }));
    }
    return result;
  }

  // Dispatch review evidence; the decision pipeline owns its permission outcome.
  async dispatchReviewer(
    toolName: string,
    input: ReviewerDispatchInput,
    routineScope?: Record<string, unknown>,
    options?: { lane?: ReviewerLane; abortSignal?: AbortSignal; purpose?: "approval-scope" },
  ): Promise<ReviewerDispatchResult> {
    const permission = input.permissionDecision as PermissionCheckResult | undefined;
    const issued = permission === undefined ? undefined : this.pipelineRequests.get(permission);
    if (issued?.request.userOwnedSurface?.choice === "auto") {
      const current = this.pipelineResult(issued.request, issued.hostTerminalContext);
      const currentRequest = this.pipelineRequests.get(current)!.request;
      this.pipelineRequests.delete(current);
      if (!current.reviewer || current.reasonCode !== "user-owned-surface-review") {
        return { verdict: { level: "high", reason: current.reason }, outcome: "unavailable", cacheReason: "miss-not-found",
          judge: { judged: false, skip: "rule-decided" } };
      }
      if (currentRequest.tool.name !== toolName || currentRequest.tool.source !== input.source || currentRequest.sessionId !== input.sessionId || !input.invocationId?.trim()) throw new JudgeContractError("Logical review requires its issued surface action");
      return this.dispatchSurfaceReviewer(currentRequest, issued.hostTerminalContext!, input, options?.abortSignal);
    }
    if (permission?.pipelineRequest?.userOwnedSurface) throw new JudgeContractError("Logical review requires an issued surface request");
    const lane = (options?.lane ?? input.permissionDecision?.reviewer?.route) === "headless" ? "headless" : "foreground";
    let judged: Awaited<ReturnType<PermissionManager["dispatchJudge"]>>;
    try {
      judged = await this.dispatchJudge(toolName, input, lane, options?.abortSignal, {
        routineScope, ...(options?.purpose === "approval-scope" ? { baseline: true as const, scopeAssessment: true as const } : {}),
      });
    } catch (error) {
      if (!options?.abortSignal?.aborted || error instanceof JudgeContractError) throw error;
      // A caller stop is terminal, never a classifier block or a cached grant.
      return {
        verdict: { level: "high", reason: "reviewer cancelled by caller" }, outcome: "error", cacheReason: "miss-not-found",
        judge: { judged: true, mode: "active", decision: "deny", applied: true,
          source: "fallback", fallback: "error", rationale: "reviewer cancelled by caller", breakerTripped: false },
      };
    }
    if (judged.baseline) return judged.baseline;
    return reviewerResultForJudge(judged);
  }

  private async dispatchSurfaceReviewer(request: PermissionDecisionRequest, context: HostTerminalPermissionContext, input: ReviewerDispatchInput, signal?: AbortSignal): Promise<ReviewerDispatchResult> {
    const finish = (consistent: boolean, reason: string, outcome: ReviewerDispatchOutcome): ReviewerDispatchResult => {
      const breakerTripped = outcome === "fresh" ? this.judgeBreaker.record(this.resolveJudgeRootSession(input.sessionId!), consistent ? "allow" : "ask", input.invocationId) : false;
      const pause = this.getAutomatedApprovalPauseReason(input.sessionId);
      return { verdict: { level: consistent ? "low" : "high", reason }, outcome, cacheReason: "miss-not-found",
        judge: { judged: true, mode: "active", decision: consistent ? "allow" : "ask", applied: true, source: "judge", rationale: reason, breakerTripped, ...(pause ? { pause } : {}) } };
    };
    if (!input.conversationContext?.recentUserMessage?.trim()) return finish(false, "The user request is missing.", "unavailable");
    if (!input.conversationContext.currentTaskStep?.trim()) return finish(false, "The current task step is missing.", "unavailable");
    const reviewer = this.surfaceReviewer;
    if (!reviewer || !this.reviewerJudgmentEnabled || this.reviewerUnavailableReason) return finish(false, "Logical consistency review is unavailable.", "unavailable");
    const reviewInput: UserOwnedSurfaceReviewInput = {
      surface: request.userOwnedSurface!.kind, toolName: request.tool.name, userRequest: input.conversationContext.recentUserMessage,
      currentTaskStep: input.conversationContext.currentTaskStep,
      target: context.hostTerminalTurn ? { shell: context.hostTerminalTurn.shell, cwd: context.hostTerminalTurn.physicalCwd, tabId: context.hostTerminalTurn.tabId } : { ...context.userOwnedBrowser },
      action: input.finalInput,
    };
    const outcome = await runWithCeiling(innerSignal => reviewer(reviewInput, innerSignal), TOOL_TIMEOUT_POLICY.reviewerHttpTimeoutMs, signal, "Logical consistency review");
    if (signal?.aborted) throw signal.reason;
    if (!outcome.ok) return finish(false, "Logical consistency review could not confirm the action.", outcome.reason === "ceiling" ? "timeout" : outcome.error instanceof UserOwnedSurfaceReviewError ? "malformed" : "error");
    const result = outcome.value;
    if (!result || typeof result.consistent !== "boolean" || typeof result.reason !== "string" || !result.reason.trim() || result.reason.length > 200) return finish(false, "Logical consistency review returned invalid output.", "malformed");
    return finish(result.consistent, result.reason, "fresh");
  }

  private async assessReviewer(
    toolName: string,
    input: ReviewerDispatchInput,
    routineScope: Record<string, unknown> | undefined,
    options: { abortSignal?: AbortSignal; tracingClassifier: TracingRiskClassifier | null; cacheScope?: Record<string, unknown>; stageOwnModel?: boolean },
  ): Promise<ReviewerAssessmentResult> {
    // Freeze the canonical scope before review can await; the same path grades raw arguments and later appears on the exact remembered-allow card.
    const workingDirectory = input.executionCwd === undefined
      ? undefined : captureApprovalWorkingDirectory(input.executionCwd);
    const readSandboxCacheState = (): ReviewerSandboxCacheState =>
      resolveReviewerSandboxCacheState(
        input.source, toolName, input.mcpServerId, input.workerId,
        input.pluginId, input.hostShellExecutionPlan, input.disposableSubstrate,
      );
    let sandboxCacheState = readSandboxCacheState();
    const buildReviewerContext = (
      reviewerSandboxState: ReviewerSandboxCacheState = sandboxCacheState,
    ): ToolInvocationContext => ({
      toolName, source: input.source, category: input.category,
      pathFields: input.pathFields, trustOrigin: input.trustOrigin,
      finalInput: input.finalInput,
      executionCwd: workingDirectory?.path ?? input.executionCwd,
      allowedDirectories: input.allowedDirectories,
      sensitivePathsAdjacent: input.sensitivePathsAdjacent,
      sandboxCapability: reviewerSandboxState.capability,
      ...(input.permissionDecision ? { permissionReason: input.permissionDecision.reason } : {}),
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      ...(input.ownerPluginSandboxRoot !== undefined ? { ownerPluginSandboxRoot: input.ownerPluginSandboxRoot } : {}),
    });
    const approvalBasisFor = (ruleVerdict: RiskVerdict["level"], outcome: ReviewerDispatchOutcome): ReviewerApprovalBasis | undefined => {
      if (workingDirectory === undefined) return undefined;
      const basis = Object.freeze({
        ruleVerdict, outcome, workingDirectory,
        requestIdentity: canonicalStringify({
          toolName, args: input.finalInput, source: input.source,
          category: input.category, trustOrigin: input.trustOrigin,
          approvalCacheKey: input.approvalCacheKey, executionCwd: input.executionCwd,
        }),
      });
      issuedApprovalBases.add(basis);
      return basis;
    };
    // Only a judge stage configured with its own model may run while the reviewer's model is unavailable. A model-less stage also supplies a tracing classifier (when a hook redacted its view), but that classifier is the reviewer's own, so it is refused like the reviewer.
    if ((this.reviewerUnavailableReason !== undefined || !this.reviewerJudgmentEnabled) && options?.stageOwnModel !== true) {
      return {
        verdict: { level: "high", reason: this.reviewerUnavailableReason ?? "Permission reviewer is disabled" },
        cacheReason: "miss-not-found",
        outcome: "unavailable",
        approvalBasis: approvalBasisFor(new RuleBasedRiskClassifier().classify(buildReviewerContext()).level, "unavailable"),
      };
    }
    if (!options.tracingClassifier || !this.verdictCache) {
      return {
        verdict: { level: "high", reason: "Reviewer is unavailable" },
        cacheReason: "miss-not-found",
        outcome: "unavailable",
        approvalBasis: approvalBasisFor(new RuleBasedRiskClassifier().classify(buildReviewerContext()).level, "unavailable"),
      };
    }
    const cache = this.verdictCache!;
    const cacheIdentityInput = input.cacheIdentityInput ?? input.finalInput;
    const hostShellExecutionPlanAudit = input.hostShellExecutionPlan === undefined
      ? undefined
      : getHostShellExecutionPlanAuditProjection(input.hostShellExecutionPlan);

    const lookupKey = {
      toolName,
      source: input.source,
      category: input.category,
      pathFields: input.pathFields,
      trustOrigin: input.trustOrigin,
      approvalCacheKey: input.approvalCacheKey,
      conversationContext: input.conversationContext,
      finalInput: cacheIdentityInput,
      // the owning plugin's sandbox root participates in cache identity. A future change (plugin renamed/reinstalled) invalidates the auto-LOW verdict that now DEPENDS on it. v6: the untrusted `writesToOwnSandbox` self-claim no longer participates.
      ownerPluginSandboxRoot: input.ownerPluginSandboxRoot,
      mcpServerId: input.mcpServerId,
      pluginId: input.pluginId,
      workerId: input.workerId,
      hostShellExecutionPlan: hostShellExecutionPlanAudit,
    };
    // User-approval memory hit Check the user-approval store before consulting the LLM classifier. A memory hit for a non-revoked approval bypasses the LLM call and returns the rule-based verdict directly (composition rule still applies — sandbox/context quality can only raise, not lower). HIGH-verdict approvals are intentionally included: if the user already justified a HIGH action this session, re-running the LLM is wasteful. Built outside the storage catch: a key without its identity mode is an internal contract violation and must surface, not read as a miss.
    const userApprovalIdentity = approvalCacheKeyIdentity(input.approvalCacheKey, input.approvalMemory);
    const userApprovalArgs = canonicalStringify(cacheIdentityInput);
    const rememberedDecision = await lookupApproval(
      toolName,
      userApprovalArgs,
      input.source,
      input.trustOrigin,
      userApprovalIdentity,
      input.executionCwd,
      input.sessionId,
    ).catch(() => null); // storage failure must not block tool execution
    // Only a decision made on exactly these arguments short-circuits review
    // here. A target-wide hit on other arguments is classified as a fresh
    // request; the foreground memory skip may reuse it only after that review.
    const userApproval = rememberedDecision && isExactArgsDecision(rememberedDecision, userApprovalArgs, toolName)
      ? rememberedDecision
      : null;

    const buildCacheContext = (sandboxCacheState: ReviewerSandboxCacheState) => {
      const sandboxScope = sandboxCacheState.capability;
      return {
        allowedDirectories: input.allowedDirectories,
        scope: {
          ...(routineScope ?? {}),
          reviewer: options?.cacheScope ?? this.reviewerCacheScope,
          reviewerFrameworkVersion: PERMISSION_REVIEWER_FRAMEWORK_VERSION,
          reviewerOutcomeContractVersion: 1,
          sandboxKind: sandboxScope.kind,
          sandboxConfidence: sandboxScope.confidence,
          hostShellExecutionPlan: sandboxCacheState.hostShellExecutionPlan ?? null,
        },
        sandboxWrapState: sandboxCacheState,
      };
    };

    // Include the sandbox capability in the cache scope so a change to OS isolation invalidates stale verdicts produced under different sandbox assumptions. Capture this live state immediately before cache lookup: no await may sit between wrap-state sampling and cache lookup, or a worker un-wrap could replay a verdict relaxed under stale confinement.
    sandboxCacheState = readSandboxCacheState();
    const cacheCtx = buildCacheContext(sandboxCacheState);
    const cacheResult = cache.lookup(lookupKey, cacheCtx);
    let verdict: RiskVerdict;
    let ruleVerdictForAudit: RiskVerdict["level"] | null = null;
    let llmVerdictForAudit: RiskVerdict["level"] | null = null;
    let userApprovalUsed: {
      memoryHit: boolean;
      nlJustification: string | null;
      verdictAtApproval: UserApprovalVerdict | null;
    } | null = null;
    let outcome: ReviewerDispatchOutcome = "fresh";
    let sandboxStateForAudit = sandboxCacheState;
    // A null approval-time verdict means lost provenance, never medium or the current rule risk. Treat it as a miss and re-prompt so risk cannot downgrade and audit cannot invent a prior assessment.
    if (userApproval && userApproval.verdictAtApproval == null) {
      // Structured marker as 2nd arg keeps tests stable across i18n / wording changes. The human-readable first arg stays for existing log readers.
      console.warn(
        `[permission] legacy entry without verdictAtApproval — rejecting memory hit, forcing fresh approval (tool=${toolName}, scope=${userApproval.scope})`,
        { event: "legacy-null-verdict", toolName, scope: userApproval.scope },
      );
    }
    if (userApproval && userApproval.verdictAtApproval != null) {
      // Memory hit — use the rule-based verdict (cheaper + consistent). We still run the rule classifier to get a fresh verdict; we just skip the LLM call. The max(rule, stored) composition would allow the LLM to downgrade — rule-only is the safe choice here.
      const ctx = buildReviewerContext();
      // Use the rule-based classifier for fast sync classification (no LLM call). Take max(ruleVerdict, verdictAtApproval) so a stored HIGH approval cannot be silently downgraded if the rule classifier now returns LOW/MEDIUM.
      const ruleClassifier = new RuleBasedRiskClassifier();
      const ruleVerdict = ruleClassifier.classify(ctx);
      ruleVerdictForAudit = ruleVerdict.level;
      // Narrowed above: the outer `userApproval.verdictAtApproval != null` gate guarantees a concrete verdict literal here.
      const storedLevel: UserApprovalVerdict = userApproval.riskCeilingAtApproval ?? userApproval.verdictAtApproval;
      verdict = maxVerdict(ruleVerdict, { level: storedLevel, reason: `stored approval verdict at approval time` });
      userApprovalUsed = {
        memoryHit: true,
        nlJustification: userApproval.nlJustification,
        verdictAtApproval: userApproval.verdictAtApproval,
      };
      outcome = "approval-memory";
      // Disclose the memory-hit auto-approve to the renderer + log. verdictAtApproval is non-null inside this branch — the outer gate `userApproval.verdictAtApproval != null` rejects legacy entries above, so the concrete literal passes straight through to UserApprovalHitPayload (non-null per SOT).
      this.discloseUserApprovalHit({
        toolName,
        scope: userApproval.scope,
        verdictAtApproval: userApproval.verdictAtApproval,
      });
    } else if (cacheResult.hit && cacheResult.verdict) {
      const ruleClassifier = new RuleBasedRiskClassifier();
      ruleVerdictForAudit = ruleClassifier.classify(buildReviewerContext()).level;
      verdict = cacheResult.verdict;
      outcome = "cache";
    } else {
      const ctx = buildReviewerContext();
      try {
        const trace = await options.tracingClassifier.classifyWithTrace(ctx, { abortSignal: options.abortSignal });
        assertRiskClassificationTrace(trace);
        verdict = trace.finalVerdict;
        outcome = trace.outcome;
        ruleVerdictForAudit = trace.ruleVerdict.level;
        llmVerdictForAudit = trace.llmVerdict?.level ?? null;
        const postReviewSandboxState = readSandboxCacheState();
        if (options?.abortSignal?.aborted === true) {
          // Dispatcher/executor own the terminal abort result. Internally mark this non-success so an aborted fresh verdict cannot seed the cache.
          outcome = "error";
        } else if (!sameReviewerSandboxCacheState(sandboxCacheState, postReviewSandboxState)) {
          sandboxStateForAudit = postReviewSandboxState;
          const freshRuleVerdict = new RuleBasedRiskClassifier().classify(
            buildReviewerContext(postReviewSandboxState),
          );
          ruleVerdictForAudit = freshRuleVerdict.level;
          verdict = {
            level: "high",
            reason: "reviewer sandbox state changed during classification — fail-safe re-review required",
          };
          outcome = "sandbox-state-changed";
        } else {
          // Only a successful fresh classification may become a base-cache entry. malformed/error/timeout fallback verdicts remain fail-safe for this invocation and can never reappear as an eligible "cache" rationale outcome on the next call.
          if (outcome === "fresh") {
            // The verdict cache is the one sink written BEFORE the common redaction point below, so it redacts its own copy. A cache hit then replays an already-masked reason.
            await cache.store(lookupKey, cacheCtx, redactVerdictReason(verdict));
          }
        }
      } catch (err) {
        if (err instanceof JudgeContractError) throw err;
        const message = errorMessage(err);
        verdict = { level: "high", reason: `reviewer error — ${message}` };
        outcome = "error";
        ruleVerdictForAudit = new RuleBasedRiskClassifier().classify(ctx).level;
        llmVerdictForAudit = null;
      }
    }

    // Verdict reason redaction The classifier grades RAW input (see ReviewerDispatchInput.finalInput), so a classifier reason may echo argument text — and `reason` is display data: it is broadcast to the renderer as a permission-review event, recorded in the sandbox audit. The host does not trust a classifier to have redacted its own prose. Mask HERE, on the one path every sink downstream of this point shares. The verdict LEVEL, which is the only field any decision reads, is untouched.
    verdict = redactVerdictReason(verdict);

    // Reviewer-dispatch audit emit Emit a sandbox audit entry for every dispatchReviewer call so the audit log captures reviewer composition signals + user-approval provenance. Failures are swallowed so audit never blocks tool execution. Record the SUBSTRATE-aware capability used for the final reviewer verdict (not the process-global) so the audit honestly reflects this call's execution substrate.
    const sandboxCap = sandboxStateForAudit.capability;
    const auditEntry = buildSandboxAuditEntry({
      tool: {
        name: toolName,
        // emitSandboxAudit's sink trusts callers to pass DLP-redacted fields.
        args: maskSensitiveData(
          JSON.stringify(input.auditInput ?? input.finalInput),
        ).masked,
        source: input.source,
        trustOrigin: input.trustOrigin,
        ...(input.approvalCacheKey ? { approvalCacheKey: input.approvalCacheKey } : {}),
      },
      sandbox: {
        kind: sandboxCap.kind,
        confidence: sandboxCap.confidence,
        events: [],
        spawnLatencyMs: 0,
        overheadPercent: 0,
      },
      reviewer: {
        ruleVerdict: ruleVerdictForAudit ?? verdict.level,
        llmVerdict: llmVerdictForAudit,
        finalVerdict: verdict.level,
        // A host-determined verdict deliberately skipped the LLM layer; record it here so an auditor can tell "review skipped by host policy" apart from "cache hit" and "non-LLM classifier", which also leave llmVerdict null.
        compositionRulesTriggered: outcome === "host-determined"
          ? [{
              rule: "host-determined",
              reason: "LLM review skipped by host policy — rule verdict is final by construction",
            }]
          : [],
        userApprovalUsed: userApprovalUsed
          ? {
              ...userApprovalUsed,
              nlJustification:
                userApprovalUsed.nlJustification === null
                  ? null
                  : maskSensitiveData(userApprovalUsed.nlJustification).masked,
            }
          : null,
      },
    });
    emitSandboxAudit(auditEntry).catch(() => {
      // intentionally swallowed — audit failure must not block tool execution
    });

    return {
      verdict, outcome, approvalBasis: approvalBasisFor(ruleVerdictForAudit ?? verdict.level, outcome), cacheReason: cacheResult.reason,
    };
  }

  async dispatchJudge(
    toolName: string,
    input: ReviewerDispatchInput,
    lane: JudgeLane,
    abortSignal?: AbortSignal,
    context?: { routineScope?: Record<string, unknown>; baseline?: true; scopeAssessment?: true },
  ): Promise<JudgeDispatchResult> {
    if (input.sessionId === undefined || input.sessionId.trim().length === 0) {
      throw new JudgeContractError("Automated permission review requires a session id");
    }
    if (typeof input.invocationId !== "string" || input.invocationId.trim().length === 0) {
      throw new JudgeContractError("Automated permission review requires an invocation id");
    }
    const wired = this.judgeDeps;
    if (!wired) throw new JudgeContractError("Permission judge is not wired");
    const baseline = context?.baseline === true || !this.hasJudge(input.category);
    const defaultStage = { provider: "builtin-llm" as const, id: "builtin-llm" };
    const deps: JudgeEngineDeps = baseline ? {
      budget: "classifier",
      settings: { ...DEFAULT_JUDGE_SETTINGS, chain: [defaultStage], mode: "active", categories: { shell: true, write: true, network: true } },
      chain: [{ settings: defaultStage, judge: new BuiltinLlmJudge(this.reviewerClassifier, this.reviewerModel) }],
      breaker: wired.breaker, audit: wired.audit,
    } : wired;
    const policyEpoch = this.getPolicyEpoch();
    const sandboxState = resolveReviewerSandboxCacheState(
      input.source, toolName, input.mcpServerId, input.workerId, input.pluginId,
      input.hostShellExecutionPlan, input.disposableSubstrate,
    );
    const invocation: ToolInvocationContext = {
      toolName, source: input.source, category: input.category, pathFields: input.pathFields,
      trustOrigin: input.trustOrigin, finalInput: input.finalInput, executionCwd: input.executionCwd,
      allowedDirectories: input.allowedDirectories, sensitivePathsAdjacent: input.sensitivePathsAdjacent,
      sandboxCapability: sandboxState.capability,
      ...(input.permissionDecision ? { permissionReason: input.permissionDecision.reason } : {}),
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      ...(input.ownerPluginSandboxRoot ? { ownerPluginSandboxRoot: input.ownerPluginSandboxRoot } : {}),
    };
    const ruleVerdict = new RuleBasedRiskClassifier().classify(invocation);
    let reviewer: ReviewerAssessmentResult | undefined;
    let reviewerStageId: string | undefined;
    const chain = deps.chain.map((stage) => {
      const builtin = stage.judge;
      if (!(builtin instanceof BuiltinLlmJudge)) return stage;
      return { ...stage, judge: new BuiltinLlmJudge({
        classifyWithTrace: async (judgeInvocation, options) => {
          // Hooks may hide values from a provider, but the approval identity and audit still describe the exact original call.
          const policyRedacted = judgeInvocation.finalInput !== invocation.finalInput;
          const result = await this.assessReviewer(toolName, {
            ...input, finalInput: judgeInvocation.finalInput,
            cacheIdentityInput: input.cacheIdentityInput ?? input.finalInput,
          }, context?.routineScope, {
            abortSignal: options?.abortSignal,
            tracingClassifier: builtin.getClassifier(),
            ...(stage.settings.model ? { stageOwnModel: true } : {}),
            ...(stage.settings.model || policyRedacted ? {
              cacheScope: {
                ...this.reviewerCacheScope,
                judgeModel: builtin.model,
                judgeTransport: builtin.cacheScope,
                ...(policyRedacted ? { judgeView: canonicalStringify(judgeInvocation.finalInput) } : {}),
              },
            } : {}),
          });
          const finalVerdict = baseline ? result.verdict : redactVerdictReason(maxVerdict(ruleVerdict, result.verdict));
          reviewer = { ...result, verdict: finalVerdict, ...(policyRedacted ? { approvalBasis: undefined } : {}) };
          reviewerStageId = stage.settings.id;
          return reviewerAssessmentTrace({ ...result, verdict: finalVerdict }, ruleVerdict);
        },
      }, builtin.model) };
    });
    const reviewedRequest = input.permissionDecision ? this.pipelineRequests.get(input.permissionDecision as PermissionCheckResult)?.request : undefined;
    const gate: JudgeGate = {
      priorDecision: "undecided", strictMode: context?.scopeAssessment !== true && (reviewedRequest?.mode ?? this.mode) === "strict",
      capabilityGrant: !baseline && input.category === "meta", remoteController: false,
      reviewerBaseline: baseline,
    };
    const request: JudgeRequest = {
      invocationId: input.invocationId,
      sessionId: this.resolveJudgeRootSession(input.sessionId),
      lane, invocation,
      recentUserMessages: input.conversationContext?.recentUserMessage ? [input.conversationContext.recentUserMessage] : [],
      projectRoot: projectRulesLocation(dirname(this.permissionsFilePath), input.executionCwd).projectRoot,
      ruleVerdict, policy: { mode: this.mode },
    };
    let outcome = await resolveJudge(gate, request, {
      ...deps,
      chain,
      hooks: {
        ...(deps.hooks?.beforeJudge ? { beforeJudge: deps.hooks.beforeJudge } : {}),
        afterJudge: async (verdict, request) => {
          const hookResult = deps.hooks?.afterJudge ? await deps.hooks.afterJudge(verdict, request) : verdict.decision;
          const decision = typeof hookResult === "string" ? hookResult : hookResult.decision;
          if (!isSameOrStricter(verdict.decision, decision)) {
            throw new JudgeContractError("afterJudge may only downgrade");
          }
          const current = resolveReviewerSandboxCacheState(
            input.source, toolName, input.mcpServerId, input.workerId, input.pluginId,
            input.hostShellExecutionPlan, input.disposableSubstrate,
          );
          const policyChanged = this.getPolicyEpoch() !== policyEpoch;
          return policyChanged || !sameReviewerSandboxCacheState(sandboxState, current)
            ? { decision: decision === "allow" ? "ask" : decision,
                rationale: policyChanged ? "Permission policy changed during judge review" : "Execution sandbox changed during judge review", fallback: "unavailable" }
            : hookResult;
        },
      },
    }, abortSignal);
    // Audit and the unchanged shadow reviewer can both await. Recheck the host snapshot after their last await before publishing any allow.
    const staleReason = (): string | undefined => {
      if (this.getPolicyEpoch() !== policyEpoch) return "Permission policy changed during judge review";
      const current = resolveReviewerSandboxCacheState(
        input.source, toolName, input.mcpServerId, input.workerId, input.pluginId,
        input.hostShellExecutionPlan, input.disposableSubstrate,
      );
      return sameReviewerSandboxCacheState(sandboxState, current) ? undefined : "Execution sandbox changed during judge review";
    };
    const recordStateFailure = (reason: string): Promise<JudgeOutcome> => resolveJudge(
      gate, request, {
        ...deps,
        hooks: { beforeJudge: () => ({ action: "short-circuit", decision: "ask", reason, fallback: "unavailable" }) },
      }, abortSignal,
    );
    let stale = staleReason();
    if (stale && outcome.judged && (outcome.decision === "allow" || outcome.fallback !== "unavailable")) outcome = await recordStateFailure(stale);
    if (!stale && !deps.settingsUnreadable && deps.settings.mode === "shadow") {
      const automatic = await this.dispatchJudge(toolName, input, lane, abortSignal, { ...context, baseline: true });
      stale = staleReason();
      if (!stale) return {
        outcome, ruleVerdict,
        baseline: reviewerResultForJudge(automatic),
      };
      outcome = await recordStateFailure(stale);
    }
    if (!outcome.judged || (!outcome.fallback && outcome.decidedBy !== reviewerStageId)) reviewer = undefined;
    return { outcome, ruleVerdict, ...(reviewer ? { reviewer } : {}) };
  }


}

// path-grant prune helpers
// Split single-path grant markers at the first :path: so drive colons survive. Move grants encode source/destination separately and are deliberately not pruned here; they retain tier checks and require an explicit two-path revocation policy before adding support.
const GRANT_PATH_MARKER = ":path:";

// Extract the absolute path a path-scoped grant pattern targets, or `null` when the pattern is not a path grant. Returns null for plain tool-name globs (`web_fetch`) AND for `move_file`'s `source:…:destination:…` pattern (see GRANT_PATH_MARKER — move grants are intentionally out of prune scope).
export function extractGrantPath(pattern: string): string | null {
  const idx = pattern.indexOf(GRANT_PATH_MARKER);
  if (idx < 0) return null;
  const tail = pattern.slice(idx + GRANT_PATH_MARKER.length);
  return tail.length > 0 ? tail : null;
}

// Every absolute path a grant pattern targets: the single `:path:` tail, or the `paths` list of a `<toolName>:{...,"paths":[...]}` key (`apply_patch`, whose one call can touch several files). Empty for any other pattern.
export function extractGrantPaths(pattern: string): string[] {
  const separator = pattern.indexOf(":");
  if (separator > 0 && pattern[separator + 1] === "{") {
    try {
      const parsed: unknown = JSON.parse(pattern.slice(separator + 1));
      const paths = typeof parsed === "object" && parsed !== null
        ? (parsed as { paths?: unknown }).paths
        : undefined;
      if (Array.isArray(paths) && paths.length > 0
        && paths.every((path) => typeof path === "string" && path.length > 0)) {
        return paths as string[];
      }
    } catch {
      // Not a JSON key; fall through to the single-path marker.
    }
  }
  const single = extractGrantPath(pattern);
  return single === null ? [] : [single];
}

// item-4 — decompose a pruned grant pattern into an auditable tuple. The tool-name is the prefix before GRANT_PATH_MARKER; the path is the tail (already validated non-null by the prune's `isUnderRoot` guard, but fall back to the whole pattern defensively). Only called on patterns that extractGrantPath returned non-null for.
function describePrunedGrant(pattern: string, tier: GrantTier | undefined): PrunedGrant {
  const idx = pattern.indexOf(GRANT_PATH_MARKER);
  const separator = pattern.indexOf(":");
  const toolName = idx > 0
    ? pattern.slice(0, idx)
    : separator > 0 && pattern[separator + 1] === "{" ? pattern.slice(0, separator) : pattern;
  const paths = extractGrantPaths(pattern);
  const path = paths.length > 0 ? paths.join(", ") : pattern;
  return { pattern, toolName, tier: normalizeTier(tier), path };
}

// Compare strict descendants without filesystem lookup; normalize separators and case defensively. Equal roots are excluded and separator boundaries prevent sibling-prefix matches.
export function isStrictPathDescendant(parent: string, child: string): boolean {
  const foldedParent = caseFoldForMatch(parent.replace(/\\/g, "/"));
  const foldedChild = caseFoldForMatch(child.replace(/\\/g, "/"));
  if (foldedChild === foldedParent) return false;
  const base = foldedParent.endsWith("/") ? foldedParent : `${foldedParent}/`;
  return foldedChild.startsWith(base);
}

// Graduated grant tier helpers
const TIER_RANK: Record<GrantTier, number> = { read: 0, write: 1 };

// Ordinal rank of a grant tier (read=0 < write=1).
export function tierRank(tier: GrantTier): number {
  return TIER_RANK[tier];
}

// The grant tier a category requires to be auto-allowed by a prior "Allow always" grant. `read` → read-tier; `write`/`shell`/`network`/`meta` → write-tier. `meta` deliberately requires write so that a read-tier grant cannot silently short-circuit a meta tool (e.g. agent_spawn). This is the single source of truth for the category→tier mapping; the executor imports it when stamping the tier onto a new grant so the grant-time tier and the check-time coverage predicate can never diverge.
export function requiredTier(category: ToolCategory): GrantTier {
  return category === "read" ? "read" : "write";
}

// Does a `granted` tier cover an invocation of `category`? A write grant covers every category; a read grant covers only read invocations.
export function grantCovers(granted: GrantTier, category: ToolCategory): boolean {
  return tierRank(granted) >= tierRank(requiredTier(category));
}

// External-boundary normalization for a persisted `tier` field. permissions.json is a user-editable file; an absent or corrupt `tier` denotes a legacy / untiered grant, which grandfathers to write-tier (most permissive — preserves the user's saved "Allow always"). Normalizing to read-tier instead would silently break saved grants (weakening) and is forbidden. This is the only sanctioned fallback in this module — it lives at the file boundary, not between internal callers.
export function normalizeTier(tier: unknown): GrantTier {
  return tier === "read" ? "read" : "write";
}

// Monotone merge — the higher-ranked of two tiers (undefined = take `b`).
function maxTier(a: GrantTier | undefined, b: GrantTier): GrantTier {
  if (a === undefined) return b;
  return tierRank(a) >= tierRank(b) ? a : b;
}

function normalizeApprovalCacheKey(key: string | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// DLP-mask a reviewer verdict's human-readable `reason`. Only the prose moves; `level` is the field every decision reads and is left exactly as the classifier produced it. Applied by {@link PermissionManager.dispatchReviewer} so no sink downstream — renderer event, sandbox audit, verdict cache — has to trust that a classifier (or a provider's error text) redacted its own output.
function redactVerdictReason(verdict: RiskVerdict): RiskVerdict {
  const masked = maskSensitiveData(verdict.reason).masked;
  return masked === verdict.reason ? verdict : { ...verdict, reason: masked };
}
