/** Timeouts are milliseconds internally; convert only model-facing shell and terminal waits to whole seconds. Local shell budgets may grow on retry, broker budgets remain capability-bounded, and executor cancellation must stop underlying work. */
import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "./subagent-policy.js";

/** Clamp timer delays to signed 32-bit range; larger setTimeout delays overflow to approximately immediate expiry instead of a longer deadline. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveShellTimeoutMs(timeoutSeconds: number): number {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Shell timeout must be a positive finite number");
  }
  return Math.min(MAX_TIMER_DELAY_MS - TOOL_TIMEOUT_POLICY.shellCeilingGraceMs, Math.ceil(timeoutSeconds * 1000));
}

export const TOOL_TIMEOUT_POLICY = {
  shellDefaultMs: 120_000,
  // Reserve host-owned handshake, receipt, cleanup, and outer-timer headroom beyond semantic shell time on every route.
  shellCeilingGraceMs: 31_000,
  globalCeilingMs: 120_000,
  // A fresh local identity probe bounds synchronous remote authority checks.
  tailnetIdentityProbeMs: 5_000,
  // Cold native startup includes module loading, compilation and account-provider initialization before READY.
  windowsAclHostStartupMs: 120_000,
  // Bound each serial native-location ACL check so a stalled host releases queued admissions before the global ceiling.
  windowsAclRequestMs: 15_000,
  // Bound policy delivery even when the container launcher never connects.
  mxcRequestTransportMs: 15_000,
  // Exact installed extension runtime/request readiness must settle before a holder is admitted.
  mxcExtensionReadinessMs: 30_000,
  // Share the exact workload-identity handshake budget with the protocol.
  workloadBrokerPreEffectHandshakeMs: 15_000,
  // Receipt transport grace does not extend the operation deadline.
  workloadBrokerTransportGraceMs: 15_000,
  // Canonical-file semantic time excludes additive handshake and receipt phases.
  workloadBrokerFileOperationMs: 105_000,
  // Background cleanup adds handshake and receipt phases to descendant-drain time.
  workloadBrokerBackgroundCleanupEffectMs: 5_000,
  // The executor timer must strictly outlast the complete broker phase budget.
  workloadBrokerOuterGuardMs: 1_000,
  // Includes admission, source reading and decoder process lifetime.
  imagePreparationMs: 30_000,
  // A panel request must be acknowledged by its originating visible renderer.
  documentPanelAckMs: 10_000,
  // Optional document engine download, provenance checks and bounded native conversion.
  documentEngineInstallMs: 900_000,
  documentEngineVerificationMs: 120_000,
  documentEngineDownloadStallMs: 30_000,
  documentEngineStartupMs: 30_000,
  documentEngineConversionMs: 60_000,
  documentEngineShutdownMs: 10_000,
  // A forwarding client exits after the resident prints its receipt; this bounds delivery of that already-written line.
  documentEngineReceiptMs: 2_000,
  // terminal_run wait expiry returns a running block without stopping the command; keep the wait below executor ceiling and expose whole seconds.
  terminalRunWaitDefaultMs: 15_000,
  terminalRunWaitMaxMs: 100_000,
  pluginImportMs: 10_000,
  pluginFactoryMs: 10_000,
  pluginStartupDefaultMs: 10_000,
  pluginStartupMaxMs: 60_000,
  // Shutdown handlers may time out without blocking quit; worker transport gets kill grace beyond that timeout.
  pluginShutdownHandlerMs: 5_000,
  // Kill grace ensures the shutdown runner timeout wins over the transport deadline.
  pluginShutdownKillGraceMs: 1_000,
  // UI-resource hooks run on the render path with a tighter deadline than tools; expiry yields no card.
  pluginUiResourceReadMs: 10_000,
  // A small subagent round budget still receives the wall-clock floor.
  subAgentCeilingFloorMs: 600_000,
  // Scale subagent wall clock by the per-round allowance, preserving the floor at the default budget.
  subAgentPerRoundAllowanceMs: 10_000,
  // hostFetch bounds each hop to response headers; the caller owns body consumption so large downloads are not mistaken for hangs.
  pluginFetchResponseCeilingMs: 60_000,
  mcpRequestDefaultMs: 60_000,
  mcpRequestMaxMs: 120_000,
  networkFetchDefaultMs: 15_000,
  // Marketplace health checks and catalog fetches share this deadline.
  marketplaceHttpTimeoutMs: 15_000,
  // Reviewer HTTP transport deadlines are separate from model-work budgets.
  reviewerHttpTimeoutMs: 15_000,
  // Provider header and streaming-idle waits share this budget; generation-only gateways may legitimately stay silent beyond page-fetch deadlines.
  modelStreamIdleCeilingMs: 300_000,
  // Permission-rationale model work is separate from normal tool execution and interactive user waits.
  rationaleGenerationMs: 15_000,
  rationaleScopeReviewMs: 15_000,
  approvalGateUserWaitMs: 5 * 60 * 1000,
  // On shutdown-cleanup expiry, kill tracked children and exit; AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS may override.
  // Shutdown must outlast background broker cleanup; an exhausted reserve leaves cleanup unproven and external workload release authoritative.
  shutdownCleanupMs: 60_000,
  // Bounded POSIX child-list lookup during process tree termination.
  processTreeKillMs: 1_000,
  // Allow loaded Windows hosts enough time to enumerate and terminate process trees.
  windowsProcessTreeKillMs: 10_000,
  // Outlast the pinned PTY dependency's five-second console lookup and allow exit cleanup.
  windowsPtyShutdownMs: 6_000,
  // Emergency sweeps share one budget sized for a slow tree pass.
  windowsEmergencyProcessSweepMs: 10_000,
  // Give an ACP prompt cancellation time to acknowledge before closing transport.
  acpAbortGraceMs: 1_000,
  // Unreferenced polling retains detached groups until absence is observed.
  processGroupPollMs: 1_000,
  // Warn on surviving groups without expiring cancellation or shutdown ownership.
  processGroupRetentionWarningMs: 5 * 60 * 1000,
} as const;

/** Broker wall clock adds handshake, terminal receipt, and post-effect host work to semantic effect time. */
export function resolveWorkloadBrokerInvocationBudgetMs(
  effectMs: number,
  postEffectMs = 0,
): number {
  if (!Number.isFinite(effectMs) || effectMs <= 0
      || !Number.isFinite(postEffectMs) || postEffectMs < 0) {
    throw new Error("Workload broker phase budgets must be finite and non-negative");
  }
  return TOOL_TIMEOUT_POLICY.workloadBrokerPreEffectHandshakeMs
    + effectMs
    + TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs
    + postEffectMs;
}

