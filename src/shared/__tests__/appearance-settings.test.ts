import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPEARANCE, DEFAULT_GLASS_TINT, glassTintAlpha, isGlassTint, normalizeAppearance } from "../appearance-settings.js";

describe("appearance persistence normalization", () => {
  it.each(["moonstone", "gallery"])("preserves the released light shell for %s", (bundleId) => {
    const warn = vi.fn();
    expect(normalizeAppearance({ schemaVersion: 2, bundleId, language: "ko", font: { family: "Menlo" } }, warn))
      .toMatchObject({ ...DEFAULT_APPEARANCE, mode: "light", language: "ko", font: { family: "Menlo" } });
    expect(warn).not.toHaveBeenCalled();
  });
  it("retires a released package selection to the default schemes", () => {
    expect(normalizeAppearance({ schemaVersion: 2, bundleId: "installed-theme" })).toEqual(DEFAULT_APPEARANCE);
  });
  it.each([undefined, 1, 4, "3", null])("repairs only an unknown schema version %s", (schemaVersion) => {
    const warn = vi.fn();
    const appearance = normalizeAppearance({ ...DEFAULT_APPEARANCE, schemaVersion, mode: "dark", darkScheme: "nord" }, warn);
    expect(appearance).toMatchObject({ schemaVersion: 3, mode: "dark", darkScheme: "nord" });
    expect(warn).toHaveBeenCalledExactlyOnceWith("schemaVersion");
  });
  it.each([
    ["mode", "invalid", DEFAULT_APPEARANCE.mode],
    ["darkScheme", "github-light", DEFAULT_APPEARANCE.darkScheme],
    ["lightScheme", "missing", DEFAULT_APPEARANCE.lightScheme],
  ])("repairs only invalid %s and names the field in a warning", (field, value, expected) => {
    const warn = vi.fn();
    const initial = { ...DEFAULT_APPEARANCE, mode: "dark", darkScheme: "nord", lightScheme: "one-light" };
    expect(normalizeAppearance({ ...initial, [field]: value }, warn)).toEqual({ ...initial, [field]: expected });
    expect(warn).toHaveBeenCalledExactlyOnceWith(field);
  });
  it("keeps a valid glass tint and drops an invalid one with a warning", () => {
    const warn = vi.fn();
    for (const glassTint of [0, 40, 70, 100]) {
      expect(normalizeAppearance({ ...DEFAULT_APPEARANCE, glassTint }, warn).glassTint).toBe(glassTint);
    }
    expect(normalizeAppearance({ ...DEFAULT_APPEARANCE }, warn)).not.toHaveProperty("glassTint");
    expect(warn).not.toHaveBeenCalled();
    for (const glassTint of [-1, 101, 12.5, "50", null]) {
      const bad = vi.fn();
      expect(normalizeAppearance({ ...DEFAULT_APPEARANCE, glassTint }, bad)).not.toHaveProperty("glassTint");
      expect(bad).toHaveBeenCalledExactlyOnceWith("glassTint");
    }
  });
});

describe("glass tint", () => {
  it("accepts whole numbers 0-100 only", () => {
    expect([0, 50, 100].every(isGlassTint)).toBe(true);
    expect([-1, 101, 0.5, Number.NaN, "10", undefined].some(isGlassTint)).toBe(false);
  });
  it("maps percent cover from bare material to opaque with a forty percent default", () => {
    expect(DEFAULT_GLASS_TINT).toBe(40);
    expect(glassTintAlpha(0)).toBe(0);
    expect(glassTintAlpha(DEFAULT_GLASS_TINT)).toBe(0.4);
    expect(glassTintAlpha(50)).toBe(0.5);
    expect(glassTintAlpha(100)).toBe(1);
  });
  it("clamps out-of-range input to bare material and opaque", () => {
    expect(glassTintAlpha(-50)).toBe(0);
    expect(glassTintAlpha(250)).toBe(1);
  });
});

it("normalizes missing and invalid zoom levels to zero without changing valid integers", () => {
 for (const zoomLevel of [undefined, null, "2", 0.5, -9, 9, NaN, Infinity]) {
   expect(normalizeAppearance({ ...DEFAULT_APPEARANCE, zoomLevel }, () => {}).zoomLevel).toBe(0);
 }
 for (let zoomLevel = -8; zoomLevel <= 8; zoomLevel++) {
   expect(normalizeAppearance({ ...DEFAULT_APPEARANCE, zoomLevel }).zoomLevel).toBe(zoomLevel);
 }
});

it("warns on invalid zoom values and leaves an absent zoom field quiet", () => {
 const warnings: string[] = [];
 expect(normalizeAppearance({ ...DEFAULT_APPEARANCE, zoomLevel: 8.5 }, (field) => warnings.push(field)).zoomLevel).toBe(0);
 expect(warnings).toContain("zoomLevel");
 warnings.length = 0;
 const { zoomLevel: _level, ...appearance } = DEFAULT_APPEARANCE;
 normalizeAppearance(appearance, (field) => warnings.push(field));
 expect(warnings).not.toContain("zoomLevel");
});
