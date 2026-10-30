import { describe, expect, it } from "vitest";
import { hasRationaleUserQuote, isRationaleUserQuote, RATIONALE_USER_QUOTE_PATTERN } from "../rationale-user-quote.js";

describe("exact native user quote evidence", () => {
  it.each(["y", "the", "delete X", "abcdefghijklmnop", "two longwords"])("rejects insufficient evidence %s", (quote) => {
    expect(isRationaleUserQuote(quote)).toBe(false);
    expect(new RegExp(RATIONALE_USER_QUOTE_PATTERN, "u").test(quote)).toBe(false);
  });
  it.each(["delete generated output", "프로젝트 빌드 결과물을 정리해줘"])("accepts complete multiword evidence %s", (quote) => {
    expect(isRationaleUserQuote(quote)).toBe(true);
    expect(hasRationaleUserQuote('Please: (' + quote + ').', quote)).toBe(true);
  });
  it("rejects midword occurrences and visually similar but different bytes", () => {
    expect(hasRationaleUserQuote("undelete generated output", "delete generated output")).toBe(false);
    expect(hasRationaleUserQuote("delete generated outputs", "delete generated output")).toBe(false);
    expect(hasRationaleUserQuote("delete generated output", "dеlete generated output")).toBe(false);
    expect(hasRationaleUserQuote("do not delete X", "delete X")).toBe(false);
  });
});
