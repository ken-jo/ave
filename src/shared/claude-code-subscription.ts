/** Credentials stay in the CLI home; never project paths, auth URLs, or raw output. Chat still requires host safety verification and tool gates. */

export const CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID = "claude-code" as const;

export type ClaudeCodeSubscriptionProviderId = typeof CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;

export function isClaudeCodeSubscriptionProviderId(
  value: unknown,
): value is ClaudeCodeSubscriptionProviderId {
  return value === CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID;
}

export type ClaudeCodeSubscriptionRuntimeState =
  | "not-configured"
  | "unverified"
  | "ready"
  | "unavailable";

export type ClaudeCodeSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out"
  | "unknown";

export type ClaudeCodeSubscriptionLoginMethod = "browser";

export interface ClaudeCodeSubscriptionStatus {
  provider: ClaudeCodeSubscriptionProviderId;
  runtime: ClaudeCodeSubscriptionRuntimeState;
  connection: ClaudeCodeSubscriptionConnectionState;
  pendingLogin: ClaudeCodeSubscriptionLoginMethod | null;
  version: string | null;
}

export type ClaudeCodeSubscriptionErrorCode =
  | "claude-code-runtime-not-configured"
  | "claude-code-runtime-invalid-executable"
  | "claude-code-runtime-unsafe-location"
  | "claude-code-runtime-native-required"
  | "claude-code-runtime-unauthenticated"
  /** A discovered executable failed runtime identity or authentication-command qualification. */
  | "claude-code-runtime-incompatible"
  /** The executable content proof changed or has not passed connected print verification. */
  | "claude-code-runtime-unverified"
  | "claude-code-runtime-unavailable"
  | "claude-code-login-in-progress"
  | "claude-code-login-failed"
  | "claude-code-operation-failed";

export function claudeCodeSubscriptionStatus(
  runtime: ClaudeCodeSubscriptionRuntimeState,
  connection: ClaudeCodeSubscriptionConnectionState,
  version: string | null = null,
  pendingLogin: ClaudeCodeSubscriptionLoginMethod | null = null,
): ClaudeCodeSubscriptionStatus {
  return {
    provider: CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID,
    runtime,
    connection,
    pendingLogin,
    version,
  };
}
