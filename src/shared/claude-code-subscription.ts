/** Credentials stay in the CLI home; never project paths, auth URLs, or raw output. Chat still requires host safety verification and tool gates. */

export const CLAUDE_CODE_SUBSCRIPTION_PROVIDER_ID = "claude-code" as const;

/**
 * The oldest Claude Code release Ave admits. 2.1.89 is the first release whose Linux manifest carries Anthropic's detached signature, so it is the first
 * Ave can authenticate on every supported platform; it also accepts every flag Ave passes (the newest, `--bare`, arrived in 2.1.81). Any signed release
 * at or above it is accepted, including one older than the user's previous install.
 */
export const CLAUDE_CODE_CLI_MINIMUM_VERSION = "2.1.89";

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
  /** Signed Linux release metadata could not be fetched from the release origin; nothing about the binary was decided. */
  | "claude-code-runtime-release-metadata-unavailable"
  /** An authenticated release older than {@link CLAUDE_CODE_CLI_MINIMUM_VERSION}. */
  | "claude-code-runtime-version-unsupported"
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
