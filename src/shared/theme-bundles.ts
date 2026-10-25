/** Main and renderer share bundle validation; keep this module free of process-specific imports. */

/** Only these bundles are compiled in; other themes are installed packages retaining their own IDs. */
export const BUNDLE_IDS = Object.freeze(["moonstone", "gallery"] as const);

export type BundleId = (typeof BUNDLE_IDS)[number];

const BUNDLE_ID_SET = new Set<string>(BUNDLE_IDS);

export function isBundleId(value: unknown): value is BundleId {
  return typeof value === "string" && BUNDLE_ID_SET.has(value);
}

export const DEFAULT_BUNDLE_ID: BundleId = "moonstone";

const THEME_ID = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;

/** This checks identifier shape, not installation; unavailable themes fall back at application time. */
export function isThemeId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 64 && THEME_ID.test(value);
}
