import { describe, it, expect } from "vitest";
import { SCHEMES, requireScheme } from "../schemes/index.js";
import { contrastRatio, resolveTheme, resolveAppearanceScheme } from "../resolve-theme.js";
import { DARK_SCHEME_IDS, LIGHT_SCHEME_IDS, DEFAULT_APPEARANCE } from "../../../../shared/appearance-settings.js";

function rgbHex(triple: string): string {
  const [h, s, l] = triple.split(" ").map(Number.parseFloat) as [number, number, number];
  const a = s / 100 * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

describe("curated color schemes", () => {
  it("matches the persisted catalog with six schemes per mode", () => {
    expect(SCHEMES.filter((s) => s.shell === "dark").map((s) => s.id)).toEqual([...DARK_SCHEME_IDS]);
    expect(SCHEMES.filter((s) => s.shell === "light").map((s) => s.id)).toEqual([...LIGHT_SCHEME_IDS]);
  });
  for (const scheme of SCHEMES) {
    it(`${scheme.id} keeps muted text readable on every text surface`, () => {
      const theme = resolveTheme(scheme);
      const muted = rgbHex(theme.tokens["muted-foreground"]);
      for (const key of ["background", "card", "popover", "muted", "secondary", "accent", "message-user-bg", "input-bar-bg", "code-bg"] as const) {
        expect(contrastRatio(muted, rgbHex(theme.tokens[key])), key).toBeGreaterThanOrEqual(4.5);
      }
      for (const key of ["surface-sunken", "surface", "surface-raised", "surface-overlay"] as const) {
        expect(contrastRatio(muted, rgbHex(theme.surfaces[key])), key).toBeGreaterThanOrEqual(4.5);
      }
      expect(Object.keys(theme.terminal)).toHaveLength(20);
      expect(theme.terminal).toEqual(scheme.terminal);
    });
  }
  it("uses independently saved choices in system mode", () => {
    const appearance = { ...DEFAULT_APPEARANCE, darkScheme: "nord" as const, lightScheme: "one-light" as const };
    expect(resolveAppearanceScheme(appearance, true).id).toBe("nord");
    expect(resolveAppearanceScheme(appearance, false).id).toBe("one-light");
  });
  it("rejects unknown or opposite-mode scheme IDs", () => {
    expect(() => requireScheme("missing")).toThrow("Unknown color scheme");
    expect(() => resolveAppearanceScheme({ ...DEFAULT_APPEARANCE, darkScheme: "one-light" as never }, true)).toThrow("does not match mode");
  });
});
