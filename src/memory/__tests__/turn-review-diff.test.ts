import { describe, expect, it } from "vitest";
import { createTurnReviewHunks } from "../turn-review-diff.js";

describe("readonly turn review hunks", () => {
  it("keeps exact text and stable identities for separated changes", () => {
    const before = "α\r\nkeep\r\nlast";
    const after = "β\r\nkeep\r\nend\n";
    const hunks = createTurnReviewHunks(before, after, false, "turn/source.txt");
    expect(hunks).toEqual(createTurnReviewHunks(before, after, false, "turn/source.txt"));
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ oldText: "α\r\n", newText: "β\r\n", oldStartLine: 1, newStartLine: 1, startLine: 1, endLine: 1 });
    expect(hunks[1]).toMatchObject({ oldText: "last", newText: "end\n", oldStartLine: 3, newStartLine: 3, startLine: 3, endLine: 3 });
    expect(hunks[0]).not.toHaveProperty("decision");
    expect(hunks[0]).not.toHaveProperty("oldOffset");
    expect(createTurnReviewHunks(before, after, false, "other/source.txt")[0].id).not.toBe(hunks[0].id);
  });

  it("clamps removed lines at the current file's last existing line", () => {
    const hunks = createTurnReviewHunks("keep\nremove\n", "keep\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldText: "remove\n", newText: "", newStartLine: 2, startLine: 1, endLine: 1 });
    expect(createTurnReviewHunks("remove\nkeep\n", "keep\n")[0]).toMatchObject({ startLine: 1, endLine: 1 });
  });

  it("counts inserted current ranges across mixed line separators", () => {
    expect(createTurnReviewHunks("keep\r", "one\rtwo\r\nkeep\r")[0]).toMatchObject({ startLine: 1, endLine: 2, newText: "one\rtwo\r\n" });
  });

  it("uses an exact whole-file hunk when diff complexity or line count exceeds its bound", () => {
    for (const count of [1_001, 2_001]) {
      const before = "a\n".repeat(count);
      const after = "b\n".repeat(count);
      const hunks = createTurnReviewHunks(before, after);
      expect(hunks).toHaveLength(1);
      expect(hunks[0]).toMatchObject({ oldText: before, newText: after, startLine: 1, endLine: count });
    }
  });

  it("distinguishes unchanged empty text from empty-file existence changes", () => {
    expect(createTurnReviewHunks("", "")).toEqual([]);
    expect(createTurnReviewHunks("", "", true)).toMatchObject([{ oldText: "", newText: "", startLine: 1, endLine: 1 }]);
  });
});
