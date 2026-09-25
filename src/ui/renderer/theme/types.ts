/**
 * Theme system v2 public types.
 *
 * The three-axis model (ThemePreference × ChatThemePreference × CodeThemePreference)
 * is replaced by a single paired bundle (`bundleId`). Each bundle is a fully-
 * specified set of shell + chat + code tokens — no combinatorial mismatches.
 *
 * `ThemeContextValue` exposes:
 *   - `bundleId`         — the active bundle id (e.g. "tokyo-night")
 *   - `setBundle`        — live-set the bundle + persist
 *   - `resolved`         — derived shell ("light" | "dark") from the active bundle (`ResolvedShell`)
 *   - `followSystem`     — auto-switch a theme and its declared pair with prefers-color-scheme
 *   - `canFollowSystem`  — whether the selected theme has a pair to switch with
 *   - `setFollowSystem`  — toggle followSystem
 *
 * Legacy type aliases (ThemePreference, ChatThemePreference, etc.) live in
 * `settings-store.ts` for the migration path only and are marked @internal.
 * New code should not import them — use bundleId exclusively.
 *
 * `resolved` is kept for backward compatibility with CustomTitleBar's
 * `optionalTheme.resolved` usage (maps to the active bundle's shell).
 */

/**
 * A bundle id as the renderer holds it before validation — settings and the
 * boot-time global can name a bundle that is not installed; `isThemeId`
 * checks its form, and a theme that is neither compiled in nor installed
 * falls back to the default bundle when it is resolved.
 */
export type UnvalidatedBundleId = string;

/** Derived shell color scheme from the active bundle. */
export type ResolvedShell = "light" | "dark";

export interface ThemeContextValue {
  /**
   * The user-configured bundle id (e.g. "moonstone" or an installed theme's name).
   * When `followSystem` is active this may differ from `effectiveBundleId`.
   */
  bundleId: UnvalidatedBundleId;
  /**
   * The bundle id actually applied to the DOM after resolving `followSystem`.
   * When `followSystem` is false this equals `bundleId`.
   * When `followSystem` is true and the selected theme has a pair, this is
   * whichever of the two matches the OS color scheme.
   */
  effectiveBundleId: UnvalidatedBundleId;
  /**
   * Live-set the active bundle. Updates the DOM immediately and persists
   * to `~/.ave/settings.json` via `api.updateSettings({ appearance: ... })`.
   */
  setBundle: (id: UnvalidatedBundleId) => void;
  /**
   * Shell color scheme derived from the active bundle's `shell` field.
   * Kept for backward compatibility (CustomTitleBar uses `optionalTheme.resolved`).
   */
  resolved: ResolvedShell;
  /** When true and the selected theme has a pair: switch between the two on OS scheme change. */
  followSystem: boolean;
  /** The selected theme declares a pair of the other shell that is available (`systemPairOf`). */
  canFollowSystem: boolean;
  /** Toggle followSystem persistence. Only meaningful while `canFollowSystem`. */
  setFollowSystem: (next: boolean) => void;
}
