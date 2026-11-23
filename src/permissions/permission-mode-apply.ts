import { admitToolInvocationWhileAuditOpen, appendToolInvocationAudit } from "../tools/invocation-ledger.js";
import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import { t } from "../i18n/index.js";
import { isExternalOrigin, type ExternalOrigin, type TrustOrigin } from "../contract/trust-origin.js";
import type { ApprovalGate } from "./approval-gate.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PermissionModeCommand } from "./permission-slash.js";
import type { ExecutionMode } from "../shared/permission-mode.js";
import { AveHomeConfigurationRefusedWriteError } from "../shared/ave-home.js";
import { HOME_FOLDER_REFUSED } from "../shared/permissions-events.js";
import { beginPermissionModeChangePersist, finishPermissionModeChangePersist, readPermissionSettings, setSessionReviewerSettings, type ReviewerMode } from "./permission-settings-store.js";
import { permissionsFilePath, updatePermissionsFile } from "./permissions-store.js";
import { readAveHomeInputSync } from "../shared/ave-home-trust.js";

const runtimeReviewerModes = new WeakMap<PermissionManager, ReviewerMode>();

/** Session-scoped mode changes must configure review without rewriting the durable preference. */
export function permissionModeReviewerOverride(manager: PermissionManager): ReviewerMode | undefined {
  return runtimeReviewerModes.get(manager);
}

/** An explicit reviewer selection supersedes the session mode's runtime preference. */
export function setPermissionModeReviewerOverride(manager: PermissionManager, mode: ReviewerMode | undefined): void {
  if (mode === undefined) runtimeReviewerModes.delete(manager);
  else runtimeReviewerModes.set(manager, mode);
}

export type PermissionModeApplyResult =
  | {
      ok: true;
      previous: string;
      mode: PermissionModeCommand["mode"];
      durable: boolean;
      // A durable switch that applied for this session only, because the home's permission store refuses writes while boot refuses the folder.
      notice?: typeof HOME_FOLDER_REFUSED;
    }
  | {
      ok: false;
      error: string;
      message: string;
    };

// Trusted local UI actions or a prior in-app gate click may satisfy explicit confirmation; all other source/origin combinations must ask. External confirmations stay session-scoped and cannot select allow; avoid a duplicate prompt without widening their authority.
export type PermissionModeApprovalBypass =
  | {
      source: "settings-ui" | "builtin-slash";
      trustOrigin: "user-keyboard";
      explicitUserAction: true;
    }
  | {
      source: "local-api-approval";
      // The external origin that initiated the (already user-approved) change.
      trustOrigin: ExternalOrigin;
      explicitUserAction: true;
    };

// The transport-agnostic (plain string / boolean) shape a caller may hand in. Never trusted as-is: resolvePermissionModeApprovalBypass is the only thing that turns it into a PermissionModeApprovalBypass.
export interface LoosePermissionModeApprovalBypass {
  source: string;
  trustOrigin: string;
  explicitUserAction: boolean;
}

// Recheck confirmation surface/origin at runtime despite the typed union; unrecognized combinations fall through to the normal approval ask.
export function resolvePermissionModeApprovalBypass(
  bypass: LoosePermissionModeApprovalBypass | PermissionModeApprovalBypass | undefined,
): PermissionModeApprovalBypass | undefined {
  if (!bypass || bypass.explicitUserAction !== true) return undefined;
  if (
    (bypass.source === "settings-ui" || bypass.source === "builtin-slash") &&
    bypass.trustOrigin === "user-keyboard"
  ) {
    return { source: bypass.source, trustOrigin: "user-keyboard", explicitUserAction: true };
  }
  if (bypass.source === "local-api-approval") {
    const origin = bypass.trustOrigin as TrustOrigin;
    if (isExternalOrigin(origin)) {
      return { source: "local-api-approval", trustOrigin: origin, explicitUserAction: true };
    }
  }
  return undefined;
}

