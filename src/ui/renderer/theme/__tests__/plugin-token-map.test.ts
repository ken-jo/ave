/**
 * Issue #616 — tripleToHsl alpha-channel support.
 *
 * Bundle tokens are stored as bare HSL triples in the Tailwind format. The
 * format optionally includes an alpha component (`"H S% L% / A"` or
 * `"H S% L% / A%"`). The previous parser only accepted `"H S% L%"` and
 * silently returned the raw triple when alpha was present, which would
 * inject an unparseable string into plugin webview CSS (plugins consume
 * the rewrapped `hsl()` form, not raw triples).
 *
 * This test mints a synthetic ThemeBundle with one alpha-bearing token
 * and asserts the resolved plugin token is a valid `hsla()` value.
 */
import { describe, it, expect } from "vitest";
import { bundleToPluginTokens } from "../plugin-token-map.js";
import { moonstoneBundle } from "../bundles/moonstone.js";
import type { ThemeBundle } from "../bundles/types.js";
import { AVE_TOKEN_NAMES } from "../../../../shared/plugin-ui-tokens.js";

function withTokens(base: ThemeBundle, overrides: Partial<ThemeBundle["tokens"]>): ThemeBundle {
  return { ...base, tokens: { ...base.tokens, ...overrides } };
}

// The derivations depend on the shell mode and the high-contrast flag, not on a palette.
const lightBundle = moonstoneBundle;
const darkBundle: ThemeBundle = { ...moonstoneBundle, id: "dark-fixture", shell: "dark", highContrast: false };
const contrastBundle: ThemeBundle = { ...moonstoneBundle, id: "contrast-fixture", shell: "dark", highContrast: true };

describe("tripleToHsl — alpha channel support (issue #616)", () => {
  it("wraps a no-alpha triple as hsl(H, S%, L%)", () => {
    const tokens = bundleToPluginTokens(lightBundle);
    expect(tokens["--ave-bg"]).toMatch(/^hsl\(\d+(?:\.\d+)?, \d+(?:\.\d+)?%, \d+(?:\.\d+)?%\)$/);
  });

  it("wraps a triple with `/ A%` alpha as hsla(H, S%, L%, A%)", () => {
    const bundle = withTokens(lightBundle, { background: "222.2 84% 4.9% / 80%" });
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--ave-bg"]).toBe("hsla(222.2, 84%, 4.9%, 80%)");
  });

  it("wraps a triple with `/ A` (unitless) alpha as hsla(H, S%, L%, A)", () => {
    const bundle = withTokens(lightBundle, { foreground: "210 40% 98% / 0.5" });
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--ave-fg"]).toBe("hsla(210, 40%, 98%, 0.5)");
  });

  it("passes raw values through when the triple does not match either form", () => {
    const bundle = withTokens(lightBundle, { primary: "var(--p-blue-500)" });
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--ave-primary"]).toBe("var(--p-blue-500)");
  });
});

