/**
 * Host-owned plugin UI token contract.
 *
 * The app runtime is the source of truth for plugin theme payload validation
 * and theme token broadcasts.
 */
export const AVE_TOKEN_NAMES = [
  "--ave-bg",
  "--ave-surface",
  "--ave-surface-overlay",
  "--ave-fg",
  "--ave-fg-muted",
  "--ave-fg-disabled",
  "--ave-primary",
  "--ave-primary-fg",
  "--ave-secondary",
  "--ave-secondary-fg",
  "--ave-danger",
  "--ave-danger-fg",
  "--ave-warning",
  "--ave-warning-fg",
  "--ave-success",
  "--ave-success-fg",
  "--ave-border",
  "--ave-ring",
  "--ave-message-user-bg",
  "--ave-message-user-fg",
  "--ave-message-user-border",
  "--ave-message-user-muted",
  "--ave-message-user-action",
  "--ave-message-user-emphasis",
  "--ave-input-bar-bg",
  "--ave-input-bar-fg",
  "--ave-input-bar-placeholder",
  "--ave-input-bar-border",
  "--ave-input-bar-focus",
  "--ave-input-bar-subtle",
  "--ave-input-bar-action",
  // Derived tinted-surface tokens — pre-computed color-mix values shipped by the host.
  // Plugins use these directly instead of reinventing color-mix derivations.
  "--ave-danger-bg-subtle",
  "--ave-focus-shadow",
  "--ave-primary-bg-strong",
  "--ave-primary-bg-subtle",
  "--ave-success-bg-subtle",
  "--ave-surface-hover",
  "--ave-warning-bg-subtle",
  "--ave-radius-xs",
  "--ave-radius-sm",
  "--ave-radius",
  "--ave-radius-lg",
  "--ave-radius-full",
  "--ave-text-xs",
  "--ave-text-sm",
  "--ave-text-base",
  "--ave-text-lg",
  "--ave-text-micro",
  "--ave-text-caption",
  "--ave-text-body-sm",
  "--ave-text-body",
  "--ave-leading-micro",
  "--ave-leading-caption",
  "--ave-leading-body-sm",
  "--ave-leading-body",
  "--ave-tracking-micro",
  "--ave-tracking-caption",
  "--ave-tracking-body-sm",
  "--ave-tracking-body",
  "--ave-weight-normal",
  "--ave-weight-medium",
  "--ave-weight-semibold",
  "--ave-space-1",
  "--ave-space-2",
  "--ave-space-3",
  "--ave-space-4",
  "--ave-motion-fast",
  "--ave-motion-normal",
  "--ave-motion-slow",
  "--ave-motion-layout",
  "--ave-motion-ease-standard",
  "--ave-motion-ease-out",
  "--ave-motion-ease-in-out",
] as const;

export type AveTokenName = typeof AVE_TOKEN_NAMES[number];

export type AveTokenMap = { readonly [K in AveTokenName]: string };

/** @deprecated Use AveTokenMap instead. */
export type AveThemeTokens = AveTokenMap;

import { BUNDLE_IDS, isThemeId } from "./theme-bundles.js";

/**
 * A theme identifier: a bundle compiled into the host
 * ({@link AVE_THEME_BUNDLE_IDS}) or the name of an installed theme package.
 * Every other theme, the ones the host used to compile in among them, is a
 * package under its own name.
 */
export type AveThemeBundleId = string;

/**
 * The bundles compiled into the host, copied from the canonical list in
 * `theme-bundles.ts` (used by settings-store, plugins IPC and the renderer).
 * This re-export exists so that the Plugin SDK — which syncs this file via
 * `bun run sync:from-host` — can expose the list under the stable public name
 * `AVE_THEME_BUNDLE_IDS` without duplicating the array. Installed theme
 * packages add ids this list does not name.
 *
 * Spread + `Object.freeze` produces an immutable copy so that mutations
 * (e.g. `push`, `splice`) on this export cannot affect the canonical
 * `BUNDLE_IDS` array in `theme-bundles.ts`.
 */
export const AVE_THEME_BUNDLE_IDS: readonly AveThemeBundleId[] = Object.freeze([...BUNDLE_IDS]);

/**
 * Whether `id` has the form of a theme identifier: a compiled bundle id or a
 * theme package name. Accepts `unknown` at the boundary so callers need not
 * pre-cast IPC payloads or deserialized objects before validating.
 *
 */
export function isAveThemeBundleId(id: unknown): id is AveThemeBundleId {
  return isThemeId(id);
}

/**
 * AveHostThemeEvent v2 — broadcast by the host on every theme change.
 *
 * **v2 migration**: legacy fields `colorScheme`, `reducedMotion`, and `fonts`
 * (previously on `AveThemePayload`) have been removed. Use `bundleId` + `shell`
 * instead.
 *
 * Emitted on the `"host.theme.changed"` event bus channel.
 */
export interface AveHostThemeEvent {
  /** Active theme: a compiled bundle id or an installed theme package name (e.g. `"moonstone"`, `"tokyo-night"`). */
  bundleId: AveThemeBundleId;
  /** Shell color mode of the active bundle. */
  shell: "light" | "dark";
  /** Resolved CSS custom property values for the active bundle. */
  tokens: AveTokenMap;
}

/**
 * @deprecated v2 SDK consumers — use {@link AveHostThemeEvent} instead.
 *
 * Legacy standalone payload type. Preserves the old contract exactly:
 * only `bundleId` (as `string`), `colorScheme`, `reducedMotion`, and `fonts`.
 * Does **not** extend `AveHostThemeEvent` — `shell` and `tokens` are NOT
 * part of this type, so SDK ≤ v4 consumers that pass
 * `{ bundleId: "...", colorScheme: "dark" }` continue to compile without error.
 *
 * v2 SDK consumers: use {@link AveHostThemeEvent} directly.
 * Migration: replace all `AveThemePayload` usages with `AveHostThemeEvent`.
 * These deprecated fields will be removed in a future cleanup PR.
 */
export interface AveThemePayload {
  /**
   * Active theme bundle identifier. Use {@link isAveThemeBundleId} to
   * validate at runtime boundaries.
   *
   * @deprecated Migrate to {@link AveHostThemeEvent}.
   */
  bundleId: string;
  /**
   * @deprecated No longer emitted by the host. Use `bundleId` + `shell`.
   * Only `"light" | "dark"` — matches host `validateThemePayload` accept range.
   * `"system"` is NOT part of the legacy contract and will be rejected by the host.
   */
  colorScheme?: "light" | "dark";
  /** @deprecated No longer emitted by the host. */
  reducedMotion?: boolean;
  /** @deprecated No longer emitted by the host. */
  fonts?: { family: string };
}
