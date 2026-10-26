/** Slash and resource menus share caret-trigger detection; a non-null token range opens the matching menu. */

export interface SlashTrigger {
  /** The query typed after the leading "/" (does NOT include the slash). */
  query: string;
  /** Index of the leading "/" in `text` (inclusive). */
  start: number;
  /** Index where the query ends — i.e. the caret position (exclusive). */
  end: number;
}

/** A slash must begin a whitespace-delimited token; any whitespace between it and the caret closes the menu, excluding
 * URL/path slashes. */
export function detectSlashQuery(text: string, caret: number): SlashTrigger | null {
  return detectTriggerQuery(text, caret, "/");
}

/**
 * The same rule for the "@" mention menu, which offers MCP server resources.
 *
 * Shares the activation rule rather than restating it, so the two menus cannot drift
 * into answering "is this a trigger" differently — and so `foo@example.com` never opens
 * the picker, for exactly the reason `https://` never opens the slash menu: the sigil
 * has to START a token.
 */
export function detectMentionQuery(text: string, caret: number): SlashTrigger | null {
  return detectTriggerQuery(text, caret, "@");
}

function detectTriggerQuery(text: string, caret: number, sigil: string): SlashTrigger | null {
  if (caret < 1 || caret > text.length) return null;

  // Scan backwards from the caret to the nearest sigil. Any whitespace between the caret and it ends the token (no active
  // trigger).
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === sigil) break;
    if (ch === " " || ch === "\n" || ch === "\t") return null;
    i -= 1;
  }
  if (i < 0 || text[i] !== sigil) return null;

  // The sigil must start a token: at text start, or right after whitespace.
  const before = i === 0 ? "" : text[i - 1];
  if (before !== "" && before !== " " && before !== "\n" && before !== "\t") {
    return null;
  }

  return { query: text.slice(i + 1, caret), start: i, end: caret };
}