describe("bundleToPluginTokens — derived value snapshot (architect fix #4)", () => {
  it("emits every public token exactly once", () => {
    const tokens = bundleToPluginTokens(lightBundle);

    expect(Object.keys(tokens).sort()).toEqual([...AVE_TOKEN_NAMES].sort());
    for (const name of AVE_TOKEN_NAMES) {
      expect(tokens[name], name).toBeTruthy();
    }
  });

  it("keeps plugin motion tokens aligned to host motion timings", () => {
    const tokens = bundleToPluginTokens(lightBundle);

    expect(tokens["--ave-motion-fast"]).toBe("120ms");
    expect(tokens["--ave-motion-normal"]).toBe("180ms");
    expect(tokens["--ave-motion-slow"]).toBe("240ms");
    expect(tokens["--ave-motion-layout"]).toBe("300ms");
    expect(tokens["--ave-motion-ease-standard"]).toBe("cubic-bezier(0.2, 0, 0, 1)");
    expect(tokens["--ave-motion-ease-out"]).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(tokens["--ave-motion-ease-in-out"]).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
  });

  it("exposes the host semantic typography rhythm", () => {
    const tokens = bundleToPluginTokens(lightBundle);

    expect(tokens["--ave-text-micro"]).toBe("0.75rem");
    expect(tokens["--ave-leading-micro"]).toBe("1rem");
    expect(tokens["--ave-tracking-micro"]).toBe("0.015em");
    expect(tokens["--ave-text-caption"]).toBe("0.75rem");
    expect(tokens["--ave-leading-caption"]).toBe("1.125rem");
    expect(tokens["--ave-text-body-sm"]).toBe("0.875rem");
    expect(tokens["--ave-leading-body-sm"]).toBe("1.25rem");
    expect(tokens["--ave-text-body"]).toBe("1rem");
    expect(tokens["--ave-leading-body"]).toBe("1.5rem");
  });

  it("aliases chat roles from the active bundle without a second color source", () => {
    const tokens = bundleToPluginTokens(lightBundle);

    expect(tokens["--ave-message-user-bg"]).toBe("hsl(225, 33%, 93%)");
    expect(tokens["--ave-message-user-border"]).toBe(tokens["--ave-message-user-fg"]);
    expect(tokens["--ave-message-user-muted"]).toBe(tokens["--ave-message-user-fg"]);
    expect(tokens["--ave-message-user-action"]).toBe(tokens["--ave-message-user-fg"]);
    expect(tokens["--ave-message-user-emphasis"]).toBe(tokens["--ave-message-user-fg"]);
    expect(tokens["--ave-input-bar-fg"]).toBe(tokens["--ave-fg"]);
    expect(tokens["--ave-input-bar-placeholder"]).toBe(
      "hsla(225, 12%, 8%, 0.82)",
    );
    expect(tokens["--ave-input-bar-focus"]).toBe(tokens["--ave-ring"]);
    expect(tokens["--ave-input-bar-action"]).toBe(tokens["--ave-fg"]);
  });

  it("derives --ave-success-fg from the active bundle", () => {
    const tokens = bundleToPluginTokens(darkBundle);

    expect(tokens["--ave-success-fg"]).toBe("hsl(0, 0%, 100%)");
  });

  it("derives --ave-primary-bg-subtle correctly per shell mode", () => {
    const light = bundleToPluginTokens(lightBundle);
    const dark  = bundleToPluginTokens(darkBundle);
    const hc    = bundleToPluginTokens(contrastBundle);

    // light shell: primarySubtlePct = 14
    expect(light["--ave-primary-bg-subtle"]).toMatch(/color-mix\(in srgb,.*14%/);
    // dark shell: primarySubtlePct = 18
    expect(dark["--ave-primary-bg-subtle"]).toMatch(/color-mix\(in srgb,.*18%/);
    // high-contrast: primarySubtlePct = 24
    expect(hc["--ave-primary-bg-subtle"]).toMatch(/color-mix\(in srgb,.*24%/);
  });

  it("derives --ave-primary-bg-strong correctly per shell mode", () => {
    const light = bundleToPluginTokens(lightBundle);
    const dark  = bundleToPluginTokens(darkBundle);
    const hc    = bundleToPluginTokens(contrastBundle);

    // light: 28%, dark: 32%, hc: 40%
    expect(light["--ave-primary-bg-strong"]).toMatch(/color-mix\(in srgb,.*28%/);
    expect(dark["--ave-primary-bg-strong"]).toMatch(/color-mix\(in srgb,.*32%/);
    expect(hc["--ave-primary-bg-strong"]).toMatch(/color-mix\(in srgb,.*40%/);
  });

  it("derives --ave-surface-hover correctly per shell mode", () => {
    const light = bundleToPluginTokens(lightBundle);
    const dark  = bundleToPluginTokens(darkBundle);
    const hc    = bundleToPluginTokens(contrastBundle);

    // light: 6%, dark: 10%, hc: 14%
    expect(light["--ave-surface-hover"]).toMatch(/color-mix\(in srgb,.*6%/);
    expect(dark["--ave-surface-hover"]).toMatch(/color-mix\(in srgb,.*10%/);
    expect(hc["--ave-surface-hover"]).toMatch(/color-mix\(in srgb,.*14%/);
  });

  it("derives --ave-focus-shadow as ring-based color-mix at 62%", () => {
    const light = bundleToPluginTokens(lightBundle);
    const dark  = bundleToPluginTokens(darkBundle);
    const hc    = bundleToPluginTokens(contrastBundle);

    // focus-shadow is invariant to shell mode — always 62% ring over transparent
    expect(light["--ave-focus-shadow"]).toMatch(/color-mix\(in srgb,.*62%/);
    expect(dark["--ave-focus-shadow"]).toMatch(/color-mix\(in srgb,.*62%/);
    expect(hc["--ave-focus-shadow"]).toMatch(/color-mix\(in srgb,.*62%/);
  });
});
