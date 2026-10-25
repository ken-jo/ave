export const SUGGESTED_REPLIES_OPEN = "<suggested_replies>";
export const SUGGESTED_REPLIES_CLOSE = "</suggested_replies>";

// Share tolerant tag matching across parse, strip, and stream so spelling drift cannot leak markup.
const OPEN_TAG = String.raw`<\s*suggested_replies\s*>`;
const CLOSE_TAG = String.raw`<\s*\/\s*suggested_replies\s*>`;

const BLOCK_REGEX = new RegExp(`${OPEN_TAG}([\\s\\S]*?)${CLOSE_TAG}`);
const CLOSED_BLOCK_GLOBAL = new RegExp(`\\n*${OPEN_TAG}[\\s\\S]*?${CLOSE_TAG}\\s*`, "g");
const TRAILING_ORPHAN = new RegExp(`\\n*${OPEN_TAG}[\\s\\S]*$`);
const OPEN_TAG_ANYWHERE = new RegExp(OPEN_TAG);

/** Buffer possible opening-tag suffixes across chunks, bounded against unending whitespace. */
const MAX_PARTIAL_OPEN_TAG = 64;

function couldGrowIntoOpenTag(candidate: string): boolean {
  if (!candidate.startsWith("<")) return false;
  const compact = candidate.replace(/\s+/g, "");
  return SUGGESTED_REPLIES_OPEN.startsWith(compact);
}

function partialOpenTagLength(text: string): number {
  const max = Math.min(text.length, MAX_PARTIAL_OPEN_TAG);
  for (let i = max; i > 0; i--) {
    if (couldGrowIntoOpenTag(text.slice(text.length - i))) return i;
  }
  return 0;
}

/** Choose the first well-formed suggestion if the model supplies multiple candidates. */
export function parseSuggestedReply(raw: string): string | null {
  const match = raw.match(BLOCK_REGEX);
  if (!match) return null;
  const first = match[1]
    .split("\n")
    .map((line) => line.replace(/^[\s\-•*]+/, "").trim())
    .find((line) => line.length > 0 && line.length <= 80);
  return first ?? null;
}

/** Strip closed and trailing unclosed blocks before persistence to prevent future-turn replay. */
export function stripSuggestedReplies(raw: string): string {
  const closed = raw.replace(CLOSED_BLOCK_GLOBAL, "");
  const noTrailingOrphan = closed.replace(TRAILING_ORPHAN, "");
  return noTrailingOrphan.trimEnd();
}

export interface StreamingFilter {
  feed(chunk: string): string;
  finish(): StreamingFilterResult;
}

export interface StreamingFilterResult {
  trailing: string;
  suggestedReply: string | null;
}

/** Buffer partial opening tags across chunks and withhold suggestion blocks from visible output. */
export function createStreamingFilter(): StreamingFilter {
  let pending = "";
  let inBlock = false;
  let blockBuffer = "";

  return {
    feed(chunk: string): string {
      if (inBlock) {
        blockBuffer += chunk;
        return "";
      }
      pending += chunk;
      const openMatch = OPEN_TAG_ANYWHERE.exec(pending);
      const openIdx = openMatch ? openMatch.index : -1;
      if (openIdx >= 0) {
        const visible = pending.slice(0, openIdx).replace(/\n*$/, "");
        blockBuffer = pending.slice(openIdx);
        pending = "";
        inBlock = true;
        return visible;
      }
      const heldBack = partialOpenTagLength(pending);
      if (heldBack > 0) {
        const visible = pending.slice(0, pending.length - heldBack);
        pending = pending.slice(pending.length - heldBack);
        return visible;
      }
      const visible = pending;
      pending = "";
      return visible;
    },
    finish(): StreamingFilterResult {
      if (inBlock) {
        return { trailing: "", suggestedReply: parseSuggestedReply(blockBuffer) };
      }
      return { trailing: pending, suggestedReply: null };
    },
  };
}
