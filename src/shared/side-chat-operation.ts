/** Invoke failures may carry a host-validated pane target, never a renderer-supplied ownership claim. */
export interface SideChatOperationFailure {
  ok: false;
  error: string;
  paneTabId?: string;
}

const SIDE_CHAT_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "unauthorized-frame",
  "side-chat-unavailable",
  "invalid-input",
  "invalid-session-id",
  "invalid-surface",
  "empty-text",
  "session-open-in-pane",
  "streaming-active",
  "pane-chat-ended",
  "session-not-found",
]);

/** Unknown execution and transport failures remain stream errors, even before a stream prelude. */
export function sideChatFailureNotice(error: string): "operation-error" | "stream-error" {
  return SIDE_CHAT_REFUSAL_CODES.has(error) ? "operation-error" : "stream-error";
}
