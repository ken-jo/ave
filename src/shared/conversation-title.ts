import { stagedEnvelopeTitle } from "./staged-origins.js";
import { sessionDisplayTitle } from "./suggestions-session.js";

/** A transcript-derived conversation name is at most this many code points. */
export const CONVERSATION_TITLE_MAX_CHARS = 80;

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
    const staged = stagedEnvelopeTitle(content);
    const text = staged ? staged.title || translate(staged.kind.labelKey) : content;
    lastContent = text.replace(/\s+/g, " ").trim();
    if (role === "user") lastUser = lastContent;
  }
  const transcriptTitle = truncateCodePoints(lastUser || lastContent, CONVERSATION_TITLE_MAX_CHARS);
  return sessionDisplayTitle(session.sessionId,
    session.title || transcriptTitle || session.routineTitle
      || translate("be_memoryManager.sessionTitleShort", { id: session.sessionId.slice(0, 8) }), translate);
}

/** Cut to at most `max` code points, so an emoji or other astral character at the boundary is never split into a lone surrogate. */
export function truncateCodePoints(text: string, max: number): string {
  const codePoints = [...text];
  return codePoints.length > max ? codePoints.slice(0, max).join("") : text;
}
