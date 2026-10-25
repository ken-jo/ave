/**
 * Tool pipeline — Store-B explicit-approval memory skip (foreground dock path).
 *
 * Extracted from `executor.ts` (C7 decomposition). Pure aside from the
 * user-approval store lookup + sandbox-audit sink it drives. Behaviour is locked
 * by `executor-approval-memory-skip*.test.ts`.
 *
 * Background — two approval stores, asymmetric reads (root cause of the
 * "I chose 'allow this session' but the prompt keeps reappearing" bug):
 *   • Store A — durable glob allow/deny rules + the `alwaysAllowed` Map,
 *     managed by PermissionsTab and consulted by the SYNC
 *     {@link PermissionManager.checkDetailed} (Layers 3 glob / 5 exact).
 *     Only the dialog's `allow-always` choice writes here
 *     (addAlwaysAllowedPersist).
 *   • Store B — exact-tuple user-approval memory written by
 *     ToolApprovalContent for DURABLE choices only (allow-session /
 *     allow-always — allow-once never records, so "this time" cannot
 *     widen into a remembered grant) via the
 *     `userApprovalRecord` IPC. Keyed on (toolName, source, trustOrigin?,
 *     working directory) plus EITHER the tool-declared approvalCacheKey (a
 *     complete consent identity, e.g. web_fetch's host) OR the canonical args.
 *
 * Pre-fix, the foreground ask path never read Store B — only the reviewer
 * lane ({@link PermissionManager.dispatchReviewer}) did. So a "session"
 * approval was recorded but never honored on re-entry through the foreground
 * dock path. This function mirrors the reviewer lane's lookup so a prior,
 * non-revoked session/persistent approval skips the prompt.
 *
 * The lookup args MUST match what ToolApprovalContent stored:
 * `canonicalStringify(finalInput)` (the dialog records
 * `canonicalStringify(request.args)` where `request.args === finalInput`).
 * The IPC handler re-canonicalizes the same way, so identity is stable.
 *
 * Verdict escalation guard: re-run the rule classifier and take
 * `maxVerdict(ruleVerdict, storedVerdict)`. If the fresh rule verdict now
 * EXCEEDS the stored verdict (args mutated into something more dangerous),
 * re-prompt instead of auto-allowing — same principle as the reviewer
 * lane's max() composition. A legacy entry with `verdictAtApproval == null`
 * (provenance lost) is rejected → re-prompt (mirrors the dispatchReviewer
 * fail-closed gate).
 *
 * @returns an `allow` {@link PermissionCheckResult} when the prompt should be
 *   skipped, or `null` to fall through to the approval dock.
 */
