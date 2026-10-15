/**
 * Main's side of the dedicated Suggestions conversation: it exists before
 * anything is addressed to it.
 *
 * The renderer routes every unrequested card to
 * {@link SUGGESTIONS_SESSION_ID}; a card addressed to a conversation the list
 * does not hold is drawn nowhere and marks no row. So each place main stages
 * such a card makes the conversation exist first, synchronously, in the same
 * tick as the send. Nothing names it here: surfaces render its name from the
 * catalog by its reserved id (`sessionDisplayTitle`).
 */
import type { MemoryManager } from "../memory/memory-manager.js";
import { SUGGESTIONS_SESSION_ID } from "../shared/suggestions-session.js";

export type SuggestionsSessionStore = Pick<MemoryManager, "touchSessionTranscript">;

/**
 * A suggestion is being staged now: create the conversation if it is missing
 * and move it to the top of the recency-ordered list.
 */
export function stageInSuggestionsSession(store: SuggestionsSessionStore): void {
  store.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump: true });
}

/**
 * Cards staged earlier are being handed to a window (a snapshot pull): the
 * conversation must exist, but nothing new arrived, so its place in the list
 * stays.
 */
export function ensureSuggestionsSession(store: SuggestionsSessionStore): void {
  store.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump: false });
}
