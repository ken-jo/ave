/**
 * The dedicated Suggestions conversation.
 *
 * Content the user did not ask for — a plugin's `triggerConversation`
 * suggestion, an alert card, a routine's result, an onboarding proposal — is
 * addressed to this one conversation instead of whichever conversation happens
 * to be focused. It is an ordinary `main` session in the main store, so its
 * history, search, rename, archive and delete go through the existing code;
 * only its id is reserved.
 *
 * The id is fixed rather than minted per install so main (which creates the
 * transcript on demand) and the renderer (which routes cards to it and draws
 * its row) agree without a lookup. It is a well-formed UUID, so every session
 * id check accepts it unchanged.
 */
export const SUGGESTIONS_SESSION_ID = "5a660e57-0000-4000-8000-000000000001";

export function isSuggestionsSession(sessionId: unknown): boolean {
  return sessionId === SUGGESTIONS_SESSION_ID;
}

/** The catalog key the Suggestions conversation is named by. */
export const SUGGESTIONS_SESSION_TITLE_KEY = "suggestionsSession.title";

/**
 * The name a surface shows for a conversation.
 *
 * The Suggestions conversation is named from the catalog by its reserved id,
 * in the language in use now, never from a stored string: a title stored by an
 * earlier build (or a rename) is ignored for that id. Every other conversation
 * shows what it has.
 */
export function sessionDisplayTitle<T extends string | undefined>(
  sessionId: unknown,
  title: T,
  translate: (key: string) => string,
): string | T {
  return isSuggestionsSession(sessionId) ? translate(SUGGESTIONS_SESSION_TITLE_KEY) : title;
}
