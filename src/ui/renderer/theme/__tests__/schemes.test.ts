import { describe, it, expect } from "vitest";
import { SCHEMES, requireScheme } from "../schemes/index.js";
import { applyAppearance, contrastRatio, resolveTheme, resolveAppearanceScheme } from "../resolve-theme.js";
import { STATIC_DESIGN_TOKENS } from "../design-tokens.js";
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
  it("applies the shared static design values on the pre-paint and live path", () => {
    applyAppearance(DEFAULT_APPEARANCE, document, false);
    for (const [name, value] of Object.entries(STATIC_DESIGN_TOKENS)) {
      expect(document.documentElement.style.getPropertyValue(name), name).toBe(value);
    }
  });
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
    it(`${scheme.id} enforces status, control, selection, fill and diff contrast on every surface`, () => {
      const { tokens, surfaces } = resolveTheme(scheme);
      const backgrounds = ["background", "card", "popover", "muted", "secondary", "accent", "message-user-bg", "input-bar-bg", "code-bg"]
        .map((key) => rgbHex(tokens[key as keyof typeof tokens]))
        .concat(["surface-sunken", "surface", "surface-raised", "surface-overlay"].map((key) => rgbHex(surfaces[key as keyof typeof surfaces])));
      for (const key of ["destructive", "warning", "success", "info", "emphasis"] as const) {
        for (const bg of backgrounds) expect(contrastRatio(rgbHex(tokens[key]), bg), `${key} body text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const bg of backgrounds) expect(contrastRatio(rgbHex(tokens["ui-line"]), bg), `ui-line on ${bg}`).toBeGreaterThanOrEqual(3);
      for (const [bg, fg, minimum] of [
        ["background", "foreground", 4.5], ["card", "card-foreground", 4.5], ["popover", "popover-foreground", 4.5],
        ["muted", "muted-foreground", 4.5], ["message-user-bg", "message-user-fg", 4.5], ["selection-bg", "selection-fg", 4.5],
        ["primary", "primary-foreground", 3], ["secondary", "secondary-foreground", 3], ["accent", "accent-foreground", 3],
        ["destructive", "destructive-foreground", 3], ["warning", "warning-foreground", 3], ["success", "success-foreground", 3],
        ["info", "info-foreground", 3], ["emphasis", "emphasis-foreground", 3],
      ] as const) expect(contrastRatio(rgbHex(tokens[fg]), rgbHex(tokens[bg])), `${fg} on ${bg}`).toBeGreaterThanOrEqual(minimum);
      for (const state of ["success", "destructive"] as const) for (const bg of backgrounds) {
        const color = rgbHex(tokens[state]);
        const wash = "#" + [1, 3, 5].map((offset) => Math.round(Number.parseInt(color.slice(offset, offset + 2), 16) * 0.15
          + Number.parseInt(bg.slice(offset, offset + 2), 16) * 0.85).toString(16).padStart(2, "0")).join("");
        expect(contrastRatio(rgbHex(tokens.foreground), wash), `${state} wash on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
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
  it("throws when a scheme cannot provide readable text", () => {
    const scheme = SCHEMES[0]!;
    expect(() => resolveTheme({ ...scheme, terminal: { ...scheme.terminal, background: "#888888", foreground: "#777777" } })).toThrow("cannot reach required contrast");
  });
});
