import { describe, expect, it } from "vitest";
import { applyTurnReviewHunks, createTurnReviewHunks } from "../turn-review-diff.js";

describe("exact text review hunks", () => {
  it("separates changes at each common line and keeps original offsets", () => {
    const before = "α\r\nkeep\r\nlast";
    const after = "β\r\nkeep\r\nend\n";
    const hunks = createTurnReviewHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(hunks.map((hunk) => [hunk.oldStartLine, hunk.newStartLine])).toEqual([[1, 1], [3, 3]]);
    expect(applyTurnReviewHunks(before, hunks)).toBe(after);
    hunks[0].decision = "rejected";
    expect(applyTurnReviewHunks(before, hunks)).toBe("α\r\nkeep\r\nend\n");
    hunks[1].decision = "rejected";
    expect(applyTurnReviewHunks(before, hunks)).toBe(before);
  });

  it("handles insertion and deletion separated by common text", () => {
    const before = "remove\nkeep\ntail\n";
    const after = "keep\ninsert\ntail\n";
    const hunks = createTurnReviewHunks(before, after);
    expect(hunks).toHaveLength(2);
    expect(applyTurnReviewHunks(before, hunks)).toBe(after);
    hunks[0].decision = "rejected";
    expect(applyTurnReviewHunks(before, hunks)).toBe("remove\nkeep\ninsert\ntail\n");
  });

  it("uses a whole-file hunk when diff complexity or line count exceeds its bound", () => {
    for (const count of [1_001, 2_001]) {
      const before = "a\n".repeat(count);
      const after = "b\n".repeat(count);
      const hunks = createTurnReviewHunks(before, after);
      expect(hunks).toHaveLength(1);
      expect(applyTurnReviewHunks(before, hunks)).toBe(after);
    }
  });

  it("distinguishes unchanged empty text from an empty-file existence change", () => {
    expect(createTurnReviewHunks("", "")).toEqual([]);
    expect(createTurnReviewHunks("", "", true)).toHaveLength(1);
  });

  it("refuses altered offsets and altered original text", () => {
    const hunks = createTurnReviewHunks("before", "after");
    expect(() => applyTurnReviewHunks("external", hunks)).toThrow();
    expect(() => applyTurnReviewHunks("before", [{ ...hunks[0], oldEnd: 100 }])).toThrow();
  });
});
