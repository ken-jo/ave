import type { ThemeBundle } from "./bundles/index.js";
import type { AveTokenName } from "../../../shared/plugin-ui-tokens.js";

// Derives the full set of --ave-* CSS custom properties from an active ThemeBundle.
// Values are literal HSL strings so plugins can apply them without needing any of
// the host's --p-* palette or var() chain.
// Tailwind alpha syntax: "H S% L% / A" or "H S% L% / A%". Capture alpha
// optionally so bundle tokens that opt into translucent values still wrap to a
// valid `hsl()` for plugin webviews (which cannot consume bare triples).
const _HSL_RE = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%(?:\s*\/\s*(\d+(?:\.\d+)?%?))?$/;

/**
 * Convert an HSL triple string ("H S% L%" or "H S% L% / A%") to a CSS
 * `hsl(H, S%, L%)` / `hsla(H, S%, L%, A%)` value. Bundle tokens are stored as
 * bare HSL triples (Tailwind format); plugin webviews need the full wrapper.
 */
function tripleToHsl(triple: string): string {
  const m = _HSL_RE.exec(triple.trim());
  if (!m) return triple; // already formatted or raw value
  if (m[4] === undefined) return `hsl(${m[1]}, ${m[2]}%, ${m[3]}%)`;
  return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, ${m[4]})`;
}

function tripleToHslWithAlpha(triple: string, alpha: number): string {
  const m = _HSL_RE.exec(triple.trim());
  if (!m) return tripleToHsl(triple);
  return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, ${alpha})`;
}

// Theme-invariant tokens — same across all bundles.
//
// These values reach plugin webviews via the primed token payload that
// `main.ts:initialThemeArgs` ships on every `BrowserWindow` (commit 1696f92).
// The host owns the broadcast values; plugins supply
// their own CSS fallback before the first payload arrives.
const _INVARIANT: Partial<Record<AveTokenName, string>> = {
  "--ave-radius-xs":       "0.15rem",
  "--ave-radius-lg":       "0.75rem",
  "--ave-radius-full":     "9999px",
  "--ave-text-xs":         "0.75rem",
  "--ave-text-sm":         "0.875rem",
  "--ave-text-base":       "1rem",
  "--ave-text-lg":         "1.125rem",
  "--ave-text-micro":      "0.75rem",
  "--ave-text-caption":    "0.75rem",
  "--ave-text-body-sm":    "0.875rem",
  "--ave-text-body":       "1rem",
  "--ave-leading-micro":   "1rem",
  "--ave-leading-caption": "1.125rem",
  "--ave-leading-body-sm": "1.25rem",
  "--ave-leading-body":    "1.5rem",
  "--ave-tracking-micro":  "0.015em",
  "--ave-tracking-caption":"0em",
  "--ave-tracking-body-sm":"0em",
  "--ave-tracking-body":   "0em",
  "--ave-weight-normal":   "400",
  "--ave-weight-medium":   "500",
  "--ave-weight-semibold": "600",
  "--ave-space-1":         "0.25rem",
  "--ave-space-2":         "0.5rem",
  "--ave-space-3":         "0.75rem",
  "--ave-space-4":         "1rem",
  "--ave-motion-fast":     "120ms",
  "--ave-motion-normal":   "180ms",
  "--ave-motion-slow":     "240ms",
  "--ave-motion-layout":   "300ms",
  "--ave-motion-ease-standard": "cubic-bezier(0.2, 0, 0, 1)",
  "--ave-motion-ease-out":      "cubic-bezier(0.22, 1, 0.36, 1)",
  "--ave-motion-ease-in-out":   "cubic-bezier(0.4, 0, 0.2, 1)",
};

/**
 * Build a color-mix() tinted surface value.
 *
 * @param color  - Resolved CSS color for the tint (e.g. `hsl(217, 91%, 60%)`)
 * @param base   - Resolved CSS color for the base surface (e.g. `hsl(222, 84%, 5%)`)
 * @param pct    - Percentage of `color` to mix in (remainder is `base`)
 */