// Is this resolved confirmation the EXTERNAL channel (local API / CLI / SDK) rather than a first-party renderer surface? The `source` discriminant on PermissionModeApprovalBypass is ALREADY the channel axis — `settings-ui` / `builtin-slash` are in-app surfaces the user drove directly, `local-api-approval` is an out-of-process caller whose change a human merely consented to once through the ApprovalGate dock. This predicate names that split so the ceiling below reads as policy rather than as a string comparison, and so no second "isExternal" flag has to be threaded through the transports.
export function isExternalApprovalBypass(
  bypass: PermissionModeApprovalBypass | undefined,
): bypass is Extract<PermissionModeApprovalBypass, { source: "local-api-approval" }> {
  return bypass?.source === "local-api-approval";
}

// Modes the EXTERNAL channel may never select. `allow` is the mode that removes tool prompting entirely, so setting it converts a single ApprovalGate click into blanket, open-ended authority over every later tool call. That is not what the human answered: the dock asks "change the permission mode", not "stop asking me about anything, forever". The in-app surfaces keep `allow` — a user standing in the permission settings choosing it IS the consent — but an out-of-process caller cannot reach it.
const EXTERNAL_CHANNEL_FORBIDDEN_MODES: readonly ExecutionMode[] = ["allow"];

interface PermissionModeApplyDeps {
    permissionManager: PermissionManager;
    approvalGate?: ApprovalGate;
    auditLogger?: Pick<AuditLogger, "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
    approvalBypass?: PermissionModeApprovalBypass;
    rewireReviewerAgent?: () => Promise<void>;
    reviewerSettingsPath?: string;
}

const modeChanges = new WeakMap<PermissionManager, Promise<void>>();

/** Serialize changes across windows and transports so mode and reviewer configuration cannot interleave. */
export async function applyPermissionModeCommand(
  cmd: PermissionModeCommand,
  deps: PermissionModeApplyDeps,
): Promise<PermissionModeApplyResult> {
  const preceding = modeChanges.get(deps.permissionManager) ?? Promise.resolve();
  let release!: () => void;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  const tail = preceding.then(() => completion);
  modeChanges.set(deps.permissionManager, tail);
  // A closed audit has no row left for the denial; refuse instead of admitting.
  const admission = admitToolInvocationWhileAuditOpen("/permission mode");
  await preceding;
  try {
    if (!admission) return hostShutdownCancelled();
    return await applyPermissionModeChange(cmd, deps, admission.signal);
  } finally {
    admission?.settle();
    release();
    if (modeChanges.get(deps.permissionManager) === tail) modeChanges.delete(deps.permissionManager);
  }
}

function hostShutdownCancelled() {
  return { ok: false as const, error: "host-shutdown", message: t("be_executor.toolExecutionCancelled") };
}

