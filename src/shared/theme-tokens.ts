/** Derived color tokens use H S% L% triples for hsl(var(--token)). */

export const THEME_TOKEN_NAMES = [
  "background", "foreground",
  "card", "card-foreground",
  "popover", "popover-foreground",
  "primary", "primary-foreground",
  "secondary", "secondary-foreground",
  "muted", "muted-foreground",
  "accent", "accent-foreground",
  "destructive", "destructive-foreground",
  "warning", "warning-foreground",
  "success", "success-foreground",
  "info", "info-foreground",
  "emphasis",
  "border", "input", "ring", "ui-line",
  "message-user-bg", "message-user-fg",
  "input-bar-bg",
  "overlay",
  "focus-ring", "link-fg",
  "selection-bg", "selection-fg",
  "scrollbar-thumb", "scrollbar-track",
  "kbd-bg", "kbd-border",
  "code-bg", "code-fg", "code-border",
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
  "action-view", "action-branch", "action-compact",
] as const;

type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

export const THEME_SURFACE_NAMES = [
  "surface-sunken", "surface", "surface-raised", "surface-overlay",
  "border-subtle", "border-strong",
] as const;

type ThemeSurfaceName = (typeof THEME_SURFACE_NAMES)[number];
export type ThemeSurfaces = Record<ThemeSurfaceName, string>;
