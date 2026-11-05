// A routine turn closes its answer with one <summary>…</summary> block (routine mode's system prompt). The result card reads that
// block; the conversation the turn ran in stores the answer without it. Only that final block counts: a <summary> elsewhere in the
// answer, inside a code fence, or opening an HTML <details> element is the answer's own content and is left alone.
const OPEN = "<summary>";
const CLOSE = "</summary>";

/** Where the answer's final summary block starts, or -1. `partial` also accepts a block still being streamed (opened, not closed). */
function finalSummaryStart(text: string, partial: boolean): number {
  const start = text.lastIndexOf(OPEN);
  if (start < 0) return -1;
  // Inside an open code fence: the fence markers before it are unbalanced.
  if ((text.slice(0, start).match(/^\s*```/gm) ?? []).length % 2 === 1) return -1;
  if (/<details[^>]*>\s*$/i.test(text.slice(0, start))) return -1;
  const rest = text.slice(start + OPEN.length);
  const close = rest.indexOf(CLOSE);
  if (close < 0) return partial ? start : -1;
  return rest.slice(close + CLOSE.length).trim() === "" ? start : -1;
}

/** The final summary block's text, or null when the answer does not end with one. */
export function routineSummaryOf(text: string): string | null {
  const start = finalSummaryStart(text, false);
  if (start < 0) return null;
  const body = text.slice(start + OPEN.length);
  return body.slice(0, body.indexOf(CLOSE)).trim();
}

/** The answer without its final summary block, including one still being streamed. */
export function stripRoutineSummary(text: string, options: { partial?: boolean } = {}): string {
  const start = finalSummaryStart(text, options.partial === true);
  return start < 0 ? text : text.slice(0, start).trimEnd();
}
