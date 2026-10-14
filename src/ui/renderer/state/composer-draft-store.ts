/**
 * Unsent composer text, per conversation, for the lifetime of the renderer.
 *
 * A chat tile owns one composer but shows whichever session it is switched
 * to. Without this store the text typed into one conversation stayed in the
 * composer when the tile moved to another (and went out there on Enter), and
 * closing a tile dropped it. Drafts are parked here on switch/unmount and
 * restored when the conversation comes back to any tile.
 *
 * In memory only: an app restart starts with empty composers.
 */
import { stripMarkers } from "../utils/attachment-markers.js";

const drafts = new Map<string, string>();

/**
 * Park `text` for `sessionId`. Attachment markers are stripped because the
 * attachments themselves are dropped with the switch; an empty draft clears
 * the entry.
 */
export function parkComposerDraft(sessionId: string, text: string): void {
  if (!sessionId) return;
  const kept = stripMarkers(text);
  if (kept) drafts.set(sessionId, kept);
  else drafts.delete(sessionId);
}

/** Take (and remove) the parked draft for `sessionId`, or "" when none. */
export function takeComposerDraft(sessionId: string): string {
  const text = drafts.get(sessionId) ?? "";
  drafts.delete(sessionId);
  return text;
}

/** Drop every parked draft. Test isolation: the store outlives a mounted app. */
export function clearComposerDrafts(): void {
  drafts.clear();
}
