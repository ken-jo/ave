/** Normalize labels only; original resource identifiers must reach their server byte-for-byte. */

// Spell controls as escapes so source reviews can see them.
// Collapse tabs and line breaks to spaces; deleting them would create new label collisions.
// Use the Unicode default-ignorable property with Unicode mode so unknown and astral invisibles stay covered.
// Variation selectors are removed intentionally; losing emoji color is preferable to invisible identifier collisions.
// Explicit bidi ranges are redundant with the property class, not a replacement for it.
const CONTROL_AND_INVISIBLE_RE = new RegExp(
  "["
  + "\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f" // C0 / C1 controls
  + "\\u202a-\\u202e\\u2066-\\u2069" // bidi embeddings, overrides, isolates
  + "]"
  + "|\\p{Default_Ignorable_Code_Point}",
  "gu",
);

/** Validation rejects the same invisible class that display cleanup removes; never normalize identifiers into new identities. */
export function hasInvisibleOrReorderingChars(value: string): boolean {
  CONTROL_AND_INVISIBLE_RE.lastIndex = 0;
  return CONTROL_AND_INVISIBLE_RE.test(value);
}

// Share C0, DEL, C1, and Unicode line-separator checks across validation boundaries.
// Do not add display-only ignorables to refusal rules; removing emoji presentation differs from dropping a user message.
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Prose permits tab, newline, and carriage return; identifiers do not.
const NON_WHITESPACE_CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/;

/** Use for single-line identifiers; callers decide whether to reject. */
export function hasControlChars(value: string): boolean {
  return CONTROL_CHAR_RE.test(value);
}

/** Use for prose that legitimately contains tabs or line breaks. */
export function hasNonWhitespaceControlChars(value: string): boolean {
  return NON_WHITESPACE_CONTROL_CHAR_RE.test(value);
}

/** Return empty for non-string or all-invisible input so callers can show a visible fallback. */
export function displaySafeLabel(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(CONTROL_AND_INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}