/** Executor ceiling that strictly contains every broker phase. */
export function resolveWorkloadBrokerExecutorCeilingMs(
  effectMs: number,
  postEffectMs = 0,
): number {
  return Math.min(
    MAX_TIMER_DELAY_MS,
    resolveWorkloadBrokerInvocationBudgetMs(effectMs, postEffectMs)
      + TOOL_TIMEOUT_POLICY.workloadBrokerOuterGuardMs,
  );
}

/** Unusable shutdown values fall through to the next source, never disable deadlines; clamp oversized values to the timer range. */
export function normalizeShutdownCleanupTimeoutMs(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), MAX_TIMER_DELAY_MS);
}

/** Scale subagent ceiling with its actual host-assigned round budget and enforce a finite floor. */
export function resolveSubAgentCeilingMs(configuredRounds: number): number {
  const rounds = Number.isFinite(configuredRounds) ? Math.floor(configuredRounds) : 0;
  return Math.max(
    TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
    rounds * TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs,
  );
}

// Whole-second shell defaults must remain divisible by 1000 or the integer schema rejects its own default.
for (const key of ["shellDefaultMs", "terminalRunWaitDefaultMs", "terminalRunWaitMaxMs"] as const) {
  if (TOOL_TIMEOUT_POLICY[key] % 1000 !== 0) {
    throw new Error(
      `TOOL_TIMEOUT_POLICY.${key} (${TOOL_TIMEOUT_POLICY[key]}) must be divisible by 1000 — ` +
        "the bash/powershell and terminal_run schemas do `/ 1000` to expose seconds to the model, " +
        "and a non-divisible ms value yields a fractional default the integer schema rejects.",
    );
  }
}
if (TOOL_TIMEOUT_POLICY.terminalRunWaitMaxMs >= TOOL_TIMEOUT_POLICY.globalCeilingMs) {
  throw new Error("TOOL_TIMEOUT_POLICY.terminalRunWaitMaxMs must stay below globalCeilingMs");
}

// Pin the per-round allowance to the default budget/ceiling ratio so retuning cannot silently break their agreement.
if (
  TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs * SUBAGENT_MAX_ROUNDS_DEFAULT
  !== TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs
) {
  throw new Error(
    "TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs "
      + `(${TOOL_TIMEOUT_POLICY.subAgentPerRoundAllowanceMs}) × SUBAGENT_MAX_ROUNDS_DEFAULT `
      + `(${SUBAGENT_MAX_ROUNDS_DEFAULT}) must equal subAgentCeilingFloorMs `
      + `(${TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs}) — the per-round allowance is derived `
      + "from that pair, so the scaled ceiling must agree with the floor at the default budget.",
  );
}

if (
  resolveWorkloadBrokerExecutorCeilingMs(
    TOOL_TIMEOUT_POLICY.workloadBrokerBackgroundCleanupEffectMs,
  ) >= TOOL_TIMEOUT_POLICY.shutdownCleanupMs
) {
  throw new Error(
    "The default shutdown window must strictly contain a complete broker background cleanup request.",
  );
}

if (resolveWorkloadBrokerInvocationBudgetMs(
  TOOL_TIMEOUT_POLICY.workloadBrokerFileOperationMs,
) <= TOOL_TIMEOUT_POLICY.globalCeilingMs) {
  throw new Error(
    "The workload broker invocation budget must include protocol phases outside the global effect ceiling.",
  );
}

if (
  TOOL_TIMEOUT_POLICY.workloadBrokerPreEffectHandshakeMs
    + TOOL_TIMEOUT_POLICY.workloadBrokerTransportGraceMs
    + TOOL_TIMEOUT_POLICY.workloadBrokerOuterGuardMs
  !== TOOL_TIMEOUT_POLICY.shellCeilingGraceMs
) {
  throw new Error(
    "The shell ceiling grace must equal all host-owned broker phases plus the outer guard.",
  );
}
