import { createHash } from "node:crypto";
import type { TurnReviewHunk } from "../shared/turn-change-review.js";
import { countFileChangeTextLines } from "../shared/file-change-counts.js";

const MAX_DIFF_CELLS = 1_000_000;
const MAX_DIFF_LINES = 2_000;

/** Count current file lines with the same separator semantics as file previews. */
export function countTurnReviewLines(text: string): number {
  return countFileChangeTextLines(text);
}

/**
 * Preserve source separators and use an exact whole-file diff for complex inputs.
 * Deleted lines anchor to a surviving current line; an empty file's 1–1 range is not referenceable.
 */
export function createTurnReviewHunks(before: string, after: string, existenceChanged = false, identity = ""): TurnReviewHunk[] {
  if (before === after && !existenceChanged) return [];
  const lineCount = countTurnReviewLines(after);
  const make = (oldOffset: number, oldEnd: number, oldStartLine: number, newStartLine: number, newText: string): TurnReviewHunk => {
    const oldText = before.slice(oldOffset, oldEnd);
    const startLine = Math.min(newStartLine, Math.max(1, lineCount));
    return {
      id: createHash("sha256").update(JSON.stringify([identity, oldOffset, oldEnd, oldStartLine, newStartLine, oldText, newText])).digest("hex"),
      oldText, newText, oldStartLine, newStartLine, startLine,
      endLine: Math.min(Math.max(1, lineCount), startLine + Math.max(1, countTurnReviewLines(newText)) - 1),
    };
  };
  const tokenize = (text: string): string[] | undefined => {
    const lines: string[] = [];
    for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)) {
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
  const hunks: TurnReviewHunk[] = [];
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
