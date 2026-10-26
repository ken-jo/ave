import { randomUUID } from "node:crypto";
import type { TurnReviewHunk } from "../shared/turn-change-review.js";

const MAX_DIFF_CELLS = 1_000_000;
const MAX_DIFF_LINES = 2_000;

export interface StoredReviewHunk extends TurnReviewHunk {
  oldOffset: number;
  oldEnd: number;
}

/** Line tokens retain their terminators so applying a hunk preserves exact bytes. */
export function createTurnReviewHunks(before: string, after: string, existenceChanged = false): StoredReviewHunk[] {
  if (before === after && !existenceChanged) return [];
  const make = (oldOffset: number, oldEnd: number, oldStartLine: number, newStartLine: number, newText: string): StoredReviewHunk => ({
    id: randomUUID(), oldOffset, oldEnd, oldStartLine, newStartLine,
    oldText: before.slice(oldOffset, oldEnd), newText, decision: "pending",
  });
  const tokenize = (text: string): string[] | undefined => {
    const lines: string[] = [];
    for (const match of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
      if (lines.length >= MAX_DIFF_LINES) return undefined;
      lines.push(match[0]);
    }
    return lines;
  };
  const oldLines = tokenize(before);
  const newLines = tokenize(after);
  if (!oldLines || !newLines || (oldLines.length + 1) * (newLines.length + 1) > MAX_DIFF_CELLS || before === after) {
    return [make(0, before.length, 1, 1, after)];
  }
  const width = newLines.length + 1;
  const lengths = new Uint32Array((oldLines.length + 1) * width);
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      lengths[i * width + j] = oldLines[i] === newLines[j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const hunks: StoredReviewHunk[] = [];
  let i = 0;
  let j = 0;
  let offset = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      offset += oldLines[i++].length;
      j++;
      continue;
    }
    const start = offset;
    const oldStart = i;
    const newStart = j;
    let inserted = "";
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) break;
      if (j < newLines.length && (i === oldLines.length || lengths[i * width + j + 1] >= lengths[(i + 1) * width + j])) {
        inserted += newLines[j++];
      } else offset += oldLines[i++].length;
    }
    hunks.push(make(start, offset, oldStart + 1, newStart + 1, inserted));
  }
  return hunks;
}

export function applyTurnReviewHunks(before: string, hunks: StoredReviewHunk[]): string {
  let result = "";
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.oldOffset < offset || hunk.oldEnd < hunk.oldOffset || hunk.oldEnd > before.length
      || before.slice(hunk.oldOffset, hunk.oldEnd) !== hunk.oldText) throw new Error("Invalid review hunk offsets");
    result += before.slice(offset, hunk.oldOffset) + (hunk.decision === "rejected" ? hunk.oldText : hunk.newText);
    offset = hunk.oldEnd;
  }
  return result + before.slice(offset);
}
