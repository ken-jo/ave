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
