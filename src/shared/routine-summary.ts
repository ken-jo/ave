// A routine turn closes its answer with <summary>…</summary> (routine mode's system prompt). The result card reads it; the
// conversation the turn ran in stores the answer without it.
const CLOSED_SUMMARY = /<summary>[\s\S]*?<\/summary>/g;
const TRAILING_OPEN_SUMMARY = /<summary>[\s\S]*$/;

/** The answer without its summary block, including one still being streamed (opened, not yet closed). */
export function stripRoutineSummary(text: string): string {
  return text.replace(CLOSED_SUMMARY, "").replace(TRAILING_OPEN_SUMMARY, "").trimEnd();
}
