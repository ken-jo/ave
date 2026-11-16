import { describe, expect, it } from "vitest";
import { buildFileDiffView, computeLineChanges, MAX_LINE_DIFF_LINES, splitLinesKeepingEnds } from "../line-diff.js";

const lines = (count: number, mark = "") => Array.from({ length: count }, (_, index) => `line ${index + 1}${mark}\n`).join("");

describe("splitLinesKeepingEnds", () => {
  it("restores the text byte for byte and adds no line after a final newline", () => {
    for (const text of ["", "a", "a\n", "a\nb", "a\r\nb\r\n", "a\rb", "\n\n"]) {
      expect(splitLinesKeepingEnds(text).join("")).toBe(text);
    }
    expect(splitLinesKeepingEnds("a\nb\nc\n")).toHaveLength(3);
    expect(splitLinesKeepingEnds("")).toHaveLength(0);
  });
});

describe("buildFileDiffView", () => {
  it("counts one changed token in twenty lines as one removed and one added line", () => {
    const before = lines(20);
    const after = before.replace("line 10\n", "line ten\n");
    const view = buildFileDiffView(before, after);
    expect({ added: view.added, removed: view.removed }).toEqual({ added: 1, removed: 1 });
    expect(view.hunks).toHaveLength(1);
    expect(view.hunks[0]).toMatchObject({ oldStart: 7, newStart: 7, oldCount: 7, newCount: 7 });
    expect(view.hunks[0].rows.map(row => `${row.kind}:${row.text}`)).toEqual([
      "context:line 7", "context:line 8", "context:line 9",
      "removed:line 10", "added:line ten",
      "context:line 11", "context:line 12", "context:line 13",
    ]);
  });

  it("does not count the trailing newline as a line", () => {
    const view = buildFileDiffView("a\nb\nc\n", "x\ny\nz\n");
    expect({ added: view.added, removed: view.removed }).toEqual({ added: 3, removed: 3 });
  });

  it("numbers a pure insertion and a pure deletion from the real file positions", () => {
    const inserted = buildFileDiffView(lines(10), lines(10).replace("line 5\n", "line 5\nnew\n"));
    expect(inserted).toMatchObject({ added: 1, removed: 0 });
    expect(inserted.hunks[0]).toMatchObject({ oldStart: 3, newStart: 3, oldCount: 6, newCount: 7 });
    const deleted = buildFileDiffView(lines(10), lines(10).replace("line 1\n", ""));
    expect(deleted).toMatchObject({ added: 0, removed: 1 });
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, oldCount: 4, newCount: 3 });
  });

  it("keeps distant changes in separate hunks and joins near ones", () => {
    const before = lines(40);
    const far = buildFileDiffView(before, before.replace("line 5\n", "five\n").replace("line 30\n", "thirty\n"));
    expect(far.hunks.map(hunk => hunk.oldStart)).toEqual([2, 27]);
    const near = buildFileDiffView(before, before.replace("line 5\n", "five\n").replace("line 9\n", "nine\n"));
    expect(near.hunks).toHaveLength(1);
  });

  it("shows a new file as added lines and an emptied file as removed lines", () => {
    expect(buildFileDiffView("", "a\nb\n")).toMatchObject({ added: 2, removed: 0, hunks: [{ oldStart: 1, newStart: 1, oldCount: 0, newCount: 2 }] });
    expect(buildFileDiffView("a\nb\n", "")).toMatchObject({ added: 0, removed: 2 });
    expect(buildFileDiffView("same\n", "same\n")).toEqual({ hunks: [], added: 0, removed: 0, truncated: false });
  });

  it("compares lines without terminators and flags a change that is only terminators", () => {
    expect(buildFileDiffView("a\nb", "a\nb\n")).toEqual({ hunks: [], added: 0, removed: 0, truncated: false, lineEndingsOnly: true });
    expect(buildFileDiffView("a\r\nb\r\n", "a\nb\n").lineEndingsOnly).toBe(true);
    expect(buildFileDiffView("c\nd", "c")).toMatchObject({ added: 0, removed: 1 });
    expect(buildFileDiffView("same", "same").lineEndingsOnly).toBeUndefined();
  });

  it("bounds the rows it returns but keeps the full totals", () => {
    const view = buildFileDiffView("", lines(50), { contextLines: 3, maxRows: 10, maxCharacters: 10_000 });
    expect(view.truncated).toBe(true);
    expect(view.hunks[0].rows).toHaveLength(10);
    expect(view.added).toBe(50);
  });

  it("falls back to one replaced block above the line bound instead of an unbounded computation", () => {
    const big = Array.from({ length: MAX_LINE_DIFF_LINES + 1 }, () => "x\n");
    expect(computeLineChanges(big, ["y\n"])).toEqual([{ oldStart: 0, oldCount: big.length, newStart: 0, newCount: 1 }]);
  });
});
