/**
 * Browser-safe contract for the Codex subscription connection.
 *
 * This deliberately represents connection state only. ChatGPT access and
 * refresh tokens stay inside the local Codex App Server credential store and
 * must never be added to Ave settings, IPC payloads, telemetry, or logs.
 */

export type CodexSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out";

export type CodexSubscriptionLoginMethod = "browser" | "device-code";

/**
 * The oldest `codex` CLI whose app-server accepts Ave's hardened launch
 * arguments and exposes every request, field and notification Ave uses.
 * Chosen by generating each published version's protocol schema and
 * starting it with Ave's argv; see `src/main/codex-user-runtime.ts`.
 */
export const CODEX_CLI_MINIMUM_VERSION = "0.152.0";

export interface CodexSubscriptionStatus {
  /**
   * `not-configured`: no `codex` CLI was found and none was chosen.
   * `unavailable`: one was found but it cannot run Ave's integration.
   */
  runtime: "ready" | "unavailable" | "not-configured";
  connection: CodexSubscriptionConnectionState;
  /** Present only for Codex-managed ChatGPT authentication. */
  planType: string | null;
  /** Present while a managed login is awaiting completion. */
  pendingLogin: CodexSubscriptionLoginMethod | null;
  /**
   * Short-lived device code retained only in the main-process session so the
   * settings view can recover after a tab change. It is never an auth token.
   */
  pendingDeviceCode: string | null;
  /** The resolved CLI's reported version, once it has been read. */
  version: string | null;
}

export type CodexSubscriptionErrorCode =
  | "codex-runtime-unavailable"
  | "codex-runtime-start-failed"
  | "codex-runtime-not-configured"
  | "codex-runtime-invalid-executable"
  | "codex-runtime-version-unsupported"
  | "codex-runtime-incompatible"
  | "codex-login-in-progress"
  | "codex-login-failed"
  | "codex-operation-failed";

export type CodexSubscriptionActionResult =
  | { ok: true; status: CodexSubscriptionStatus }
  | {
      ok: false;
      error: CodexSubscriptionErrorCode;
      status: CodexSubscriptionStatus;
    };

/** Device-code login deliberately returns the short-lived code, not its URL. */
export type CodexSubscriptionDeviceCodeResult =
  | {
      ok: true;
      status: CodexSubscriptionStatus;
      userCode: string;
    }
  | {
      ok: false;
      error: CodexSubscriptionErrorCode;
      status: CodexSubscriptionStatus;
    };

export interface CodexSubscriptionModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  inputModalities: string[];
}

export type CodexSubscriptionModelsResult =
  | {
      ok: true;
      status: CodexSubscriptionStatus;
      models: CodexSubscriptionModel[];
    }
  | {
      ok: false;
      error: CodexSubscriptionErrorCode;
      status: CodexSubscriptionStatus;
    };

export const CODEX_SUBSCRIPTION_SIGNED_OUT_STATUS: CodexSubscriptionStatus = {
  runtime: "ready",
  connection: "signed-out",
  planType: null,
  pendingLogin: null,
  pendingDeviceCode: null,
  version: null,
};
