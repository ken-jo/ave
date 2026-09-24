/**
 * Theme contrast audit — every compiled-in bundle passes the same runtime
 * rules the theme package installer applies (`shared/theme-tokens.ts`):
 * WCAG AA (4.5:1) for body text, AA Large (3:1) for chips and badges and the
 * visible UI line, and 4.5:1 for diff hunk text over its translucent wash.
 *
 * Used to catch foreground tokens that don't match their bg lightness
 * (the canonical regression: `message-user-fg: white` against a 76% L
 * lilac `message-user-bg`, contrast ~1.5 → user text effectively
 * invisible).
 */
import { describe, it, expect } from "vitest";
import { THEME_CONTRAST_RULES, themeTokenProblems } from "../../../../../shared/theme-tokens.js";
import { BUNDLE_IDS, loadThemeBundle } from "../index.js";

describe("Theme contrast (runtime rules)", () => {
  for (const bundleId of BUNDLE_IDS) {
    for (const rule of THEME_CONTRAST_RULES) {
      it(`${bundleId}: ${rule.label} ≥ ${rule.minimum}`, async () => {
        const bundle = await loadThemeBundle(bundleId);
        expect(bundle).toBeDefined();
        const ratio = rule.ratio(bundle!.tokens);
        expect(ratio, `${bundle!.id} ${rule.label} ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(rule.minimum);
      });
    }

    it(`${bundleId}: passes the installer's token check`, async () => {
      const bundle = await loadThemeBundle(bundleId);
      expect(themeTokenProblems(bundle!.tokens)).toEqual([]);
    });
  }
});

describe("themeTokenProblems", () => {
  it("refuses missing, unknown and malformed tokens before measuring contrast", async () => {
    const bundle = await loadThemeBundle("moonstone");
    const { background: _dropped, ...missing } = bundle!.tokens;
    expect(themeTokenProblems(missing)).toEqual(["missing token background"]);
    expect(themeTokenProblems({ ...bundle!.tokens, extra: "0 0% 0%" })).toEqual(["unknown token extra"]);
    expect(themeTokenProblems({ ...bundle!.tokens, foreground: "red; background: url(x)" })).toEqual(['foreground is not an "H S% L%" triple']);
    expect(themeTokenProblems({ ...bundle!.tokens, foreground: "400 10% 10%" })).toEqual(['foreground is not an "H S% L%" triple']);
    expect(themeTokenProblems([])).toEqual(["tokens must be an object"]);
  });

  it("names every contrast rule a token set fails", async () => {
    const bundle = await loadThemeBundle("moonstone");
    const problems = themeTokenProblems({ ...bundle!.tokens, foreground: bundle!.tokens.background });
    expect(problems[0]).toMatch(/^background ↔ foreground contrast 1\.00 is under 4\.5$/u);
    expect(problems.some((problem) => problem.startsWith("foreground over the success diff wash"))).toBe(true);
  });
});
