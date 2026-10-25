/** Keep approval lookalike analysis renderer-safe, separate from the Node-only shell parser. */

const NON_ASCII = /[^\u0000-\u007f]/u;

const LETTER_SCRIPTS = [
  "Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Devanagari", "Bengali",
  "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan",
  "Myanmar", "Georgian", "Hangul", "Ethiopic", "Cherokee", "Canadian_Aboriginal", "Khmer", "Mongolian", "Hiragana",
  "Katakana", "Bopomofo", "Han", "Coptic",
].map((script) => ({ script, pattern: new RegExp(`\\p{Script=${script}}`, "u") }));
/** Permit Unicode TS #39 highly restrictive script mixes, including Latin alongside Japanese, Chinese, and Korean scripts. */
const ALLOWED_SCRIPT_MIXES: ReadonlyArray<ReadonlySet<string>> = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];
const WIDTH_VARIANT = /[\uff00-\uffef]/u;

/** Always identify standalone Hangul jamo whose simple strokes can resemble ASCII. */
const HANGUL_JAMO = /[\u1100-\u11ff\u3131-\u318e\ua960-\ua97f\ud7b0-\ud7ff]/u;
/** Identify simple-shape Han and kana only in ASCII-mixed words or words made solely of those shapes. */
const SIMPLE_SHAPE_HAN_KANA = /[\u4e00\u4e28\u4e36\u4e3f\u4e40\u4e85\u4e8c\u4e09\u5341\u535c\u53e3\u56d7\u5de5\u529b\u516b\u5165\u4eba\u5915\u3007\u531a\u5182\u51f5\u30fc\u30a8\u30ed\u30ab\u30cb\u30cf\u30c8\u30bf\u30d8\u3078\u30ce\u30fd]/u;
const ASCII_ALNUM = /[A-Za-z0-9]/u;

function letterScript(ch: string): string {
  return LETTER_SCRIPTS.find(({ pattern }) => pattern.test(ch))?.script ?? `U+${ch.codePointAt(0)!.toString(16)}`;
}

/** Report confusable code points in first-appearance order; ordinary single-script words remain unlisted. */
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
