import { MAX_COMPOSER_ATTACHMENT_COUNT } from "./composer-image-input.js";

/** Location metadata carried by an existing file mention. Paths are relative to its workspace. */
export interface FileMentionReference {
  path: string;
  startLine: number;
  endLine: number;
  turnId: string;
  hunkId?: string;
}

export const FILE_MENTION_REFERENCE_POLICY = Object.freeze({
  maxCount: MAX_COMPOSER_ATTACHMENT_COUNT,
  maxOccurrences: 50,
  maxMarkerChars: 4_096,
  maxPathChars: 2_048,
  maxContextChars: 80_000,
  maxReferenceChars: 16_000,
  maxDiffLines: 40,
});

const JSON_STRING = '"(?:[^"\\\\]|\\\\.)*"';
const LOCATION_MARKER = new RegExp(`^\\[File #(\\d+) — path: (${JSON_STRING}) — lines: (\\d+)-(\\d+) — turn: (${JSON_STRING}) — hunk: (${JSON_STRING}|null)\\]`);
const LOCATION_OPEN = /\[File #\d+ — path: /g;

function validReference(reference: FileMentionReference): boolean {
  const path = reference.path;
  return typeof path === "string" && path.length > 0 && path.length <= FILE_MENTION_REFERENCE_POLICY.maxPathChars
    && !/^[~/\\]|^[a-zA-Z]:/.test(path) && !/[\u0000-\u001f\u007f\\]/.test(path)
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
    && Number.isSafeInteger(reference.startLine) && reference.startLine > 0
    && Number.isSafeInteger(reference.endLine) && reference.endLine >= reference.startLine
    && typeof reference.turnId === "string" && reference.turnId.length > 0 && reference.turnId.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(reference.turnId)
    && (reference.hunkId === undefined || (typeof reference.hunkId === "string" && reference.hunkId.length > 0
      && reference.hunkId.length <= 128 && !/[\u0000-\u001f\u007f]/.test(reference.hunkId)));
}

export function formatFileMentionReference(n: number, reference: FileMentionReference): string {
  if (!Number.isSafeInteger(n) || n < 1 || !validReference(reference)) throw new Error("file-reference-invalid");
  const marker = `[File #${n} — path: ${JSON.stringify(reference.path)} — lines: ${reference.startLine}-${reference.endLine} — turn: ${JSON.stringify(reference.turnId)} — hunk: ${JSON.stringify(reference.hunkId ?? null)}]`;
  if (marker.length > FILE_MENTION_REFERENCE_POLICY.maxMarkerChars) throw new Error("file-reference-too-large");
  return marker;
}

/** Existing pasted attachments remain data even when their contents resemble a file selector. */
export function pastedAttachmentSpans(text: string): Array<{ start: number; end: number }> {
  const closing = new Map<string, number>();
  for (const match of text.matchAll(/^----- end Pasted text #(\d+) -----$/gm)) {
    closing.set(match[1], match.index + match[0].length);
  }
  const spans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(/^----- Pasted text #(\d+) \(\d+ lines\) -----$/gm)) {
    const close = closing.get(match[1]);
    const end = close !== undefined && close > match.index ? close : text.length;
    const previous = spans.at(-1);
    if (previous && match.index < previous.end) previous.end = Math.max(previous.end, end);
    else spans.push({ start: match.index, end });
  }
  return spans;
}

function quotedEnd(text: string, start: number): number | undefined {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '\"') return index + 1;
  }
  return undefined;
}

export function parseFileMentionReferences(text: string): Array<{
  start: number; end: number; n: number; reference: FileMentionReference;
}> {
  const found: Array<{ start: number; end: number; n: number; reference: FileMentionReference }> = [];
  const slots = new Map<number, string>();
  const spans = pastedAttachmentSpans(text);
  let spanIndex = 0;
  let candidates = 0;
  const openings = new RegExp(LOCATION_OPEN);
  for (let opening = openings.exec(text); opening !== null; opening = openings.exec(text)) {
    while (spanIndex < spans.length && spans[spanIndex].end <= opening.index) spanIndex++;
    if (spanIndex < spans.length && spans[spanIndex].start <= opening.index) {
      openings.lastIndex = spans[spanIndex].end;
      continue;
    }
    if (text[openings.lastIndex] !== '\"') continue;
    if (++candidates > FILE_MENTION_REFERENCE_POLICY.maxOccurrences) throw new Error("file-reference-too-large");
    const window = text.slice(opening.index, opening.index + FILE_MENTION_REFERENCE_POLICY.maxMarkerChars + 1);
    const pathEnd = quotedEnd(window, opening[0].length);
    if (pathEnd === undefined) throw new Error(window.length > FILE_MENTION_REFERENCE_POLICY.maxMarkerChars ? "file-reference-too-large" : "file-reference-invalid");
    if (!window.startsWith(" — lines: ", pathEnd)) {
      openings.lastIndex = opening.index + pathEnd;
      continue;
    }
    const match = LOCATION_MARKER.exec(window);
    if (!match) throw new Error(window.length > FILE_MENTION_REFERENCE_POLICY.maxMarkerChars ? "file-reference-too-large" : "file-reference-invalid");
    if (match[0].length > FILE_MENTION_REFERENCE_POLICY.maxMarkerChars) throw new Error("file-reference-too-large");
    try {
      const hunkId = JSON.parse(match[6]) as unknown;
      const reference: FileMentionReference = {
        path: JSON.parse(match[2]) as string, startLine: Number(match[3]), endLine: Number(match[4]),
        turnId: JSON.parse(match[5]) as string, ...(hunkId !== null ? { hunkId: hunkId as string } : {}),
      };
      const n = Number(match[1]);
      if (!Number.isSafeInteger(n) || n < 1 || !validReference(reference)) throw new Error("file-reference-invalid");
      const identity = JSON.stringify(reference);
      if (slots.has(n) && slots.get(n) !== identity) throw new Error("file-reference-invalid");
      slots.set(n, identity);
      if (slots.size > FILE_MENTION_REFERENCE_POLICY.maxCount) throw new Error("file-reference-too-large");
      found.push({ start: opening.index, end: opening.index + match[0].length, n, reference });
      openings.lastIndex = opening.index + match[0].length;
    } catch (error) {
      if (error instanceof Error && error.message === "file-reference-too-large") throw error;
      throw new Error("file-reference-invalid");
    }
  }
  return found;
}

export function fileMentionReferenceLabel(reference: FileMentionReference): string {
  return `${reference.path}:${reference.startLine}-${reference.endLine}`;
}
