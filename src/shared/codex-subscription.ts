/** Connection state only; runtime-managed tokens must never enter app settings, IPC, telemetry, or logs. */

export type CodexSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out";

export type CodexSubscriptionLoginMethod = "browser" | "device-code";

/** Minimum CLI version must support the hardened launch arguments and protocol fields used by main/codex-user-runtime.ts. */
export const CODEX_CLI_MINIMUM_VERSION = "0.152.0";

export interface CodexSubscriptionStatus {
  /** Not configured means no executable selected; unavailable means the integration cannot run. */
  runtime: "ready" | "unavailable" | "not-configured";
  connection: CodexSubscriptionConnectionState;
  /** Present only for Codex-managed ChatGPT authentication. */
  planType: string | null;
  pendingLogin: CodexSubscriptionLoginMethod | null;
  /** Device codes are short-lived main-session state, never authentication tokens. */
  pendingDeviceCode: string | null;
  version: string | null;
}

export type CodexSubscriptionErrorCode =
  | "codex-runtime-unavailable"
  | "codex-runtime-start-failed"
  | "codex-runtime-not-configured"
  | "codex-runtime-invalid-executable"
  | "codex-runtime-unsafe-location"
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
