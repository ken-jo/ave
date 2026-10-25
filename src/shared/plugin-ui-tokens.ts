/** The app runtime owns plugin theme validation and broadcasts. */
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
  // Host-derived tinted surfaces let plugins use the same color mixes.
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

/** A compiled bundle ID or an installed theme package name. */
export type AveThemeBundleId = string;

/** Freeze a copy so consumers cannot mutate the canonical bundle list; installed packages add IDs outside this list. */
export const AVE_THEME_BUNDLE_IDS: readonly AveThemeBundleId[] = Object.freeze([...BUNDLE_IDS]);

export function isAveThemeBundleId(id: unknown): id is AveThemeBundleId {
  return isThemeId(id);
}

/** Broadcast on host.theme.changed; bundleId and shell carry theme identity and mode. */
export interface AveHostThemeEvent {
  bundleId: AveThemeBundleId;
  shell: "light" | "dark";
  tokens: AveTokenMap;
}

/** @deprecated Use AveHostThemeEvent. This standalone legacy type retains only bundleId, colorScheme, reducedMotion, and fonts. */
export interface AveThemePayload {
  bundleId: string;
  /** @deprecated No longer emitted. Legacy colorScheme accepts light or dark; system is rejected. */
  colorScheme?: "light" | "dark";
  /** @deprecated No longer emitted by the host. */
  reducedMotion?: boolean;
  /** @deprecated No longer emitted by the host. */
  fonts?: { family: string };
}
