import { describe, expect, it } from "vitest";
import { countFileChangeLines, countFileChangeTextLines } from "../file-change-counts.js";

describe("file change line counts", () => {
  it.each([1_001, 2_001, 10_000])("trims unchanged boundaries before counting a small edit in %s lines", (count) => {
    const before = Array.from({ length: count }, (_, index) => `line ${index}\n`);
    const after = [...before];
    after[Math.floor(count / 2)] = "changed line\n";
    expect(countFileChangeLines(before.join(""), after.join(""))).toEqual({ added: 1, removed: 1, exact: true });
  });
  it("counts separated edits and retained interior lines using the same source separators", () => {
    expect(countFileChangeLines("old\r\nkeep\r\nlast", "new\r\nkeep\r\nend\n"))
      .toEqual({ added: 2, removed: 2, exact: true });
    expect(countFileChangeTextLines("one\rtwo\r\nthree\n")).toBe(3);
    expect(countFileChangeLines("keep\n", "one\rtwo\r\nkeep\n")).toEqual({ added: 2, removed: 0, exact: true });
  });
  it.each([1_001, 2_001])("masks unresolved %s-line replacements instead of claiming full-file counts are exact", (count) => {
    const before = Array.from({ length: count }, (_, index) => `before ${index}\n`).join("");
    const after = Array.from({ length: count }, (_, index) => `after ${index}\n`).join("");
    expect(countFileChangeLines(before, after)).toEqual({ added: 0, removed: 0, exact: false });
  });
  it("counts pure creation/deletion beyond the comparison budget without a replacement estimate", () => {
    const content = "created\n".repeat(10_000);
    expect(countFileChangeLines("", content)).toEqual({ added: 10_000, removed: 0, exact: true });
    expect(countFileChangeLines(content, "")).toEqual({ added: 0, removed: 10_000, exact: true });
    expect(countFileChangeLines("", "")).toEqual({ added: 0, removed: 0, exact: true });
  });
  it("does not trim partial lines or confuse trailing separator changes with unchanged lines", () => {
    expect(countFileChangeLines("same", "same\nnext\n")).toEqual({ added: 2, removed: 1, exact: true });
    expect(countFileChangeLines("a\r\n\r\nlast", "b\r\n\r\nlast")).toEqual({ added: 1, removed: 1, exact: true });
    expect(countFileChangeLines("a\r", "a\r\nnext")).toEqual({ added: 2, removed: 1, exact: true });
    expect(countFileChangeLines("a\rkeep", "a\rnext")).toEqual({ added: 1, removed: 1, exact: true });
  });
});
