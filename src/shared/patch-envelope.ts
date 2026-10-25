/** Pure patch parsing and application; the tool owns filesystem access and permissions. Chunks match forward in file order, trying exact, trailing-whitespace, then surrounding-whitespace matches. */

export interface PatchChunk {
  /** `@@ <anchor>` line text; the old block is searched after this line. */
  readonly anchor: string | null;
  readonly oldLines: readonly string[];
  readonly newLines: readonly string[];
  /** `*** End of File` followed the chunk: its old block ends the file. */
  readonly endOfFile: boolean;
}

export type PatchFileOperation =
  | { readonly kind: "add"; readonly path: string; readonly content: string }
  | { readonly kind: "delete"; readonly path: string }
  | {
      readonly kind: "update";
      readonly path: string;
      readonly moveTo: string | null;
      readonly chunks: readonly PatchChunk[];
    };

export type PatchParseResult =
  | { readonly ok: true; readonly operations: readonly PatchFileOperation[] }
  | { readonly ok: false; readonly error: string };

export type PatchApplyResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly error: string };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function isFileHeader(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE) || line === END;
}

/** Optional surrounding Markdown fences do not replace mandatory envelope markers. */
function envelopeLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length >= 2 && /^```[\w-]*$/.test(lines[0]!.trim()) && lines[lines.length - 1]!.trim() === "```") {
    lines.shift();
    lines.pop();
  }
  return lines;
}

export function parsePatchEnvelope(text: string): PatchParseResult {
  const lines = envelopeLines(text);
  if (lines[0]?.trim() !== BEGIN) {
    return { ok: false, error: `the first line must be '${BEGIN}'` };
  }
  if (lines[lines.length - 1]?.trim() !== END) {
    return { ok: false, error: `the last line must be '${END}'` };
  }
  const body = lines.slice(1, -1);
  const operations: PatchFileOperation[] = [];
  let index = 0;
  while (index < body.length) {
    const header = body[index]!;
    const lineNo = index + 2;
    if (header.trim() === "") {
      index += 1;
      continue;
    }
    if (header.startsWith(ADD)) {
      const path = header.slice(ADD.length).trim();
      if (path === "") return { ok: false, error: `line ${lineNo}: Add File needs a path` };
      index += 1;
      const added: string[] = [];
      while (index < body.length && !isFileHeader(body[index]!)) {
        const line = body[index]!;
        if (!line.startsWith("+")) {
          return { ok: false, error: `line ${index + 2}: every line of an added file must start with '+'` };
        }
        added.push(line.slice(1));
        index += 1;
      }
      operations.push({ kind: "add", path, content: added.length === 0 ? "" : `${added.join("\n")}\n` });
      continue;
    }
    if (header.startsWith(DELETE)) {
      const path = header.slice(DELETE.length).trim();
      if (path === "") return { ok: false, error: `line ${lineNo}: Delete File needs a path` };
      operations.push({ kind: "delete", path });
      index += 1;
      continue;
    }
    if (header.startsWith(UPDATE)) {
      const path = header.slice(UPDATE.length).trim();
      if (path === "") return { ok: false, error: `line ${lineNo}: Update File needs a path` };
      index += 1;
      let moveTo: string | null = null;
      if (index < body.length && body[index]!.startsWith(MOVE)) {
        moveTo = body[index]!.slice(MOVE.length).trim();
        if (moveTo === "") return { ok: false, error: `line ${index + 2}: Move to needs a path` };
        index += 1;
      }
      const parsed = parseChunks(body, index);
      if (!parsed.ok) return parsed;
      index = parsed.next;
      if (parsed.chunks.length === 0 && moveTo === null) {
        return { ok: false, error: `line ${lineNo}: Update File ${path} has no changes` };
      }
      operations.push({ kind: "update", path, moveTo, chunks: parsed.chunks });
      continue;
    }
    return {
      ok: false,
      error: `line ${lineNo}: expected '${ADD.trim()}', '${UPDATE.trim()}' or '${DELETE.trim()}', got '${header}'`,
    };
  }
  if (operations.length === 0) return { ok: false, error: "the patch names no files" };
  return { ok: true, operations };
}

