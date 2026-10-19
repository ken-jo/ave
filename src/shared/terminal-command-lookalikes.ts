/**
 * Which characters of a command typed into the user's terminal
 * (`terminal_run`) could pass for other characters, for the approval card.
 *
 * Kept apart from terminal-command-text.ts, which loads the shell parser
 * (Node only): the renderer imports this one.
 */

const NON_ASCII = /[^\u0000-\u007f]/u;

/**
 * Scripts a letter may belong to, for {@link terminalCommandLookalikes}. A
 * letter in none of them counts as a script of its own.
 */
const LETTER_SCRIPTS = [
  "Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Devanagari", "Bengali",
  "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan",
  "Myanmar", "Georgian", "Hangul", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Khmer", "Mongolian", "Hiragana",
  "Katakana", "Bopomofo", "Han", "Coptic",
].map((script) => ({ script, pattern: new RegExp(`\\p{Script=${script}}`, "u") }));
/**
 * Script sets one word may mix without looking like another word: a single
 * script, or Latin with the scripts written alongside it in Japanese, Chinese
 * and Korean (the "highly restrictive" level of Unicode TS #39).
 */
const ALLOWED_SCRIPT_MIXES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];
/** Fullwidth and halfwidth forms: ASCII look-alikes even where every letter is one script. */
const WIDTH_VARIANT = /[\uff00-\uffef]/u;

function letterScript(ch: string): string {
  return LETTER_SCRIPTS.find(({ pattern }) => pattern.test(ch))?.script ?? `U+${ch.codePointAt(0)!.toString(16)}`;
}

/**
 * The characters of `command` a reader could take for other characters, in
 * order of first appearance: every non-ASCII character that is not a letter
 * or combining mark (look-alike punctuation, digits, symbols), fullwidth and
 * halfwidth forms, and the non-ASCII letters of a word that mixes scripts no
 * writing system mixes (`paypal` spelled with a Cyrillic U+0430). Words written in one
 * script — Korean, Japanese, accented Latin, Cyrillic — are not listed.
 * The approval card names these by code point.
 */
export function terminalCommandLookalikes(command: string): string[] {
  const found = new Set<string>();
  for (const ch of command) {
    if (!NON_ASCII.test(ch)) continue;
    if (!/[\p{L}\p{M}]/u.test(ch) || WIDTH_VARIANT.test(ch)) found.add(ch);
  }
  for (const word of command.split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!NON_ASCII.test(word)) continue;
    const scripts = new Set<string>();
    for (const ch of word) {
      if (/\p{L}/u.test(ch)) scripts.add(letterScript(ch));
    }
    if (scripts.size <= 1 || ALLOWED_SCRIPT_MIXES.some((mix) => [...scripts].every((script) => mix.has(script)))) continue;
    for (const ch of word) {
      if (NON_ASCII.test(ch)) found.add(ch);
    }
  }
  return [...command].filter((ch, index, all) => found.has(ch) && all.indexOf(ch) === index);
}