function _tint(color: string, base: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, ${base})`;
}

/**
 * Derive the full --ave-* plugin token map from an active ThemeBundle.
 *
 * Bundles are self-contained — no legacy axis resolution needed.
 */
export function bundleToPluginTokens(bundle: ThemeBundle): Record<AveTokenName, string> {
  const t = bundle.tokens;
  const isLight = bundle.shell === "light";
  const isHighContrast = bundle.highContrast;

  // Resolved base colors reused for derivations.
  const primary   = tripleToHsl(t.primary);
  const surface   = tripleToHsl(t.card);
  const danger    = tripleToHsl(t.destructive);
  const warning   = tripleToHsl(t.warning);
  const success   = tripleToHsl(t.success);
  const secondary = tripleToHsl(t.secondary);
  const fg        = tripleToHsl(t.foreground);
  const ring      = tripleToHsl(t.ring);
  const userBg    = tripleToHsl(t["message-user-bg"]);
  const userFg    = tripleToHsl(t["message-user-fg"]);
  const inputBg   = tripleToHsl(t["input-bar-bg"]);
  const inputPlaceholder = tripleToHslWithAlpha(t.foreground, 0.82);
  const inputBorder = tripleToHsl(t["ui-line"]);
  const inputSubtle = tripleToHsl(t.muted);

  // Mix percentages scale by shell mode and high-contrast requirement.
  // AA contrast on dark surfaces; HC bundle bumps mix to 24/40 for elevated contrast over body background.
  const primarySubtlePct = isHighContrast ? 24 : isLight ? 14 : 18;
  const primaryStrongPct = isHighContrast ? 40 : isLight ? 28 : 32;
  const statusSubtlePct  = isHighContrast ? 24 : 14;
  const hoverPct         = isHighContrast ? 14 : isLight ?  6 : 10;

  const bundleTokens: Partial<Record<AveTokenName, string>> = {
    "--ave-bg":              tripleToHsl(t.background),
    "--ave-surface":         surface,
    "--ave-surface-overlay": tripleToHsl(t.popover),
    "--ave-fg":              fg,
    "--ave-fg-muted":        tripleToHsl(t["muted-foreground"]),
    "--ave-fg-disabled":     tripleToHsl(t["muted-foreground"]),
    "--ave-primary":         primary,
    "--ave-primary-fg":      tripleToHsl(t["primary-foreground"]),
    "--ave-secondary":       secondary,
    "--ave-secondary-fg":    tripleToHsl(t["secondary-foreground"]),
    "--ave-danger":          danger,
    "--ave-danger-fg":       tripleToHsl(t["destructive-foreground"]),
    "--ave-warning":         warning,
    "--ave-warning-fg":      tripleToHsl(t["warning-foreground"]),
    "--ave-success":         success,
    "--ave-success-fg":      tripleToHsl(t["success-foreground"]),
    "--ave-border":          tripleToHsl(t.border),
    "--ave-ring":            ring,
    "--ave-message-user-bg":       userBg,
    "--ave-message-user-fg":       userFg,
    "--ave-message-user-border":   userFg,
    "--ave-message-user-muted":    userFg,
    "--ave-message-user-action":   userFg,
    "--ave-message-user-emphasis": userFg,
    "--ave-input-bar-bg":          inputBg,
    "--ave-input-bar-fg":          fg,
    "--ave-input-bar-placeholder": inputPlaceholder,
    "--ave-input-bar-border":      inputBorder,
    "--ave-input-bar-focus":       ring,
    "--ave-input-bar-subtle":      inputSubtle,
    "--ave-input-bar-action":      fg,
    "--ave-radius":          "0.6rem",
    "--ave-radius-sm":       "0.25rem",
    // ── Derived tinted-surface tokens ────────────────────────────────────────
    // Pre-computed so plugins use var(--ave-primary-bg-subtle) instead of
    // reinventing color-mix() across --pm-*, --accent-bg, --ah-* namespaces.
    "--ave-primary-bg-subtle":  _tint(primary, surface, primarySubtlePct),
    "--ave-primary-bg-strong":  _tint(primary, surface, primaryStrongPct),
    "--ave-danger-bg-subtle":   _tint(danger,  "transparent", statusSubtlePct),
    "--ave-warning-bg-subtle":  _tint(warning, "transparent", statusSubtlePct),
    "--ave-success-bg-subtle":  _tint(success, "transparent", statusSubtlePct),
    "--ave-surface-hover":      _tint(fg, secondary, hoverPct),
    "--ave-focus-shadow":       _tint(ring, "transparent", 62),
  };
  return { ..._INVARIANT, ...bundleTokens } as Record<AveTokenName, string>;
}
