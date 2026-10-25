/** One paired bundle owns shell, chat and code tokens; system following is available only for a declared pair. */

/**
 * A bundle id as the renderer holds it before validation — settings and the
 * boot-time global can name a bundle that is not installed; `isThemeId`
 * checks its form, and a theme that is neither compiled in nor installed
 * falls back to the default bundle when it is resolved.
 */
import type { ThemeBundle } from "./bundles/types.js";

export type UnvalidatedBundleId = string;

/** Derived shell color scheme from the active bundle. */
export type ResolvedShell = "light" | "dark";

export interface ThemeContextValue {
  /** The user-configured bundle id (e.g. "moonstone" or an installed theme's name). When `followSystem` is active this may
   * differ from `effectiveBundleId`. */
  bundleId: UnvalidatedBundleId;
  /**
   * The bundle id actually applied to the DOM after resolving `followSystem`.
   * When `followSystem` is false this equals `bundleId`.
   * When `followSystem` is true and the selected theme has a pair, this is
   * whichever of the two matches the OS color scheme.
   */
  effectiveBundleId: UnvalidatedBundleId;
  /** Live-set the active bundle. Updates the DOM immediately and persists to `~/.ave/config/settings.json` via `api.updateSettings({
   * appearance: ... })`. */
  setBundle: (id: UnvalidatedBundleId) => void;
  /** Shell color scheme derived from the active bundle's `shell` field. Kept for backward compatibility (CustomTitleBar uses
   * `optionalTheme.resolved`). */
  resolved: ResolvedShell;
  /** When true and the selected theme has a pair: switch between the two on OS scheme change. */
  followSystem: boolean;
  /** The selected theme declares a pair of the other shell that is available (`systemPairOf`). */
  canFollowSystem: boolean;
  /** Toggle followSystem persistence. Only meaningful while `canFollowSystem`. */
  setFollowSystem: (next: boolean) => void;
  /**
   * Changes each time a theme's values have been written to `:root` — a
   * different theme, the other side of a pair, or the same theme updated in
   * place. Bumped after the write, so a consumer that copies theme values
   * (into a canvas, a native title bar, an MCP app, another window) and lists
   * this in its effect reads the new values, never the ones being replaced.
   */
  appliedRevision: number;
  /**
   * The theme whose values `:root` holds, set with `appliedRevision`. A
   * consumer that copies a theme's shell and tokens takes both from this, so
   * it never pairs one theme's shell with another's tokens while a switch is
   * on its way (`resolved` and `effectiveBundleId` change before the write).
   */
  appliedBundle: ThemeBundle;
}
