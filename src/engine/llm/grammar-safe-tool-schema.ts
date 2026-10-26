/** Expand schema regex shorthands without changing their language so grammar compilers can consume them.
 * Normalize all routes at assembly; preserve references when nothing changes. */
import type { ToolSchema } from "./types.js";

// ECMA-262 whitespace and line terminators as a bracket-free class body.
const WHITESPACE_CLASS_BODY =
  "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";
const DIGIT_CLASS_BODY = "0-9";
const WORD_CLASS_BODY = "0-9A-Z_a-z";

const POSITIVE_SHORTHAND_BODIES: Readonly<Record<string, string>> = {
  d: DIGIT_CLASS_BODY,
  w: WORD_CLASS_BODY,
  s: WHITESPACE_CLASS_BODY,
};

const NEGATED_SHORTHAND_BODIES: Readonly<Record<string, string>> = {
  D: DIGIT_CLASS_BODY,
  W: WORD_CLASS_BODY,
  S: WHITESPACE_CLASS_BODY,
};

/** Keep negated shorthands inside classes unchanged; complements cannot be spliced as members. */
export function expandRegexShorthandClasses(pattern: string): string {
  if (!pattern.includes("\\")) return pattern;

  let out = "";
  let changed = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch !== "\\") {
      if (ch === "[" && !inClass) inClass = true;
      else if (ch === "]" && inClass) inClass = false;
      out += ch;
      continue;
    }
    const next = pattern[i + 1];
    if (next === undefined) {
      // Preserve a trailing lone backslash; this transform does not repair invalid regexes.
      out += ch;
      continue;
    }
    const positive = POSITIVE_SHORTHAND_BODIES[next];
    if (positive !== undefined) {
      out += inClass ? positive : "[" + positive + "]";
      changed = true;
      i++;
      continue;
    }
    const negated = NEGATED_SHORTHAND_BODIES[next];
    if (negated !== undefined && !inClass) {
      out += "[^" + negated + "]";
      changed = true;
      i++;
      continue;
    }
    // Copy other escapes with their character so escaped brackets cannot become delimiters.
    out += ch + next;
    i++;
  }
  return changed ? out : pattern;
}

/** Preserve reference equality when no nested pattern changes. */
function expandNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const next = node.map((entry) => {
      const mapped = expandNode(entry);
      if (mapped !== entry) changed = true;
      return mapped;
    });
    return changed ? next : node;
  }
  if (node === null || typeof node !== "object") return node;

  const record = node as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "pattern" && typeof value === "string") {
      const expanded = expandRegexShorthandClasses(value);
      if (expanded !== value) changed = true;
      next[key] = expanded;
      continue;
    }
    const mapped = expandNode(value);
    if (mapped !== value) changed = true;
    next[key] = mapped;
  }
  return changed ? next : node;
}

/** Return the original array when no schema pattern needs expansion. */
export function toGrammarSafeToolSchemas(
  schemas: ToolSchema[] | undefined,
): ToolSchema[] | undefined {
  if (!schemas || schemas.length === 0) return schemas;
  let changed = false;
  const next = schemas.map((schema) => {
    const inputSchema = expandNode(schema.inputSchema);
    if (inputSchema === schema.inputSchema) return schema;
    changed = true;
    return { ...schema, inputSchema: inputSchema as ToolSchema["inputSchema"] };
  });
  return changed ? next : schemas;
}
