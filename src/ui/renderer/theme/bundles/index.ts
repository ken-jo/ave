/**
 * Bundle registry: the bundles compiled into the app (`moonstone`, `gallery`)
 * and the installed theme packages (blueprint 3.2). Every other theme, the
 * fourteen the server marketplace delivered among them, is a theme package
 * under its own id (design §5.5).
 */
import type { ThemeBundle } from "./types.js";
import { moonstoneBundle } from "./moonstone.js";
import { galleryBundle } from "./gallery.js";
import {
  BUNDLE_IDS,
  DEFAULT_BUNDLE_ID as _SHARED_DEFAULT_BUNDLE_ID,
  isBundleId,
  type BundleId,
} from "../../../../shared/theme-bundles.js";

export type { ThemeBundle } from "./types.js";
export { BUNDLE_IDS } from "../../../../shared/theme-bundles.js";

const COMPILED_BUNDLES = Object.freeze({
  moonstone: moonstoneBundle,
  gallery: galleryBundle,
} satisfies Record<BundleId, ThemeBundle>);

/** The compiled bundles, in picker order. */
export const BUNDLES: readonly ThemeBundle[] = Object.freeze(BUNDLE_IDS.map((id) => COMPILED_BUNDLES[id]));

/**
 * Installed theme packages, keyed by package name. The installer refuses the
 * compiled ids, so the two never share one.
 */
let installedBundles = new Map<string, ThemeBundle>();

/** Replace the installed themes this renderer knows. */
export function setInstalledThemeBundles(bundles: readonly ThemeBundle[]): void {
  installedBundles = new Map(bundles.map((bundle) => [bundle.id, bundle]));
}

export const DEFAULT_BUNDLE_ID = _SHARED_DEFAULT_BUNDLE_ID;

/** A compiled bundle or an installed theme; undefined for an id neither provides. */
export function findBundle(id: string): ThemeBundle | undefined {
  return isBundleId(id) ? COMPILED_BUNDLES[id] : installedBundles.get(id);
}

/**
 * The theme `followSystem` alternates `bundle` with: its declared `pair`, when
 * that theme is available and has the other shell. Undefined otherwise, and
 * then `followSystem` has nothing to switch.
 */
export function systemPairOf(bundle: ThemeBundle): ThemeBundle | undefined {
  const pair = bundle.pair ? findBundle(bundle.pair) : undefined;
  return pair && pair.shell !== bundle.shell ? pair : undefined;
}

/** The themes the appearance picker lists: the compiled bundles, then the installed ones. */
export function visibleBundles(): ThemeBundle[] {
  return [...BUNDLES, ...installedBundles.values()];
}
