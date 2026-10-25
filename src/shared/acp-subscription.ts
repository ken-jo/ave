/** Runtime credentials stay private; chat use still requires the host tool-approval and audit bridge. */

import { isRecord } from "./is-record.js";

export const ACP_SUBSCRIPTION_PROVIDER_IDS = ["kimi-code", "grok-build"] as const;

export type AcpSubscriptionProviderId = (typeof ACP_SUBSCRIPTION_PROVIDER_IDS)[number];

export function isAcpSubscriptionProviderId(value: unknown): value is AcpSubscriptionProviderId {
  return typeof value === "string" && (ACP_SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(value);
}

export type AcpSubscriptionRuntimeState =
  | "not-configured"
  | "unverified"
  | "ready"
  | "unavailable";

export type AcpSubscriptionConnectionState =
  | "connected"
  | "pending"
  | "signed-out"
  | "unknown";

export type AcpSubscriptionLoginMethod = "device-code";

/** Only explicitly negotiated prompt variants are enabled; missing or malformed values are false. */
export interface AcpSubscriptionPromptCapabilities {
  readonly image: boolean;
  readonly embeddedContext: boolean;
}

export const DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES: AcpSubscriptionPromptCapabilities = Object.freeze({
  image: false,
  embeddedContext: false,
});

export function acpSubscriptionPromptCapabilitiesFromInitialize(
  initialize: unknown,
): AcpSubscriptionPromptCapabilities {
  const root = isRecord(initialize) ? initialize : null;
  const agentCapabilities = root && isRecord(root.agentCapabilities) ? root.agentCapabilities : null;
  const promptCapabilities = agentCapabilities && isRecord(agentCapabilities.promptCapabilities)
    ? agentCapabilities.promptCapabilities
    : null;
  if (!promptCapabilities) return DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES;
  return Object.freeze({
    image: promptCapabilities.image === true,
    embeddedContext: promptCapabilities.embeddedContext === true,
  });
}

export interface AcpSubscriptionStatus {
  provider: AcpSubscriptionProviderId;
  /** Whether a user-approved executable is configured and has been verified. */
  runtime: AcpSubscriptionRuntimeState;
  /** Runtime-owned subscription state; no credential material is projected. */
  connection: AcpSubscriptionConnectionState;
  pendingLogin: AcpSubscriptionLoginMethod | null;
  /** Short-lived device codes are never persisted and clear when login exits. */
  pendingDeviceCode: string | null;
  /** Verification URLs stay in main; renderer may only request opening an allow-listed URL. */
  canOpenVerificationUrl: boolean;
  /** A bounded version string only after an explicit user-initiated verification. */
  version: string | null;
  promptCapabilities: AcpSubscriptionPromptCapabilities;
}

export type AcpSubscriptionErrorCode =
  | "acp-provider-not-supported"
  | "acp-runtime-not-configured"
  | "acp-runtime-invalid-executable"
  | "acp-runtime-unavailable"
  | "acp-login-in-progress"
  | "acp-login-failed"
  | "acp-verification-url-unavailable"
  | "acp-logout-not-supported"
  | "acp-operation-failed";

export type AcpSubscriptionActionResult =
  | { ok: true; status: AcpSubscriptionStatus }
  | { ok: false; error: AcpSubscriptionErrorCode; status?: AcpSubscriptionStatus };

export function acpSubscriptionStatus(
  provider: AcpSubscriptionProviderId,
  runtime: AcpSubscriptionRuntimeState,
  connection: AcpSubscriptionConnectionState,
  version: string | null = null,
  pendingLogin: AcpSubscriptionLoginMethod | null = null,
  pendingDeviceCode: string | null = null,
  canOpenVerificationUrl = false,
  promptCapabilities: AcpSubscriptionPromptCapabilities = DEFAULT_ACP_SUBSCRIPTION_PROMPT_CAPABILITIES,
): AcpSubscriptionStatus {
  return {
    provider,
    runtime,
    connection,
    pendingLogin,
    pendingDeviceCode,
    canOpenVerificationUrl,
    version,
  promptCapabilities,
  };
}
