// Create the Suggestions conversation synchronously before staging a card or no row can receive it.
import type { MemoryManager } from "../memory/memory-manager.js";
import { SUGGESTIONS_SESSION_ID } from "../shared/suggestions-session.js";

export type SuggestionsSessionStore = Pick<MemoryManager, "touchSessionTranscript">;

export function stageInSuggestionsSession(store: SuggestionsSessionStore): void {
  store.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump: true });
}

// Cards staged earlier are being handed to a window (a snapshot pull): the conversation must exist, but nothing new arrived, so its place in the list stays.
export function ensureSuggestionsSession(store: SuggestionsSessionStore): void {
  store.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump: false });
}
