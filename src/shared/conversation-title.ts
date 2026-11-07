import { sessionDisplayTitle } from "./suggestions-session.js";

/** The conversation list and approval surfaces share stored-title and transcript naming rules. */
export function resolveConversationTitle(
  session: { sessionId: string; title?: string; messages?: readonly unknown[] | null; routineTitle?: string },
  translate: (key: string, params?: Record<string, string>) => string,
): string {
  let lastUser = "";
  let lastContent = "";
  for (const message of session.messages ?? []) {
    if (message === null || typeof message !== "object") continue;
    const { role, content, meta } = message as Record<string, unknown>;
    if (typeof content !== "string" || !content.trim()) continue;
    if (meta !== null && typeof meta === "object" && (meta as Record<string, unknown>).resumesInterruptedTurn === true) continue;
    lastContent = content.replace(/\s+/g, " ").trim();
    if (role === "user") lastUser = lastContent;
  }
  const transcriptTitle = (lastUser || lastContent).slice(0, 80);
  return sessionDisplayTitle(session.sessionId,
    session.title || transcriptTitle || session.routineTitle
      || translate("be_memoryManager.sessionTitleShort", { id: session.sessionId.slice(0, 8) }), translate);
}

/** The approval line names the user message whose turn raised the request: the last message the user sent at or before it.
 * A row with no send time (restored history) precedes every live request; a sub-agent report is not the user's message.
 * Undefined when the transcript holds no such message; the caller then names the conversation. */
export function approvalTriggerMessage(
  entries: readonly { kind: string; text?: string; createdAt?: number; injectHint?: string }[],
  requestCreatedAt: number,
): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== "user" || entry.injectHint === "sub-agent") continue;
    if (entry.createdAt !== undefined && entry.createdAt > requestCreatedAt) continue;
    const text = (entry.text ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 80);
  }
  return undefined;
}
