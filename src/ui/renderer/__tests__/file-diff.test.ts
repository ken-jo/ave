import { describe, expect, it } from "vitest";
import { countDiffLines } from "../utils/file-diff.js";

describe("diff line counts", () => {
  it.each([
    ["", 0], ["one", 1], ["one\n", 2], ["\n", 2], ["one\r\ntwo\r\n", 3], ["한글\n끝", 2],
  ])("preserves the display count for %j", (text, expected) => {
    expect(countDiffLines(text)).toBe(expected);
  });

  it("counts large newline-dense text", () => {
    expect(countDiffLines("\n".repeat(1_000_000))).toBe(1_000_001);
  });
});
