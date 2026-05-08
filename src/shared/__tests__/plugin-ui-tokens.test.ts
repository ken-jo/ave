import { describe, it, expect } from "vitest";
import { isAveThemeBundleId, AVE_THEME_BUNDLE_IDS } from "../plugin-ui-tokens.js";

describe("isAveThemeBundleId", () => {
  it("accepts every member of AVE_THEME_BUNDLE_IDS", () => {
    for (const id of AVE_THEME_BUNDLE_IDS) {
      expect(isAveThemeBundleId(id)).toBe(true);
    }
  });

  it("rejects non-member strings", () => {
    expect(isAveThemeBundleId("non-existent-bundle")).toBe(false);
    expect(isAveThemeBundleId("")).toBe(false);
  });

  it("rejects non-strings (boundary safety)", () => {
    expect(isAveThemeBundleId(null)).toBe(false);
    expect(isAveThemeBundleId(undefined)).toBe(false);
    expect(isAveThemeBundleId(42)).toBe(false);
    expect(isAveThemeBundleId({})).toBe(false);
    expect(isAveThemeBundleId([])).toBe(false);
  });
});
