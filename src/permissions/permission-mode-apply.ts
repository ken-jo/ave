import { randomUUID } from "node:crypto";
import type { AuditLogger } from "../audit/audit-logger.js";
import { t } from "../i18n/index.js";
import { isExternalOrigin, type ExternalOrigin, type TrustOrigin } from "../contract/trust-origin.js";
import type { ApprovalGate } from "./approval-gate.js";
import type { PermissionManager } from "./permission-manager.js";
import type { PermissionModeCommand } from "./permission-slash.js";
import type { ExecutionMode } from "../shared/permission-mode.js";

export type PermissionModeApplyResult =
  | {
      ok: true;
      previous: string;
      mode: PermissionModeCommand["mode"];
      durable: boolean;
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

export async function applyPermissionModeCommand(
  cmd: PermissionModeCommand,
  deps: {
    permissionManager: PermissionManager;
    approvalGate?: ApprovalGate;
    auditLogger?: Pick<AuditLogger, "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
    approvalBypass?: PermissionModeApprovalBypass;
  },
): Promise<PermissionModeApplyResult> {
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
      isReadOnly: false,
      mode: "default",
    });
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
      await deps.auditLogger.appendPermissionAuditEntry({
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

  if (cmd.durable) {
    await deps.permissionManager.setModePersist(cmd.mode);
  } else {
    deps.permissionManager.setMode(cmd.mode);
  }

  return {
    ok: true,
    previous,
    mode: cmd.mode,
    durable: cmd.durable,
  };
}