function parseChunks(
  body: readonly string[],
  start: number,
): { ok: true; chunks: PatchChunk[]; next: number } | { ok: false; error: string } {
  const chunks: PatchChunk[] = [];
  let index = start;
  let current: { anchor: string | null; oldLines: string[]; newLines: string[]; changed: boolean } | null = null;
  const flush = (endOfFile: boolean): string | null => {
    if (current === null) return null;
    if (!current.changed) {
      return "a chunk must contain at least one '+' or '-' line";
    }
    chunks.push({ anchor: current.anchor, oldLines: current.oldLines, newLines: current.newLines, endOfFile });
    current = null;
    return null;
  };
  while (index < body.length && !isFileHeader(body[index]!)) {
    const line = body[index]!;
    if (line === "@@" || line.startsWith("@@ ")) {
      const error = flush(false);
      if (error) return { ok: false, error: `line ${index + 2}: ${error}` };
      const anchor = line === "@@" ? "" : line.slice(3);
      current = { anchor: anchor.trim() === "" ? null : anchor, oldLines: [], newLines: [], changed: false };
      index += 1;
      continue;
    }
    if (line.trim() === END_OF_FILE) {
      const error = flush(true);
      if (error) return { ok: false, error: `line ${index + 2}: ${error}` };
      index += 1;
      continue;
    }
    current ??= { anchor: null, oldLines: [], newLines: [], changed: false };
    const marker = line.charAt(0);
    const text = line.slice(1);
    if (line === "") {
      // An empty chunk line is a context line with its leading space dropped.
      current.oldLines.push("");
      current.newLines.push("");
    } else if (marker === " ") {
      current.oldLines.push(text);
      current.newLines.push(text);
    } else if (marker === "-") {
      current.oldLines.push(text);
      current.changed = true;
    } else if (marker === "+") {
      current.newLines.push(text);
      current.changed = true;
    } else {
      return { ok: false, error: `line ${index + 2}: chunk lines must start with ' ', '-' or '+', got '${line}'` };
    }
    index += 1;
  }
  const error = flush(false);
  if (error) return { ok: false, error: `line ${index + 1}: ${error}` };
  return { ok: true, chunks, next: index };
}

export function patchOperationPaths(operations: readonly PatchFileOperation[]): string[] {
  const paths: string[] = [];
  for (const operation of operations) {
    paths.push(operation.path);
    if (operation.kind === "update" && operation.moveTo !== null) paths.push(operation.moveTo);
  }
  return [...new Set(paths)];
}

const LINE_COMPARATORS: ReadonlyArray<(a: string, b: string) => boolean> = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
];

function seekSequence(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  endOfFile: boolean,
): number {
  if (pattern.length === 0) return from;
  if (pattern.length > lines.length) return -1;
  const last = lines.length - pattern.length;
  for (const equal of LINE_COMPARATORS) {
    const matchesAt = (at: number): boolean => pattern.every((line, offset) => equal(lines[at + offset]!, line));
    if (endOfFile) {
      if (last >= from && matchesAt(last)) return last;
      continue;
    }
    for (let at = from; at <= last; at += 1) {
      if (matchesAt(at)) return at;
    }
  }
  return -1;
}

/** Preserve the original line separator and final-newline state. */
export function applyPatchChunks(original: string, chunks: readonly PatchChunk[]): PatchApplyResult {
  const separator = original.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = original.endsWith("\n");
  const lines = original === "" ? [] : original.split(/\r?\n/);
  if (endsWithNewline) lines.pop();
  const edits: Array<{ at: number; remove: number; insert: readonly string[] }> = [];
  let cursor = 0;
  for (const [position, chunk] of chunks.entries()) {
    const label = `chunk ${position + 1}`;
    if (chunk.anchor !== null) {
      const anchorAt = seekSequence(lines, [chunk.anchor], cursor, false);
      if (anchorAt === -1) {
        return { ok: false, error: `${label}: anchor line not found: '${chunk.anchor}'` };
      }
      cursor = anchorAt + 1;
    }
    if (chunk.oldLines.length === 0) {
      // Pure insertion: after the anchor when one is given, else at end of file.
      const at = chunk.anchor !== null ? cursor : lines.length;
      edits.push({ at, remove: 0, insert: chunk.newLines });
      cursor = at;
      continue;
    }
    let oldLines = chunk.oldLines;
    let newLines = chunk.newLines;
    let at = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    if (at === -1 && oldLines[oldLines.length - 1] === "") {
      // A trailing empty context line usually stands for the final newline.
      oldLines = oldLines.slice(0, -1);
      newLines = newLines[newLines.length - 1] === "" ? newLines.slice(0, -1) : newLines;
      at = seekSequence(lines, oldLines, cursor, chunk.endOfFile);
    }
    if (at === -1) {
      return {
        ok: false,
        error: `${label}: expected lines not found:\n${chunk.oldLines.join("\n")}`,
      };
    }
    edits.push({ at, remove: oldLines.length, insert: newLines });
    cursor = at + oldLines.length;
  }
  for (const edit of [...edits].reverse()) {
    lines.splice(edit.at, edit.remove, ...edit.insert);
  }
  const joined = lines.join(separator);
  return { ok: true, content: endsWithNewline && lines.length > 0 ? `${joined}${separator}` : joined };
}
