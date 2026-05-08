/**
 * Host-owned plugin UI token contract.
 *
 * The app runtime is the source of truth for plugin theme payload validation
 * and theme token broadcasts. The SDK copies this module into its public
 * `@ave/plugin-sdk/ui/tokens` surface via `bun run sync:from-host`.
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
  "--ave-radius-xs",
  "--ave-radius-sm",
  "--ave-radius",
  "--ave-radius-lg",
  "--ave-radius-full",
  "--ave-text-xs",
  "--ave-text-sm",
  "--ave-text-base",
  "--ave-text-lg",
  "--ave-weight-normal",
  "--ave-weight-medium",
  "--ave-weight-semibold",
  "--ave-space-1",
  "--ave-space-2",
  "--ave-space-3",
  "--ave-space-4",
  "--ave-motion-fast",
  "--ave-motion-normal",
] as const;

export type AveTokenName = typeof AVE_TOKEN_NAMES[number];

export type AveTokenMap = { readonly [K in AveTokenName]: string };

/** @deprecated Use AveTokenMap instead. */
export type AveThemeTokens = AveTokenMap;

/**
 * CSS-only static tokens — defined in the SDK fallback stylesheet as offline
 * defaults, but not sent over IPC because their value syntax is broader than
 * the host's safe token-value allowlist.
 */
export const AVE_CSS_ONLY_TOKEN_NAMES = [
  "--ave-shadow-sm",
  "--ave-shadow-md",
  "--ave-easing",
] as const;

export type AveCssOnlyTokenName = typeof AVE_CSS_ONLY_TOKEN_NAMES[number];

export interface AveThemePayload {
  bundleId: string;
  shell: "light" | "dark";
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
  fonts?: { family: string };
  tokens: AveTokenMap;
}
