const MAX_COUNT_LINES = 2_000;
const MAX_COUNT_CELLS = 1_000_000;
const SOURCE_LINES = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g;

interface FileChangeLineCounts {
  added: number;
  removed: number;
  exact: boolean;
}

/** Separator-preserving source lines exclude a phantom line after a trailing separator. */
export function countFileChangeTextLines(text: string): number {
  let count = 0;
  for (const _line of text.matchAll(SOURCE_LINES)) count++;
  return count;
}

function lastLineStart(text: string, end: number, minimum: number): number {
  let start = end;
  if (start > minimum && text[start - 1] === "\n") {
    start--;
    if (start > minimum && text[start - 1] === "\r") start--;
  } else if (start > minimum && text[start - 1] === "\r") start--;
  while (start > minimum && text[start - 1] !== "\r" && text[start - 1] !== "\n") start--;
  return start;
}

function boundedLines(text: string): string[] | undefined {
  const lines: string[] = [];
  for (const match of text.matchAll(SOURCE_LINES)) {
    if (lines.length === MAX_COUNT_LINES) return undefined;
    lines.push(match[0]);
  }
  return lines;
}

/** Exact net additions/removals are independent of the display hunk's whole-file fallback. */
export function countFileChangeLines(before: string, after: string): FileChangeLineCounts {
  if (before === after) return { added: 0, removed: 0, exact: true };
  let prefixEnd = 0;
  for (let index = 0; index < before.length && index < after.length && before[index] === after[index]; index++) {
    if (before[index] === "\n" || (before[index] === "\r" && before[index + 1] !== "\n" && after[index + 1] !== "\n")) {
      prefixEnd = index + 1;
    }
  }
  const oldStart = prefixEnd;
  const newStart = prefixEnd;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > oldStart && newEnd > newStart) {
    const oldLast = lastLineStart(before, oldEnd, oldStart);
    const newLast = lastLineStart(after, newEnd, newStart);
    if (before.slice(oldLast, oldEnd) !== after.slice(newLast, newEnd)) break;
    oldEnd = oldLast;
    newEnd = newLast;
  }
  const removedText = before.slice(oldStart, oldEnd);
  const addedText = after.slice(newStart, newEnd);
  if (!removedText || !addedText) return {
    added: countFileChangeTextLines(addedText), removed: countFileChangeTextLines(removedText), exact: true,
  };
  const oldLines = boundedLines(removedText);
  const newLines = boundedLines(addedText);
  if (!oldLines || !newLines || (oldLines.length + 1) * (newLines.length + 1) > MAX_COUNT_CELLS) {
    return { added: 0, removed: 0, exact: false };
  }
  const identities = new Map<string, number>();
  const identity = (line: string): number => {
    const existing = identities.get(line);
    if (existing !== undefined) return existing;
    const id = identities.size;
    identities.set(line, id);
    return id;
  };
  const oldIds = oldLines.map(identity);
  const newIds = newLines.map(identity);
  let previous = new Uint32Array(newIds.length + 1);
  let current = new Uint32Array(newIds.length + 1);
  for (let oldIndex = oldIds.length - 1; oldIndex >= 0; oldIndex--) {
    for (let newIndex = newIds.length - 1; newIndex >= 0; newIndex--) {
      current[newIndex] = oldIds[oldIndex] === newIds[newIndex]
        ? previous[newIndex + 1] + 1
        : Math.max(previous[newIndex], current[newIndex + 1]);
    }
    [previous, current] = [current, previous];
  }
  const unchanged = previous[0];
  return { added: newIds.length - unchanged, removed: oldIds.length - unchanged, exact: true };
}
