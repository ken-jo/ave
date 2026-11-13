import { describe, expect, it } from "vitest";
import { normalizeCssColor } from "../color-helpers.js";

describe("computed color normalization", () => {
  it("matches equivalent RGB and perceptual CSS serialization exactly", () => {
    const expected = normalizeCssColor("rgba(246, 251, 255, 0.1)");
    const actual = normalizeCssColor("oklab(0.985453 -0.00353155 -0.00661147 / 0.1)");
    expect(actual).toEqual([246, 251, 255, 0.1]);
    expect(actual).toEqual(expected);
  });

  it("preserves decimal and percentage alpha without byte quantization", () => {
    expect(normalizeCssColor("rgb(246 251 255 / 10%)")).toEqual([246, 251, 255, 0.1]);
    expect(normalizeCssColor("oklab(0.985453 -0.00353155 -0.00661147 / 0.1001)"))
      .toEqual([246, 251, 255, 0.1001]);
    expect(normalizeCssColor("rgba(246, 251, 255, 0.1001)"))
      .toEqual([246, 251, 255, 0.1001]);
    expect(normalizeCssColor("rgb(246 251 255 / 0.7%)"))
      .toEqual(normalizeCssColor("rgb(246 251 255 / 0.007)"));
    expect(normalizeCssColor("rgb(246 251 255 / 7e-1%)"))
      .toEqual([246, 251, 255, 0.007]);
  });

  it("keeps opaque RGB and distinct painted colors exact", () => {
    expect(normalizeCssColor("rgb(12, 18, 255)")).toEqual([12, 18, 255, 1]);
    expect(normalizeCssColor("rgb(0, 0, 0)")).toEqual([0, 0, 0, 1]);
    expect(normalizeCssColor("rgba(245, 251, 255, 0.1)"))
      .not.toEqual(normalizeCssColor("rgba(246, 251, 255, 0.1)"));
  });

  it("rejects invalid and unresolved computed colors", () => {
    for (const input of ["not-a-color", "var(--missing-color)", "currentcolor"]) {
      expect(() => normalizeCssColor(input)).toThrow(/computed color/);
    }
  });
});
