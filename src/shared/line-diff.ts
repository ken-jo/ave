/**
 * One line-diff model for every surface that shows a file change: tool result cards, approval cards,
 * turn review and the keep/undo controls. The algorithm is the ported LcsDiff in `lcs-diff.ts`;
 * this file owns Ave's line splitting, hunk grouping and display bounds.
 */
import { LcsDiff } from "./lcs-diff.js";

/** A changed range in zero-based line indexes; `oldCount` or `newCount` is 0 for a pure insert or delete. */
export interface LineChange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface FileDiffRow {
  kind: "context" | "added" | "removed";
  /** Line text without its terminator. */
  text: string;
}

export interface FileDiffHunk {
  /** One-based line number of the hunk's first row in the old file. */
  oldStart: number;
  /** One-based line number of the hunk's first row in the new file. */
  newStart: number;
  oldCount: number;
  newCount: number;
  rows: FileDiffRow[];
}

export interface FileDiffView {
  hunks: FileDiffHunk[];
  /** Totals for the whole change, including rows left out by the display bound. */
  added: number;
  removed: number;
  /** True when rows were left out to respect the display bound. */
  truncated: boolean;
  /** True when the texts differ only in line terminators, which the rows do not show. */
  lineEndingsOnly?: boolean;
}

export interface FileDiffLimits {
  contextLines: number;
  maxRows: number;
  maxCharacters: number;
}

export const DEFAULT_FILE_DIFF_LIMITS: FileDiffLimits = { contextLines: 3, maxRows: 2_000, maxCharacters: 262_144 };

/** Above this many lines on either side the exact diff is skipped and the change is shown as one replaced block. */
export const MAX_LINE_DIFF_LINES = 20_000;

const LINE_RE = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g;

/** Split into lines that keep their terminators, so joining them restores the text byte for byte. */
export function splitLinesKeepingEnds(text: string): string[] {
  return text.match(LINE_RE) ?? [];
}

function withoutLineEnd(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  return line.endsWith("\n") || line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Changed line ranges between two line lists, in order and never overlapping. */
export function computeLineChanges(oldLines: readonly string[], newLines: readonly string[]): LineChange[] {
  if (oldLines.length > MAX_LINE_DIFF_LINES || newLines.length > MAX_LINE_DIFF_LINES) {
    return oldLines.length === 0 && newLines.length === 0
      ? []
      : [{ oldStart: 0, oldCount: oldLines.length, newStart: 0, newCount: newLines.length }];
  }
  const diff = new LcsDiff({ getElements: () => [...oldLines] }, { getElements: () => [...newLines] });
  return diff.ComputeDiff(true).changes.map(change => ({
    oldStart: change.originalStart,
    oldCount: change.originalLength,
    newStart: change.modifiedStart,
    newCount: change.modifiedLength,
  }));
}

/**
 * Unified-diff style hunks with context, bounded for display.
 * Lines are compared without their terminators: a reader cannot see a terminator, so a block whose last
 * line lost its newline is not shown as a changed line. A change that is only terminators is flagged.
 */
export function buildFileDiffView(before: string, after: string, limits: FileDiffLimits = DEFAULT_FILE_DIFF_LIMITS): FileDiffView {
  const oldLines = splitLinesKeepingEnds(before).map(withoutLineEnd);
  const newLines = splitLinesKeepingEnds(after).map(withoutLineEnd);
  const changes = computeLineChanges(oldLines, newLines);
  const view: FileDiffView = { hunks: [], added: 0, removed: 0, truncated: false };
  if (changes.length === 0 && before !== after) view.lineEndingsOnly = true;
  for (const change of changes) {
    view.added += change.newCount;
    view.removed += change.oldCount;
  }
  let rows = 0;
  let characters = 0;
  let index = 0;
  while (index < changes.length && !view.truncated) {
    // Changes closer than two context windows share one hunk, as in a unified diff.
    let last = index;
    while (last + 1 < changes.length
      && changes[last + 1].oldStart - (changes[last].oldStart + changes[last].oldCount) <= limits.contextLines * 2) last++;
    const first = changes[index];
    const final = changes[last];
    const leading = Math.min(limits.contextLines, first.oldStart);
    const oldEnd = Math.min(oldLines.length, final.oldStart + final.oldCount + limits.contextLines);
    const hunk: FileDiffHunk = {
      oldStart: first.oldStart - leading + 1,
      newStart: first.newStart - leading + 1,
      oldCount: 0,
      newCount: 0,
      rows: [],
    };
    const push = (kind: FileDiffRow["kind"], text: string): boolean => {
      if (rows >= limits.maxRows || characters + text.length > limits.maxCharacters) {
        view.truncated = true;
        return false;
      }
      rows++;
      characters += text.length;
      hunk.rows.push({ kind, text });
      if (kind !== "added") hunk.oldCount++;
      if (kind !== "removed") hunk.newCount++;
      return true;
    };
    let oldCursor = first.oldStart - leading;
    emit: for (let current = index; current <= last; current++) {
      const change = changes[current];
      while (oldCursor < change.oldStart) if (!push("context", oldLines[oldCursor++])) break emit;
      for (let offset = 0; offset < change.oldCount; offset++) if (!push("removed", oldLines[oldCursor++])) break emit;
      for (let offset = 0; offset < change.newCount; offset++) if (!push("added", newLines[change.newStart + offset])) break emit;
      if (current === last) while (oldCursor < oldEnd) if (!push("context", oldLines[oldCursor++])) break emit;
    }
    if (hunk.rows.length > 0) view.hunks.push(hunk);
    index = last + 1;
  }
  return view;
}
