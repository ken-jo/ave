/** Keep in-memory drafts per conversation across tile switches and unmounts; evict least-recently parked drafts past
 * MAX_PARKED_DRAFTS. */
import { stripMarkers } from "../utils/attachment-markers.js";

const MAX_PARKED_DRAFTS = 50;
export interface AppComposerDraft { text: string; appSource: string }
export interface ComposerDraft { text: string; appSource?: string; pendingAppDrafts?: AppComposerDraft[] }
const drafts = new Map<string, ComposerDraft>();

/** Pending suggestions are composer content even while its editable text is empty. */
export function isComposerDraftEmpty(draft: ComposerDraft): boolean {
  return draft.text.length === 0 && !draft.pendingAppDrafts?.length;
}

/** Park `text` for `sessionId`. Attachment markers are stripped because the attachments themselves are dropped with the
 * switch; an empty draft clears the entry. */
export function parkComposerDraft(sessionId: string, text: string, appSource?: string, pendingAppDrafts?: AppComposerDraft[]): void {
  if (!sessionId) return;
  const kept = stripMarkers(text);
  drafts.delete(sessionId);
  if (!kept && !pendingAppDrafts?.length) return;
  drafts.set(sessionId, { text: kept, ...(kept && appSource ? { appSource } : {}), ...(pendingAppDrafts?.length ? { pendingAppDrafts } : {}) });
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
