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

/**
 * Hangul letters standing alone (compatibility and conjoining jamo, outside a
 * syllable): single strokes and simple shapes such as U+3161 (a dash) and
 * U+3163 (an l or |). A Korean word is written in syllables, so these are
 * named wherever they appear.
 */
const HANGUL_JAMO = /[\u1100-\u11ff\u3131-\u318e\ua960-\ua97f\ud7b0-\ud7ff]/u;
/**
 * Han and kana characters drawn with one or two strokes that pass for ASCII
 * or for each other (a subset of the Unicode TS #39 confusables: U+4E00 for
 * a dash, U+4E28 for |, U+53E3 and U+30ED for a box, U+5DE5 and U+30A8 for
 * an I, ...). They are ordinary characters inside Chinese and Japanese
 * words, so they are named only in a word that also holds ASCII letters or
 * digits, or a word made of nothing else.
 */
const SIMPLE_SHAPE_HAN_KANA = /[\u4e00\u4e28\u4e36\u4e3f\u4e40\u4e85\u4e8c\u4e09\u5341\u535c\u53e3\u56d7\u5de5\u529b\u516b\u5165\u4eba\u5915\u3007\u531a\u5182\u51f5\u30fc\u30a8\u30ed\u30ab\u30cb\u30cf\u30c8\u30bf\u30d8\u3078\u30ce\u30fd]/u;
const ASCII_ALNUM = /[A-Za-z0-9]/u;

function letterScript(ch: string): string {
  return LETTER_SCRIPTS.find(({ pattern }) => pattern.test(ch))?.script ?? `U+${ch.codePointAt(0)!.toString(16)}`;
}

/**
 * The characters of `command` a reader could take for other characters, in
 * order of first appearance: every non-ASCII character that is not a letter
 * or combining mark (look-alike punctuation, digits, symbols), fullwidth and
 * halfwidth forms, and the non-ASCII letters of a word that mixes scripts no
 * writing system mixes (`paypal` spelled with a Cyrillic U+0430). Within the
 * script mixes that are allowed, standalone Hangul jamo and the simple-shape
 * Han and kana characters above are named too (U+4E00 U+4E00 for `--`).
 * Words written in one script — Korean syllables, Japanese, accented Latin,
 * Cyrillic — are not listed.
 * The approval card names these by code point.
 */
export function terminalCommandLookalikes(command: string): string[] {
  const found = new Set<string>();
  for (const ch of command) {
    if (!NON_ASCII.test(ch)) continue;
    if (!/[\p{L}\p{M}]/u.test(ch) || WIDTH_VARIANT.test(ch) || HANGUL_JAMO.test(ch)) found.add(ch);
  }
  for (const word of command.split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (!NON_ASCII.test(word)) continue;
    const letters = [...word].filter((ch) => /\p{L}/u.test(ch));
    if (ASCII_ALNUM.test(word) || letters.every((ch) => SIMPLE_SHAPE_HAN_KANA.test(ch))) {
      for (const ch of letters) {
        if (SIMPLE_SHAPE_HAN_KANA.test(ch)) found.add(ch);
      }
    }
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
