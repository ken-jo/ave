import { describe, it, expect } from "vitest";
import { installedFontStack } from "../installed-content.js";
import {
  FONT_SIZE_SCALE_VALUES,
  isValidFontFamilyOverride,
} from "../appearance-font.js";

// Shared guards protect persisted settings and initial-theme argv from CSS injection before first paint.
describe("appearance-font — shared frame-0 / write-time guards", () => {
  it("exposes exactly the four discrete size-scale presets", () => {
    expect([...FONT_SIZE_SCALE_VALUES]).toEqual([0.75, 0.875, 1, 1.125]);
  });

  it("accepts each preset size scale via membership check (preload parse contract)", () => {
    for (const value of FONT_SIZE_SCALE_VALUES) {
      expect((FONT_SIZE_SCALE_VALUES as readonly number[]).includes(value)).toBe(true);
    }
  });

  it("rejects an off-preset size scale", () => {
    for (const bad of [0.4, 0.9, 1.5, 2, Number.NaN, Infinity]) {
      expect((FONT_SIZE_SCALE_VALUES as readonly number[]).includes(bad)).toBe(false);
    }
  });

  it("accepts a plain Latin font-family stack", () => {
    expect(isValidFontFamilyOverride("Inter, sans-serif")).toBe(true);
  });

  it("accepts a Hangul font-family stack (Unicode letters)", () => {
    expect(isValidFontFamilyOverride("맑은 고딕, sans-serif")).toBe(true);
  });

  it("rejects font-family values carrying CSS-injection metachars", () => {
    for (const bad of [
      "Inter; } body { display:none",
      "url(evil.css)",
      "Inter</style>",
      "a:expression(alert(1))",
      "x\\0a",
      "Inter\nsans-serif",
    ]) {
      expect(isValidFontFamilyOverride(bad)).toBe(false);
    }
  });

  it("rejects empty, over-length, and non-string values", () => {
    expect(isValidFontFamilyOverride("")).toBe(false);
    expect(isValidFontFamilyOverride("A".repeat(257))).toBe(false);
    expect(isValidFontFamilyOverride(installedFontStack(`a${"b".repeat(62)}c`))).toBe(true);
    expect(isValidFontFamilyOverride(123)).toBe(false);
    expect(isValidFontFamilyOverride(undefined)).toBe(false);
    expect(isValidFontFamilyOverride(null)).toBe(false);
  });
});
