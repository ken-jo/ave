/**
 * Browser-safe contract for the ChatGPT plan connection: the stable error
 * codes a plan-usage request can end in.
 * Tokens, the host id and raw provider bodies never cross this boundary.
 */

/**
 * Renderer-safe outcomes of a plan-usage inference request. Each maps one
 * documented provider condition to the recovery the user can take.
 */
type ChatGptPlanErrorCode =
  /** The account, workspace or policy cannot use its plan here. Do not retry. */
  | "chatgpt-plan-not-eligible"
  /** Plan usage is paused for this app or plan; review it in ChatGPT settings. */
  | "chatgpt-plan-usage-limit"
  /** Usage or account information was temporarily unavailable; retry later. */
  | "chatgpt-plan-temporarily-unavailable"
  /** The request used an input, tool or option plan usage does not accept. */
  | "chatgpt-plan-unsupported-capability"
  /** The signed permission did not authorize this request. */
  | "chatgpt-plan-permission-denied"
  /** The session was revoked or can no longer be refreshed; sign in again. */
  | "chatgpt-plan-reconnect-required"
  /** The selected model is not in this account's current model list. */
  | "chatgpt-plan-model-unavailable"
  /** Any other failure; the request id is kept in diagnostics. */
  | "chatgpt-plan-request-failed";

export interface ChatGptPlanErrorClassification {
  readonly code: ChatGptPlanErrorCode;
  /** Whether a bounded retry of the same request may succeed. */
  readonly retryable: boolean;
  /**
   * The subscriber context was not accepted. Sign-in is asked for only once a
   * refresh confirms the session is unusable, never on this response alone.
   */
  readonly confirmSession?: true;
}

/**
 * Classify a plan-usage failure from the HTTP status and, when the provider
 * returned its structured error object, the exact `error.code`. A pre-stream
 * admission body (`{"detail": ...}`) carries no stable code, so those are
 * classified by status alone.
 */
export function classifyChatGptPlanError(input: {
  readonly status?: number;
  readonly code?: string;
}): ChatGptPlanErrorClassification {
  switch (input.code) {
    case "subscription_sharing_user_not_eligible":
      return { code: "chatgpt-plan-not-eligible", retryable: false };
    case "subscription_sharing_usage_limit_exceeded":
      return { code: "chatgpt-plan-usage-limit", retryable: false };
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return { code: "chatgpt-plan-temporarily-unavailable", retryable: true };
    case "subscription_sharing_unsupported_capability":
    case "subscription_sharing_route_not_supported":
      return { code: "chatgpt-plan-unsupported-capability", retryable: false };
    case "subscription_sharing_invalid_user":
      return { code: "chatgpt-plan-permission-denied", retryable: false, confirmSession: true };
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return { code: "chatgpt-plan-permission-denied", retryable: false };
    default:
      break;
  }
  switch (input.status) {
    case 401:
    case 403:
      return { code: "chatgpt-plan-permission-denied", retryable: false };
    case 429:
      return { code: "chatgpt-plan-usage-limit", retryable: false };
    case 503:
      return { code: "chatgpt-plan-temporarily-unavailable", retryable: true };
    default:
      return { code: "chatgpt-plan-request-failed", retryable: input.status === undefined || input.status >= 500 };
  }
}
