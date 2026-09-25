import { afterEach, describe, it, expect } from "vitest";
import {
  BUNDLES,
  BUNDLE_IDS,
  DEFAULT_BUNDLE_ID,
  findBundle,
  setInstalledThemeBundles,
  visibleBundles,
} from "../index.js";
import { moonstoneBundle } from "../moonstone.js";
import { THEME_TOKEN_NAMES } from "../../../../../shared/theme-tokens.js";

const REQUIRED_TOKEN_KEYS = THEME_TOKEN_NAMES;

/** Basic HSL-value or raw triple pattern: "H S% L%" or "H S% L% / A%" */
const HSL_TRIPLE_RE = /^\d+(?:\.\d+)?\s+\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?%/;

const nord = { ...moonstoneBundle, id: "nord", name: "Nord", shell: "dark" as const };

afterEach(() => {
  setInstalledThemeBundles([]);
});

describe("bundle registry", () => {
  it("compiles in only Moonstone and Gallery, Moonstone first and the default", () => {
    expect(BUNDLE_IDS).toEqual(["moonstone", "gallery"]);
    expect(BUNDLES.map((bundle) => bundle.id)).toEqual(["moonstone", "gallery"]);
    expect(DEFAULT_BUNDLE_ID).toBe("moonstone");
    expect(findBundle(DEFAULT_BUNDLE_ID)?.shell).toBe("light");
  });

  it("finds an installed theme package by name, and nothing for an id no one provides", () => {
    expect(findBundle("nord")).toBeUndefined();
    setInstalledThemeBundles([nord]);
    expect(findBundle("nord")).toBe(nord);
    expect(findBundle("does-not-exist")).toBeUndefined();
  });

  it("lists the compiled bundles, then the installed themes", () => {
    expect(visibleBundles().map((bundle) => bundle.id)).toEqual(["moonstone", "gallery"]);
    setInstalledThemeBundles([nord]);
    expect(visibleBundles().map((bundle) => bundle.id)).toEqual(["moonstone", "gallery", "nord"]);
  });

  it("keeps a compiled bundle when an installed theme claims its id", () => {
    // The installer refuses the compiled ids; the registry does not let one through either.
    setInstalledThemeBundles([{ ...nord, id: "moonstone" }]);
    expect(findBundle("moonstone")).toBe(moonstoneBundle);
  });
});

describe.each(BUNDLE_IDS.map((id) => [id] as [string]))(
  "bundle %s",
  (id) => {
    it("has id, name, description, shell, highContrast", () => {
      const bundle = findBundle(id)!;
      expect(typeof bundle.id).toBe("string");
      expect(bundle.id.length).toBeGreaterThan(0);
      expect(typeof bundle.name).toBe("string");
      expect(typeof bundle.description).toBe("string");
      expect(["light", "dark"]).toContain(bundle.shell);
      expect(typeof bundle.highContrast).toBe("boolean");
    });

    it("defines all required token keys", () => {
      const bundle = findBundle(id)!;
      for (const key of REQUIRED_TOKEN_KEYS) {
        expect(bundle.tokens).toHaveProperty(key);
      }
    });

    it("all token values are non-empty strings", () => {
      const bundle = findBundle(id)!;
      for (const key of REQUIRED_TOKEN_KEYS) {
        const val = bundle.tokens[key];
        expect(typeof val, `${key} should be a string`).toBe("string");
        expect(val.trim().length, `${key} should be non-empty`).toBeGreaterThan(0);
      }
    });

    it("all token values match HSL triple pattern", () => {
      const bundle = findBundle(id)!;
      for (const key of REQUIRED_TOKEN_KEYS) {
        const val = bundle.tokens[key];
        expect(HSL_TRIPLE_RE.test(val), `${key} = "${val}" should be an HSL triple`).toBe(true);
      }
    });

    it("shell matches color-scheme implied by background lightness", () => {
      const bundle = findBundle(id)!;
      // Heuristic: if background lightness > 50%, expect shell === "light"
      const bgVal = bundle.tokens.background;
      const match = bgVal.match(/(\d+(?:\.\d+)?%)$/);
      if (match) {
        const lightness = parseFloat(match[1]);
        if (lightness > 50) {
          expect(bundle.shell).toBe("light");
        } else if (lightness < 30) {
          expect(bundle.shell).toBe("dark");
        }
        // Values in between (30-50%) are ambiguous — no assertion
      }
    });
  },
);