async function applyPermissionModeChange(
  cmd: PermissionModeCommand,
  deps: PermissionModeApplyDeps,
  signal: AbortSignal,
): Promise<PermissionModeApplyResult> {
  const cancelled = hostShutdownCancelled();
  if (signal.aborted) return cancelled;
  const previous = deps.permissionManager.getMode();

  // Skip duplicate confirmation only for a trusted keyboard UI action or a real prior gate allow at the external transport boundary; callers cannot assert consent without that observed decision.
  const trustedConfirmation = resolvePermissionModeApprovalBypass(deps.approvalBypass);

  // External consent authorizes only this session and never allow mode, even if a caller hand-builds a durable command. Enforce here as well as at transport; trusted local UI surfaces retain their separate authority.
  if (isExternalApprovalBypass(trustedConfirmation)) {
    if (EXTERNAL_CHANNEL_FORBIDDEN_MODES.includes(cmd.mode)) {
      return {
        ok: false,
        error: "external-mode-forbidden",
        message: t("be_permissionModeApply.externalModeForbidden", { mode: cmd.mode }),
      };
    }
    if (cmd.durable) {
      return {
        ok: false,
        error: "external-durable-forbidden",
        message: t("be_permissionModeApply.externalDurableForbidden"),
      };
    }
  }

  if (cmd.durable && !trustedConfirmation) {
    if (!deps.approvalGate) {
      return {
        ok: false,
        error: "approval-gate-unavailable",
        message: t("be_permissionModeApply.approvalGateUnavailable"),
      };
    }
    const decision = await deps.approvalGate.requestAndWait({
      id: randomUUID(),
      category: "tool",
      toolName: "/permission mode",
      toolCategory: "meta",
      args: { fromMode: previous, toMode: cmd.mode, durable: true },
      reason: t("be_permissionModeApply.approvalReason", { mode: cmd.mode }),
      source: "builtin",
      createdAt: Date.now(),
      trustOrigin: "user-keyboard",
      abortSignal: signal,
    });
    if (signal.aborted) return cancelled;
    // Any allow approves this switch; the card answers a conversation-scoped remembered allow with allow-session.
    if (decision.choice !== "allow-once" && decision.choice !== "allow-session" && decision.choice !== "allow-always") {
      return {
        ok: false,
        error: "durable-mode-denied",
        message: t("be_permissionModeApply.durableModeDenied"),
      };
    }
  }

  if (deps.auditLogger) {
    if (!deps.auditLogger.isPermissionAuditChainReady()) {
      return {
        ok: false,
        error: "permission-audit-not-ready",
        message: t("be_permissionModeApply.auditChainNotReady"),
      };
    }
    try {
      await appendToolInvocationAudit(deps.auditLogger, {
        decision: "mode_change",
        auditId: randomUUID(),
        ts: new Date().toISOString(),
        trustOrigin: "user-keyboard",
        fromMode: previous,
        toMode: cmd.mode,
        durable: cmd.durable,
        confirmationSource: trustedConfirmation?.source,
      });
    } catch (err) {
      return {
        ok: false,
        error: "permission-audit-write-failed",
        message: t("be_permissionModeApply.auditWriteFailed", { message: (err as Error).message }),
      };
    }
  }

  const { dispatchPermissionReviewerCommand } = await import("./permission-slash.js");
  const previousReviewer = await dispatchPermissionReviewerCommand(
    { verb: "show", value: "" }, deps.reviewerSettingsPath,
  );
  if (!previousReviewer.ok) {
    return { ok: false, error: "reviewer-mode-change-failed", message: "Reviewer settings could not be read" };
  }
  if (signal.aborted) {
    // The mode_change row is written; record that quit refused it before anything is applied.
    if (deps.auditLogger) {
      await appendToolInvocationAudit(deps.auditLogger, {
        decision: "deny",
        ts: new Date().toISOString(),
        auditId: randomUUID(),
        tool: "/permission mode",
        source: "builtin",
        category: "meta",
        // The host refused the change; the keyboard origin stays on the mode_change row.
        trustOrigin: "unknown",
        denyReasons: [{ reason: "host-shutdown", source: "permission-mode" }],
      }).catch(() => undefined);
    }
    return cancelled;
  }
  const previousOverride = runtimeReviewerModes.get(deps.permissionManager);
  const restoreOverride = () => {
    if (previousOverride === undefined) runtimeReviewerModes.delete(deps.permissionManager);
    else runtimeReviewerModes.set(deps.permissionManager, previousOverride);
  };
  const reviewerMode: ReviewerMode = cmd.mode === "auto" ? "llm" : "disabled";
  // The session pair: the reviewer as an in-memory override, the mode in memory only.
  const applyForSession = async (): Promise<PermissionModeApplyResult | null> => {
    runtimeReviewerModes.set(deps.permissionManager, reviewerMode);
    try {
      await deps.rewireReviewerAgent?.();
    } catch (error) {
      restoreOverride();
      await deps.rewireReviewerAgent?.();
      return { ok: false, error: "reviewer-mode-change-failed", message: (error as Error).message };
    }
    deps.permissionManager.setMode(cmd.mode);
    return null;
  };

  if (!cmd.durable) {
    return await applyForSession() ?? { ok: true, previous, mode: cmd.mode, durable: false };
  }

  const persisted = await persistModePair(cmd.mode, reviewerMode, previousReviewer.settings.mode, deps);
  if (typeof persisted === "object") {
    return { ok: false, error: "reviewer-mode-change-failed", message: persisted.settingsWriteFailed };
  }
  if (persisted === "settings-refused") {
    // The user chose this mode; only saving it is refused. The reviewer choice lives over the absent settings view for this run.
    setSessionReviewerSettings({ mode: reviewerMode }, deps.reviewerSettingsPath);
    runtimeReviewerModes.delete(deps.permissionManager);
    try {
      await deps.rewireReviewerAgent?.();
    } catch (error) {
      setSessionReviewerSettings({ mode: previousReviewer.settings.mode }, deps.reviewerSettingsPath);
      restoreOverride();
      await deps.rewireReviewerAgent?.();
      return { ok: false, error: "reviewer-mode-change-failed", message: (error as Error).message };
    }
    deps.permissionManager.setMode(cmd.mode);
    return { ok: true, previous, mode: cmd.mode, durable: false, notice: HOME_FOLDER_REFUSED };
  }
  if (persisted === "mode-refused") {
    return await applyForSession() ?? { ok: true, previous, mode: cmd.mode, durable: false, notice: HOME_FOLDER_REFUSED };
  }

  // Both stores hold the new pair and the manager publishes the mode; the reviewer follows from the stored settings.
  runtimeReviewerModes.delete(deps.permissionManager);
  try {
    await deps.rewireReviewerAgent?.();
  } catch (error) {
    const restored = await persistModePair(previous, previousReviewer.settings.mode, reviewerMode, deps);
    if (restored !== "saved") throw new Error("Reviewer reconfiguration failed and the previous permission mode could not be saved again", { cause: error });
    restoreOverride();
    await deps.rewireReviewerAgent?.();
    return { ok: false, error: "reviewer-mode-change-failed", message: (error as Error).message };
  }
  return { ok: true, previous, mode: cmd.mode, durable: true };
}

