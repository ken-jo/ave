import {
  PATH_COLLAPSE_THRESHOLD,
  type Attachment,
} from "../types/attachments.js";

/** Share marker alternation between parse and caret lookup; paste substitution separately accepts edited line-count
 * suffixes. */
const MARKER_LABELS = "Image|File|Pasted text|Resource";
const MARKER_BODY = `\\[(?:${MARKER_LABELS}) #(\\d+)(?:\\s+\\+\\d+\\s+lines)?\\]`;
const MARKER_RE = new RegExp(MARKER_BODY, "g");

/** Parse all marker numbers present in the textarea body. Order of appearance is preserved; duplicates are deduplicated. */
export function parseMarkers(text: string): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const match of text.matchAll(MARKER_RE)) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

/**
 * Remove every attachment marker from `text`. A marker only means something
 * while its attachment is in the composer's list; text reused outside that
 * lifetime (prompt-history recall) must not carry markers that resolve to
 * nothing — or, worse, to a different attachment that reuses the number.
 */
export function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

/** Collapse the whole path while preserving the extension and both ends so directory context remains recognizable. */
export function collapsePath(path: string): string {
  const dotIdx = path.lastIndexOf(".");
  const hasExt = dotIdx > 0 && dotIdx < path.length - 1;
  const stem = hasExt ? path.slice(0, dotIdx) : path;
  const ext = hasExt ? path.slice(dotIdx) : "";
  if (stem.length < PATH_COLLAPSE_THRESHOLD) return path;
  return `${stem.slice(0, 5)}…${stem.slice(-5)}${ext}`;
}

/**
 * Build the textarea marker that represents a given attachment. The renderer
 * inserts this string at the current caret position when an attachment is
 * added, and removes the attachment from state when this marker is later
 * deleted from the body.
 */
export function buildMarkerText(att: Attachment): string {
  switch (att.kind) {
    case "image":
      return `[Image #${att.n}]`;
    case "file":
      return `[File #${att.n}]`;
    case "paste":
      return `[Pasted text #${att.n} +${att.lines} lines]`;
    case "resource":
      return `[Resource #${att.n}]`;
  }
}

/** Backspace removes an entire marker only after its opening bracket and through its trailing edge; partial deletion would
 * orphan marker fragments. */
export function findMarkerAt(
  text: string,
  cursor: number,
): { start: number; end: number } | null {
  if (cursor <= 0 || cursor > text.length) return null;
  let openIdx = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "[") {
      openIdx = i;
      break;
    }
    // A `]` at i = cursor - 1 is the closing bracket of OUR marker — keep walking back. A `]` at any earlier position means
    // the caret sits outside the marker boundary.
    if (ch === "]" && i < cursor - 1) return null;
  }
  if (openIdx === -1) return null;
  const slice = text.slice(openIdx);
  const m = slice.match(new RegExp(`^${MARKER_BODY}`));
  if (!m) return null;
  const end = openIdx + m[0].length;
  if (cursor > openIdx && cursor <= end) return { start: openIdx, end };
  return null;
}
