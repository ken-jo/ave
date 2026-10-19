/**
 * Which characters of a terminal_run command the approval card names as
 * possible look-alikes: mixed-script words and non-letter symbols, never a
 * word written in one script.
 */
import { describe, expect, it } from "vitest";
import { terminalCommandLookalikes } from "../terminal-command-lookalikes.js";

describe("terminalCommandLookalikes", () => {
  it.each([
    ["Korean filenames", "ls 문서 보고서.txt"],
    ["Japanese with Han and kana", "cat 日本語ファイル.txt"],
    ["Chinese", "cat 文件.md"],
    ["accented Latin", "echo café naïve"],
    ["a Cyrillic word", "ls Сергей"],
    ["a Greek word", "echo αβγ"],
    ["Hangul joined to Latin letters", "git commit -m 한글abc"],
    ["plain ASCII", "npm test -- --watch=false"],
  ])("lists nothing for %s", (_label, command) => {
    expect(terminalCommandLookalikes(command)).toEqual([]);
  });

  it.each([
    ["a Cyrillic a inside a Latin word", "open pаypal.com", ["а"]],
    ["a Greek alpha inside a Latin word", "echo pαss", ["α"]],
    ["Cyrillic inside a Korean word", "ls 문а서", ["문", "а", "서"]],
    ["fullwidth letters", "echo ｌｓ", ["ｌ", "ｓ"]],
    ["a look-alike hyphen", "rm ‐rf build", ["‐"]],
    ["a non-ASCII digit", "kill ١", ["١"]],
  ])("lists %s", (_label, command, expected) => {
    expect(terminalCommandLookalikes(command)).toEqual(expected);
  });
});
