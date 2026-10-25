/** Flag mixed-script words and look-alike symbols, while allowing words entirely in one script. */
import { describe, expect, it } from "vitest";
import { terminalCommandLookalikes } from "../terminal-command-lookalikes.js";

describe("terminalCommandLookalikes", () => {
  it.each([
    ["Korean filenames", "ls \uBB38\uC11C \uBCF4\uACE0\uC11C.txt"],
    ["Japanese with Han and kana", "cat \u65E5\u672C\u8A9E\u30D5\u30A1\u30A4\u30EB.txt"],
    ["Chinese", "cat \u6587\u4EF6.md"],
    ["accented Latin", "echo caf\u00E9 na\u00EFve"],
    ["a Cyrillic word", "ls \u0421\u0435\u0440\u0433\u0435\u0439"],
    ["a Greek word", "echo \u03B1\u03B2\u03B3"],
    ["Hangul joined to Latin letters", "git commit -m \uD55C\uAE00abc"],
    ["plain ASCII", "npm test -- --watch=false"],
    ["Han words holding simple-shape characters", "cat \u4E00\u89A7.txt \u7D71\u4E00.md"],
  ])("lists nothing for %s", (_label, command) => {
    expect(terminalCommandLookalikes(command)).toEqual([]);
  });

  it.each([
    ["a Cyrillic a inside a Latin word", "open p\u0430ypal.com", ["\u0430"]],
    ["a Greek alpha inside a Latin word", "echo p\u03B1ss", ["\u03B1"]],
    ["Cyrillic inside a Korean word", "ls \uBB38\u0430\uC11C", ["\uBB38", "\u0430", "\uC11C"]],
    ["fullwidth letters", "echo \uFF4C\uFF53", ["\uFF4C", "\uFF53"]],
    ["a look-alike hyphen", "rm \u2010rf build", ["\u2010"]],
    ["a non-ASCII digit", "kill \u0661", ["\u0661"]],
    ["Han one-strokes posing as an option's dashes", "rsync \u4E00\u4E00dry-run --delete a/ b/", ["\u4E00"]],
    ["Hangul jamo posing as dashes", "rsync \u3161\u3161dry-run a/ b/", ["\u3161"]],
    ["a Hangul jamo posing as an l", "ls \u3163s", ["\u3163"]],
    ["a Han stroke posing as a pipe", "echo x\u4E28y", ["\u4E28"]],
    ["a katakana posing as an I", "ls \u30A8x", ["\u30A8"]],
    ["a Han box on its own", "ls \u53E3", ["\u53E3"]],
  ])("lists %s", (_label, command, expected) => {
    expect(terminalCommandLookalikes(command)).toEqual(expected);
  });
});
