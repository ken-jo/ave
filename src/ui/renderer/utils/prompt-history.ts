/** Recall starts on an empty composer; moving past the newest prompt restores the stashed draft. */
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { stripMarkers } from "./attachment-markers.js";

/** Upper bound on recalled prompts; a session longer than this keeps its newest. */
export const PROMPT_HISTORY_LIMIT = 100;

/**
 * Prompts the user typed in this transcript, oldest first. Excludes turns the
 * user did not type here (external-surface `origin`, sub-agent reports),
 * strips attachment markers, and collapses consecutive duplicates so pressing
 * Up after resending the same prompt does not appear to do nothing.
 */
export function collectPromptHistory(entries: readonly ChatEntry[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "user") continue;
    if (entry.origin !== undefined || entry.injectHint === "sub-agent") continue;
    const text = stripMarkers(entry.text);
    if (!text) continue;
    if (out[out.length - 1] === text) continue;
    out.push(text);
  }
  return out.length > PROMPT_HISTORY_LIMIT ? out.slice(out.length - PROMPT_HISTORY_LIMIT) : out;
}

export interface PromptHistoryCursor {
  /** Index into history currently shown, or null when not walking. */
  index: number | null;
  /** Composer text when the walk began; restored after the newest entry. */
  draft: string;
}

export const IDLE_PROMPT_HISTORY: PromptHistoryCursor = { index: null, draft: "" };

export interface PromptHistoryStep {
  cursor: PromptHistoryCursor;
  text: string;
}

/**
 * One Up (`-1`) or Down (`+1`) step. Returns null when the key should keep its
 * native caret-movement meaning:
 *  - Up with typed text that is not a recalled entry (never overwrite a draft
 *    the user did not hand to the history walk),
 *  - Up/Down when the caret is not on the first/last line of a multi-line value,
 *  - Up at the oldest entry, Down when not walking.
 */
export function stepPromptHistory(
  history: readonly string[],
  cursor: PromptHistoryCursor,
  direction: -1 | 1,
  text: string,
  caret: { start: number; end: number },
): PromptHistoryStep | null {
  if (caret.start !== caret.end) return null;
  const walking = cursor.index !== null && history[cursor.index] === text;
  if (direction === -1) {
    if (text.slice(0, caret.start).includes("\n")) return null;
    if (!walking && text.length > 0) return null;
    const from = walking ? (cursor.index as number) : history.length;
    const next = from - 1;
    if (next < 0) return null;
    return {
      cursor: { index: next, draft: walking ? cursor.draft : text },
      text: history[next] as string,
    };
  }
  if (!walking) return null;
  if (text.slice(caret.end).includes("\n")) return null;
  const next = (cursor.index as number) + 1;
  if (next >= history.length) return { cursor: IDLE_PROMPT_HISTORY, text: cursor.draft };
  return { cursor: { index: next, draft: cursor.draft }, text: history[next] as string };
}
