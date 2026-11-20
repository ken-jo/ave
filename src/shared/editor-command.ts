/** The "open in editor" command as the setting stores it, and how it is read: both the settings screen (to refuse a
 * command that cannot be read) and main (to start it) use this one splitter. */

/** Longest editor command the setting stores. */
export const EDITOR_COMMAND_MAX_CHARS = 2_000;

/**
 * Split a command line into words. Blanks separate words; single or double quotes keep blanks inside one word and are
 * removed. Nothing else is special: a backslash is an ordinary character (Windows paths are full of them), and there is no
 * variable, glob or operator handling because no shell ever sees the result. Null for an unterminated quote.
 */
export function splitEditorCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      inWord = true;
      continue;
    }
    if (character === " " || character === "\t") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += character;
    inWord = true;
  }
  if (quote !== null) return null;
  if (inWord) words.push(word);
  return words;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A stored editor command is one line of ordinary text that splits into words; the empty string means no editor is set. */
export function isEditorCommandSetting(value: unknown): value is string {
  return typeof value === "string" && value.length <= EDITOR_COMMAND_MAX_CHARS && !hasControlCharacter(value)
    && splitEditorCommand(value) !== null;
}
