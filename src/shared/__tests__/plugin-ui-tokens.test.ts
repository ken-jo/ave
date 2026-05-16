import { describe, it, expect } from "vitest";
import { isAveThemeBundleId, AVE_THEME_BUNDLE_IDS, AVE_TOKEN_NAMES } from "../plugin-ui-tokens.js";

const DERIVED_TOKENS = [
  "--ave-primary-bg-subtle",
  "--ave-primary-bg-strong",
  "--ave-danger-bg-subtle",
  "--ave-warning-bg-subtle",
  "--ave-success-bg-subtle",
  "--ave-surface-hover",
  "--ave-focus-shadow",
] as const;

describe("AVE_TOKEN_NAMES — derived tinted-surface tokens", () => {
  it("includes all 7 new derived tokens", () => {
    for (const token of DERIVED_TOKENS) {
      expect(AVE_TOKEN_NAMES).toContain(token);
    }
  });

  it("has no duplicate token names", () => {
    const seen = new Set<string>();
    for (const name of AVE_TOKEN_NAMES) {
      expect(seen.has(name), `duplicate token: ${name}`).toBe(false);
      seen.add(name);
    }
  });
});

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
