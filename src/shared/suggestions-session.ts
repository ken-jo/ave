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
