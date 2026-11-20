import { createHash } from "node:crypto";
import type { TurnReviewHunk } from "../shared/turn-change-review.js";
import { countFileChangeTextLines } from "../shared/file-change-counts.js";
import { computeLineChanges, splitLinesKeepingEnds } from "../shared/line-diff.js";

/** Count current file lines with the same separator semantics as file previews. */
export function countTurnReviewLines(text: string): number {
  return countFileChangeTextLines(text);
}

/** A review hunk with the offsets the host needs to keep or undo it; only `hunk` is disclosed to the renderer. */
export interface TurnReviewHunkPlan {
  hunk: TurnReviewHunk;
  /** Character range of the hunk's new text in the current file. */
  newOffset: number;
  newEnd: number;
  /**
   * Identity of the change itself, anchored on the original text only. It stays the same when another hunk of the
   * file is undone or kept, which is what lets a kept hunk remain kept while its neighbours change.
   */
  keepKey: string;
}

function digest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Preserve source separators and use an exact whole-file line diff.
 * Deleted lines anchor to a surviving current line; an empty file's 1–1 range is not referenceable.
 */
export function planTurnReviewHunks(before: string, after: string, existenceChanged = false, identity = ""): TurnReviewHunkPlan[] {
  if (before === after && !existenceChanged) return [];
  const lineCount = countTurnReviewLines(after);
  const make = (oldOffset: number, oldEnd: number, newOffset: number, newEnd: number, oldStartLine: number, newStartLine: number): TurnReviewHunkPlan => {
    const oldText = before.slice(oldOffset, oldEnd);
    const newText = after.slice(newOffset, newEnd);
    const startLine = Math.min(newStartLine, Math.max(1, lineCount));
    return {
      newOffset,
      newEnd,
      keepKey: digest([identity, oldOffset, oldEnd, oldText, newText]),
      hunk: {
        id: digest([identity, oldOffset, oldEnd, oldStartLine, newStartLine, oldText, newText]),
        oldText, newText, oldStartLine, newStartLine, startLine,
        endLine: Math.min(Math.max(1, lineCount), startLine + Math.max(1, countTurnReviewLines(newText)) - 1),
        kept: false,
      },
    };
  };
  // A file that appears or disappears is one decision: there is no partial version of "exists".
  if (before === after) return [make(0, before.length, 0, after.length, 1, 1)];
  const oldLines = splitLinesKeepingEnds(before);
  const newLines = splitLinesKeepingEnds(after);
  const oldOffsets = lineOffsets(oldLines);
  const newOffsets = lineOffsets(newLines);
  return computeLineChanges(oldLines, newLines).map(change => make(
    oldOffsets[change.oldStart], oldOffsets[change.oldStart + change.oldCount],
    newOffsets[change.newStart], newOffsets[change.newStart + change.newCount],
    change.oldStart + 1, change.newStart + 1,
  ));
}

/** Character offset of each line start, plus the end of the text as the last entry. */
function lineOffsets(lines: readonly string[]): number[] {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1] + line.length);
  return offsets;
}

export function createTurnReviewHunks(before: string, after: string, existenceChanged = false, identity = ""): TurnReviewHunk[] {
  return planTurnReviewHunks(before, after, existenceChanged, identity).map(plan => plan.hunk);
}