import type { ToolSource, ToolCategory } from "../types.js";
import type { PermissionCheckResult, PermissionManager } from "../../permissions/permission-manager.js";
import type { ToolInvocationContext } from "../../permissions/reviewer/risk-classifier.js";
import { RuleBasedRiskClassifier, maxVerdict } from "../../permissions/reviewer/risk-classifier.js";
import { resolveReviewerSandboxCapability } from "../../permissions/sandbox-capability.js";
import type { HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import {
  approvalCacheKeyIdentity,
  isExactArgsDecision,
  lookupApproval,
  canonicalStringify,
} from "../../permissions/user-approval-store.js";
import type { UserApprovalHitPayload, UserApprovalVerdict } from "../../shared/permissions-events.js";
import { buildSandboxAuditEntry } from "../../audit/sandbox-audit.js";
import { emitSandboxAudit } from "../../audit/sandbox-audit-sink.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type { ToolPermissionContext } from "../executor.js";

/**
 * The deterministic rule-classifier verdict for one invocation, built exactly
 * as the memory-skip escalation guard builds it. Issue #28 also attaches it to
 * every foreground approval request that has no reviewer verdict, so the dock
 * grades an unreviewed shell call by what it is (read-only → LOW, ordinary →
 * MEDIUM, destructive → HIGH) instead of a blanket HIGH.
 */
export function classifyApprovalRuleVerdict(input: {
  toolName: string;
  source: ToolSource;
  category: ToolCategory;
  pathFields: readonly string[];
  finalInput: Record<string, unknown>;
  executionCwd: string;
  allowedDirectories: string[];
  sensitivePathsAdjacent: string[];
  context: ToolPermissionContext;
  sandboxAttestation: { ownerPluginSandboxRoot?: string };
  mcpServerId?: string;
  workerId?: string;
  pluginId?: string;
  hostShellExecutionPlan?: HostShellExecutionPlan;
}): { ctx: ToolInvocationContext; verdict: ReturnType<RuleBasedRiskClassifier["classify"]> } {
  // Substrate-aware (NOT process-global): a plugin/MCP or in-process builtin
  // call resolves to a "none" capability so the audit + any sandbox-sensitive
  // rule reflect that this call's effects are NOT ASRT-isolated — except a
  // genuinely ASRT-wrapped external MCP worker (keyed on id)
  // or host-spawned plugin worker (keyed on pluginId + workerId).
  const sandboxCapability = resolveReviewerSandboxCapability(
    input.source,
    input.toolName,
    input.mcpServerId,
    input.workerId,
    input.pluginId,
    input.hostShellExecutionPlan,
    input.context.disposableSubstrate,
  );
  const ctx: ToolInvocationContext = {
    toolName: input.toolName,
    source: input.source,
    category: input.category,
    pathFields: input.pathFields,
    trustOrigin: input.context.trustOrigin,
    finalInput: input.finalInput,
    executionCwd: input.executionCwd,
    allowedDirectories: input.allowedDirectories,
    sensitivePathsAdjacent: input.sensitivePathsAdjacent,
    sandboxCapability,
    ...(input.context.userIntent ? { conversationContext: { recentUserMessage: input.context.userIntent } } : {}),
    ...(input.sandboxAttestation.ownerPluginSandboxRoot !== undefined
      ? { ownerPluginSandboxRoot: input.sandboxAttestation.ownerPluginSandboxRoot }
      : {}),
  };
  return { ctx, verdict: new RuleBasedRiskClassifier().classify(ctx) };
}

export async function tryUserApprovalMemorySkip(
  toolName: string,
  source: ToolSource,
  category: ToolCategory,
  pathFields: readonly string[],
  finalInput: Record<string, unknown>,
  /**
   * Invocation cwd — threaded so the escalation guard's rule classifier
   * resolves path arguments exactly as Layer 1 does. Positional (not optional)
   * so the compiler catches a caller that forgets it.
   */
  executionCwd: string,
  allowedDirectories: string[],
  sensitivePathsAdjacent: string[],
  context: ToolPermissionContext,
  approvalCacheKey: string | undefined,
  sandboxAttestation: { ownerPluginSandboxRoot?: string },
  mcpServerId?: string,
  workerId?: string,
  pluginId?: string,
  hostShellExecutionPlan?: HostShellExecutionPlan,
  auditInput?: Record<string, unknown>,
  sessionId?: string,
  /**
   * Disclosure sink — `PermissionManager.discloseUserApprovalHit`, bound by
   * `ToolExecutor` from the PermissionManager it already holds. Optional
   * because direct/unit callers may run without a PermissionManager; when it
   * IS wired, a foreground memory skip announces itself exactly like the
   * reviewer lane's.
   */
  disclose?: (payload: UserApprovalHitPayload) => void,
  /**
   * Full reviewer (rule + LLM lane) for a target-wide hit on arguments the
   * user never saw — `PermissionManager.dispatchReviewer`, bound by
   * `ToolExecutor`. Without it such a hit cannot be reviewed and re-prompts.
   */
  dispatchFreshReview?: PermissionManager["dispatchReviewer"],
): Promise<PermissionCheckResult | null> {
  // Identity = exactly what the record IPC stored: the tool's opted-in
  // target-wide memory key, otherwise the canonical finalInput.
  // Built outside the storage catch: a policy key without its memory mode is
  // an internal contract violation, not a storage failure.
  const canonicalArgs = canonicalStringify(finalInput);
  const identity = approvalCacheKeyIdentity(approvalCacheKey, context.approvalMemory);
  if (hostShellExecutionPlan?.mode === "plain") return null;
  const approval = await lookupApproval(
    toolName,
    canonicalArgs,
    source,
    context.trustOrigin,
    identity,
    executionCwd,
    sessionId,
  ).catch(() => null); // storage failure must never block tool execution

  // No active (non-revoked) approval → fall through to the approval dock.
  if (!approval) return null;

  // Legacy-null guard: an entry without a recorded verdict has lost its
  // provenance. Treat as a miss and re-prompt (fail-closed) — mirrors the
  // dispatchReviewer gate. A null can never be silently coerced to a level.
  if (approval.verdictAtApproval == null) {
    console.warn(
      `[permission] foreground memory skip — legacy entry without verdictAtApproval, forcing fresh approval (tool=${toolName}, scope=${approval.scope})`,
      { event: "legacy-null-verdict", toolName, scope: approval.scope },
    );
    return null;
  }

  // Verdict escalation guard. Re-run the deterministic rule classifier on
  // the CURRENT args; if it now ranks higher than the stored verdict, the
  // invocation became more dangerous since approval — re-prompt.
  // Substrate-aware (NOT process-global): a plugin/MCP or in-process builtin
  // call resolves to a "none" capability so the audit + any sandbox-sensitive
  // rule reflect that this call's effects are NOT ASRT-isolated — except a
  // genuinely ASRT-wrapped external MCP worker (keyed on id)
  // or host-spawned plugin worker (keyed on pluginId + workerId).
  const { ctx, verdict: ruleVerdict } = classifyApprovalRuleVerdict({
    toolName, source, category, pathFields, finalInput, executionCwd, allowedDirectories,
    sensitivePathsAdjacent, context, sandboxAttestation, mcpServerId, workerId, pluginId, hostShellExecutionPlan,
  });
  const storedLevel: UserApprovalVerdict = approval.riskCeilingAtApproval ?? approval.verdictAtApproval;
  const storedVerdict = { level: storedLevel, reason: "stored approval verdict at approval time" };
  const composed = maxVerdict(ruleVerdict, storedVerdict);
  if (composed.level !== storedLevel) {
    // Fresh rule verdict exceeded the stored one → escalation, re-prompt.
    console.warn(
      `[permission] foreground memory skip — fresh rule verdict (${ruleVerdict.level}) exceeds stored (${storedLevel}), forcing fresh approval (tool=${toolName})`,
      { event: "memory-skip-escalation", toolName, ruleVerdict: ruleVerdict.level, storedLevel },
    );
    return null;
  }

  // A target-wide hit on arguments other than the ones the user approved is
  // reviewed exactly like a fresh request — risk screen and LLM reviewer lane.
  // The remembered grant then only stands in for the prompt when that fresh,
  // actually-assessed verdict is no riskier than the stored one. An exact-args
  // hit keeps the rule-only guard above.
  let freshReviewLevel: UserApprovalVerdict | null = null;
  if (!isExactArgsDecision(approval, canonicalArgs)) {
    if (!dispatchFreshReview) return null;
    const reviewed = await dispatchFreshReview(
      toolName,
      {
        ...(sessionId === undefined ? {} : { sessionId }),
        source,
        category,
        pathFields,
        finalInput,
        executionCwd,
        ...(auditInput === undefined ? {} : { auditInput }),
        allowedDirectories,
        sensitivePathsAdjacent,
        trustOrigin: context.trustOrigin,
        ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
        ...(approvalCacheKey ? { approvalCacheKey } : {}),
        ...(context.approvalMemory ? { approvalMemory: context.approvalMemory } : {}),
        ...(sandboxAttestation.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: sandboxAttestation.ownerPluginSandboxRoot }
          : {}),
        ...(mcpServerId !== undefined ? { mcpServerId } : {}),
        ...(pluginId !== undefined ? { pluginId } : {}),
        ...(workerId !== undefined ? { workerId } : {}),
        ...(hostShellExecutionPlan === undefined ? {} : { hostShellExecutionPlan }),
        ...(context.disposableSubstrate === undefined ? {} : { disposableSubstrate: context.disposableSubstrate }),
      },
      {
        allowedPluginIds: context.allowedPluginIds ? [...context.allowedPluginIds] : undefined,
        additionalDirectories: context.additionalDirectories ?? [],
      },
      // This assesses whether the saved user grant covers these arguments.
      // The configured judge runs only after applicable grants are resolved.
      { defer: "none", judgeBypass: true },
    ).catch(() => null);
    const assessed = reviewed !== null &&
      (reviewed.outcome === "fresh" || reviewed.outcome === "cache" || reviewed.outcome === "host-determined") &&
      reviewed.verdict.requiresExplicitApproval !== true;
    // No reviewer configured: the deterministic rules (egress screen
    // included) are the whole assessment, now and at approval time. Reuse
    // only a row that was itself approved on rules alone — the gate records
    // `riskCeilingAtApproval` exactly then — and only when the fresh rule
    // verdict, already checked against that ceiling above, did not rise. A
    // row approved under a reviewer cannot be re-checked to the same standard
    // without one, so it asks.
    const rulesOnlyReuse = reviewed?.outcome === "unavailable" &&
      approval.riskCeilingAtApproval !== undefined &&
      maxVerdict(ruleVerdict, storedVerdict).level === storedLevel;
    if (!rulesOnlyReuse && (!assessed || maxVerdict(reviewed.verdict, storedVerdict).level !== storedLevel)) {
      console.warn(
        `[permission] foreground memory skip — target-wide hit on new arguments did not pass fresh review (${reviewed?.outcome ?? "failed"}:${reviewed?.verdict.level ?? "none"} vs stored ${storedLevel}), forcing fresh approval (tool=${toolName})`,
        { event: "memory-skip-target-review-escalation", toolName, outcome: reviewed?.outcome ?? null, freshLevel: reviewed?.verdict.level ?? null, storedLevel },
      );
      return null;
    }
    freshReviewLevel = rulesOnlyReuse ? null : reviewed!.verdict.level;
  }

  // Memory hit — skip the approval dock. Emit an audit entry recording the skip so
  // forensics can see the auto-allow + its provenance. Swallow-on-failure:
  // an audit write must never block tool execution.
  try {
    const auditEntry = buildSandboxAuditEntry({
      tool: {
        name: toolName,
        // emitSandboxAudit's sink trusts callers to pass DLP-redacted
        // fields (sandbox-audit-sink.ts DLP note) — mask before writing.
        args: maskSensitiveData(
          JSON.stringify(auditInput ?? finalInput),
        ).masked,
        source,
        trustOrigin: context.trustOrigin,
        ...(approvalCacheKey ? { approvalCacheKey } : {}),
      },
      sandbox: {
        kind: ctx.sandboxCapability.kind,
        confidence: ctx.sandboxCapability.confidence,
        // No sandbox run — this is a memory skip (the tool has not executed
        // yet). The zero telemetry below reflects "not measured", not "0ms".
        events: [],
        spawnLatencyMs: 0,
        overheadPercent: 0,
      },
      reviewer: {
        // ruleVerdict is the fresh deterministic classification of the
        // current args; finalVerdict is the composed max(rule, stored).
        ruleVerdict: ruleVerdict.level,
        // Exact hits make no LLM call — record null rather than a composed
        // level so the audit does not imply the classifier ran. A
        // target-wide hit records the fresh review it passed.
        llmVerdict: freshReviewLevel,
        finalVerdict: composed.level,
        compositionRulesTriggered: [],
        userApprovalUsed: {
          memoryHit: true,
          // Stored justification is user/LLM-authored free text — DLP-mask
          // it like every other audit field (the sink does not re-redact).
          nlJustification:
            approval.nlJustification === null
              ? null
              : maskSensitiveData(approval.nlJustification).masked,
          verdictAtApproval: approval.verdictAtApproval,
        },
      },
    });
    emitSandboxAudit(auditEntry).catch(() => {
      // intentionally swallowed — audit failure must not block execution
    });
  } catch {
    // building the audit entry must never block tool execution
  }

  // Disclosure. This lane used to end at a bare `console.info`, so a
  // foreground memory auto-approve was invisible in the UI while the reviewer
  // lane's identical decision raised a toast. Both lanes now go through
  // `PermissionManager.discloseUserApprovalHit`, the single producer — this
  // does NOT get its own broadcast, or the two would drift apart again.
  disclose?.({
    toolName,
    scope: approval.scope,
    verdictAtApproval: approval.verdictAtApproval,
  });
  return {
    decision: "allow",
    reason: `prior user approval (scope=${approval.scope})`,
    layer: 5,
  };
}
