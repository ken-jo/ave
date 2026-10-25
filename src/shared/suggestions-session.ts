/** Route unsolicited suggestions to this reserved main session; onboarding and in-conversation app cards retain their routes. It cannot be renamed or archived, and deletion recreates it empty for waiting cards. */
export const SUGGESTIONS_SESSION_ID = "5a660e57-0000-4000-8000-000000000001";

export function isSuggestionsSession(sessionId: unknown): boolean {
  return sessionId === SUGGESTIONS_SESSION_ID;
}

export const SUGGESTIONS_SESSION_TITLE_KEY = "suggestionsSession.title";

/** Resolve the reserved session name from the current locale catalog, ignoring stored or renamed titles. */
export function sessionDisplayTitle<T extends string | undefined>(
  sessionId: unknown,
  title: T,
  translate: (key: string) => string,
): string | T {
  return isSuggestionsSession(sessionId) ? translate(SUGGESTIONS_SESSION_TITLE_KEY) : title;
}
