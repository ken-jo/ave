/**
 * Main's side of the dedicated Suggestions conversation: it exists before
 * anything is addressed to it.
 *
 * The renderer routes every unrequested card to
 * {@link SUGGESTIONS_SESSION_ID}; a card addressed to a conversation the list
 * does not hold is drawn nowhere and marks no row. So each place main stages
 * such a card makes the conversation exist first, synchronously, in the same
 * tick as the send.
 */
import type { MemoryManager } from "../memory/memory-manager.js";
import { SUGGESTIONS_SESSION_ID } from "../shared/suggestions-session.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";

const log = createLogger("suggestions");

export type SuggestionsSessionStore = Pick<MemoryManager, "touchSessionTranscript" | "updateSessionRowFields">;

function touch(store: SuggestionsSessionStore, bump: boolean): void {
  if (!store.touchSessionTranscript(SUGGESTIONS_SESSION_ID, { bump })) return;
  // Named once, when it is created, in the user's language at that moment —
  // an ordinary stored title, so every surface reads the same name and a
  // rename by the user sticks. The row is listed already; until this lands it
  // reads the derived title.
  void store
    .updateSessionRowFields(SUGGESTIONS_SESSION_ID, { title: t("be_suggestionsSession.title") })
    .catch((err: unknown) => {
      log.warn(`could not name the Suggestions conversation: ${errorMessage(err)}`);
    });
}

/**
 * A suggestion is being staged now: create the conversation if it is missing
 * and move it to the top of the recency-ordered list.
 */
export function stageInSuggestionsSession(store: SuggestionsSessionStore): void {
  touch(store, true);
}

/**
 * Cards staged earlier are being handed to a window (a snapshot pull, or a
 * proposal re-asked on launch): the conversation must exist, but nothing new
 * arrived, so its place in the list stays.
 */
export function ensureSuggestionsSession(store: SuggestionsSessionStore): void {
  touch(store, false);
}
