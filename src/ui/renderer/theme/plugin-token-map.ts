import type { ThemeBundle } from "./bundles/index.js";
import type { AveTokenName } from "../../../shared/plugin-ui-tokens.js";

// Derives the full set of --ave-* CSS custom properties from an active ThemeBundle.
// Values are literal HSL strings so plugins can apply them without needing any of
// the host's --p-* palette or var() chain.
const _H = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;
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

// Theme-invariant tokens — same across all bundles.
//
// Values intentionally mirror `@ave/plugin-sdk/src/ui/tokens/fallback-dark.json`
// (the SDK's offline fallback SoT). Both must stay in lockstep so plugins
// see the same invariant tokens whether the host has broadcast yet or not.
// The drift gate is `__tests__/host-sdk-token-lockstep.test.ts`, which reads
// the SDK JSON via Node fs and asserts each key here matches. A direct
// JSON-subpath import was attempted but Vite/Rollup's resolver rejects
// non-JS subpath exports without a heavy SDK shim — the test-based gate is
// strictly equivalent operationally and avoids the bundler dance.
const _INVARIANT: Partial<Record<AveTokenName, string>> = {
  "--ave-radius-xs":       "0.15rem",
  "--ave-radius-lg":       "0.75rem",
  "--ave-radius-full":     "9999px",
  "--ave-text-xs":         "0.75rem",
  "--ave-text-sm":         "0.875rem",
  "--ave-text-base":       "1rem",
  "--ave-text-lg":         "1.125rem",
  "--ave-weight-normal":   "400",
  "--ave-weight-medium":   "500",
  "--ave-weight-semibold": "600",
  "--ave-space-1":         "0.25rem",
  "--ave-space-2":         "0.5rem",
  "--ave-space-3":         "0.75rem",
  "--ave-space-4":         "1rem",
  "--ave-motion-fast":     "150ms",
  "--ave-motion-normal":   "200ms",
};

/**
 * Internal export — single SoT for the invariant key list.
 *
 * The drift gate (`__tests__/host-sdk-token-lockstep.test.ts`) imports
 * this instead of hand-mirroring a parallel `INVARIANT_KEYS` array, so
 * adding a key to `_INVARIANT` automatically subjects it to the
 * lockstep check against `@ave/plugin-sdk/.../fallback-dark.json` —
 * no second list to keep in sync, no false-negative drift.
 */
export const _INVARIANT_KEYS = Object.keys(_INVARIANT) as AveTokenName[];

/**
 * Derive the full --ave-* plugin token map from an active ThemeBundle.
 *
 * Bundles are self-contained — no legacy axis resolution needed.
 */
export function bundleToPluginTokens(bundle: ThemeBundle): Record<AveTokenName, string> {
  const t = bundle.tokens;
  const bundleTokens: Partial<Record<AveTokenName, string>> = {
    "--ave-bg":              tripleToHsl(t.background),
    "--ave-surface":         tripleToHsl(t.card),
    "--ave-surface-overlay": tripleToHsl(t.popover),
    "--ave-fg":              tripleToHsl(t.foreground),
    "--ave-fg-muted":        tripleToHsl(t["muted-foreground"]),
    "--ave-fg-disabled":     tripleToHsl(t["muted-foreground"]),
    "--ave-primary":         tripleToHsl(t.primary),
    "--ave-primary-fg":      tripleToHsl(t["primary-foreground"]),
    "--ave-secondary":       tripleToHsl(t.secondary),
    "--ave-secondary-fg":    tripleToHsl(t["secondary-foreground"]),
    "--ave-danger":          tripleToHsl(t.destructive),
    "--ave-danger-fg":       tripleToHsl(t["destructive-foreground"]),
    "--ave-warning":         tripleToHsl(t.warning),
    "--ave-warning-fg":      tripleToHsl(t["warning-foreground"]),
    "--ave-success":         tripleToHsl(t.success),
    "--ave-success-fg":      _H(210, 40, 98),  // invariant — no component surfaces success-fg yet
    "--ave-border":          tripleToHsl(t.border),
    "--ave-ring":            tripleToHsl(t.ring),
    "--ave-radius":          "0.6rem",
    "--ave-radius-sm":       "0.25rem",
  };
  return { ..._INVARIANT, ...bundleTokens } as Record<AveTokenName, string>;
}

/**
 * @deprecated Use `bundleToPluginTokens(bundle)` instead.
 *
 * Legacy shim kept so existing callers (ThemeProvider tests that import
 * `resolvePluginTokens` from the barrel) continue to compile during the
 * transition. Will be removed in the next sprint.
 */
export { bundleToPluginTokens as resolvePluginTokens };
