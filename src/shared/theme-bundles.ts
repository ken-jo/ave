/**
 * §C3 (M1): Single source of truth for all valid bundle IDs.
 *
 * Previously three independent hard-coded lists existed:
 *   - `src/ui/renderer/theme/bundles/index.ts`  (BUNDLES array)
 *   - `src/data/settings-store.ts`               (VALID_BUNDLE_IDS)
 *   - `src/ipc/domains/plugins.ts`               (ALLOWED_BUNDLE_IDS)
 *
 * Any drift between these three would allow an unknown bundleId through one
 * gate while being rejected by another. Centralizing here closes that gap.
 *
 * NOTE: This module is imported by both the main process (settings-store,
 * plugins IPC) and the renderer process (theme/bundles/index). Keep it
 * free of process-specific imports (electron, node:fs, etc.).
 */

/**
 * The bundles compiled into the app. Every other theme is an installed theme
 * package (design §5.5): the fourteen bundles the server marketplace
 * delivered ship as packages under their own ids, so a selection keeps its
 * name.
 */
export const BUNDLE_IDS = Object.freeze(["moonstone", "gallery"] as const);

export type BundleId = (typeof BUNDLE_IDS)[number];

const BUNDLE_ID_SET = new Set<string>(BUNDLE_IDS);

export function isBundleId(value: unknown): value is BundleId {
  return typeof value === "string" && BUNDLE_ID_SET.has(value);
}

export const DEFAULT_BUNDLE_ID: BundleId = "moonstone";

const THEME_ID = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;

/**
 * A value `appearance.bundleId` may hold: a compiled-in bundle id or the name
 * of a theme package (the descriptor's package-name rule, which every
 * compiled-in id also satisfies). Whether that theme is installed is decided
 * where it is applied; one that is not falls back to the default bundle.
 */
export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 64 && THEME_ID.test(value);
}
