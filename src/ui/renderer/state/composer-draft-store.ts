/** Keep in-memory drafts per conversation across tile switches and unmounts; evict least-recently parked drafts past
 * MAX_PARKED_DRAFTS. */
import { stripMarkers } from "../utils/attachment-markers.js";

const MAX_PARKED_DRAFTS = 50;
export interface ComposerDraft { text: string; appSource?: string }
const drafts = new Map<string, ComposerDraft>();

/** Park `text` for `sessionId`. Attachment markers are stripped because the attachments themselves are dropped with the
 * switch; an empty draft clears the entry. */
export function parkComposerDraft(sessionId: string, text: string, appSource?: string): void {
  if (!sessionId) return;
  const kept = stripMarkers(text);
  drafts.delete(sessionId);
  if (!kept) return;
  drafts.set(sessionId, { text: kept, ...(appSource ? { appSource } : {}) });
  if (drafts.size > MAX_PARKED_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest !== undefined) drafts.delete(oldest);
  }
}

/** Take (and remove) the parked draft for `sessionId`, or "" when none. */
export function takeComposerDraft(sessionId: string): ComposerDraft {
  const draft = drafts.get(sessionId) ?? { text: "" };
  drafts.delete(sessionId);
  return draft;
}

/** Drop every parked draft. Test isolation: the store outlives a mounted app. */
export function clearComposerDrafts(): void {
  drafts.clear();
}