/**
 * Save the execution mode and its reviewer mode as one recoverable change: the reviewer mode and the intent first, in one
 * atomic settings write, then the mode file, then the intent is cleared. Boot finishes an intent a crash left behind, so the
 * two stores never disagree on disk. A refused mode file abandons the intent and restores the previous reviewer mode.
 */
async function persistModePair(
  executionMode: ExecutionMode,
  nextReviewerMode: ReviewerMode,
  previousReviewerMode: ReviewerMode,
  deps: PermissionModeApplyDeps,
): Promise<"saved" | "settings-refused" | "mode-refused" | { settingsWriteFailed: string }> {
  let operationId: string;
  try {
    operationId = await beginPermissionModeChangePersist({ executionMode, reviewerMode: nextReviewerMode }, deps.reviewerSettingsPath);
  } catch (error) {
    if (error instanceof AveHomeConfigurationRefusedWriteError) return "settings-refused";
    // Nothing was written, so the caller reports the refusal and both stores keep the previous pair.
    return { settingsWriteFailed: (error as Error).message };
  }
  try {
    await deps.permissionManager.setModePersist(executionMode);
  } catch (error) {
    try {
      await finishPermissionModeChangePersist(operationId, deps.reviewerSettingsPath, previousReviewerMode);
    } catch (restoreError) {
      throw new Error("Permission mode save failed and reviewer settings could not be restored", { cause: new AggregateError([error, restoreError]) });
    }
    if (error instanceof AveHomeConfigurationRefusedWriteError) return "mode-refused";
    throw error;
  }
  try {
    await finishPermissionModeChangePersist(operationId, deps.reviewerSettingsPath);
  } catch (error) {
    // Both stores hold the pair and the manager already runs the new mode, so the running reviewer must follow it; the kept
    // intent is finished again at the next boot.
    runtimeReviewerModes.delete(deps.permissionManager);
    await deps.rewireReviewerAgent?.();
    throw new Error("The permission mode was saved, but its change record could not be cleared", { cause: error });
  }
  return "saved";
}

/** Finish a durable mode change a crash interrupted, before anything reads the stored mode. */
export async function recoverInterruptedPermissionModeChange(paths: { permissionsFilePath?: string; reviewerSettingsPath?: string } = {}): Promise<void> {
  const pending = readPermissionSettings(paths.reviewerSettingsPath).permissions.pendingModeChange;
  if (pending === undefined) return;
  const modeFile = paths.permissionsFilePath ?? permissionsFilePath();
  // A mode file waiting for home content review cannot be written and reads as absent; the change is finished on the boot after its approval.
  if (readAveHomeInputSync(modeFile).status === "untrusted") return;
  await updatePermissionsFile(modeFile, (file) => { file.mode = pending.executionMode; });
  await finishPermissionModeChangePersist(pending.operationId, paths.reviewerSettingsPath);
}
