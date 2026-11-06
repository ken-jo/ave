import { AVE_TOKEN_NAMES, type AveTokenName } from "../../../shared/plugin-ui-tokens.js";
import type { ResolvedTheme } from "./types.js";
import { STATIC_DESIGN_TOKENS } from "./design-tokens.js";

const COLOR_TOKEN_SOURCES = {
  "--ave-bg": "background", "--ave-surface": "card", "--ave-surface-overlay": "popover",
  "--ave-fg": "foreground", "--ave-fg-muted": "muted-foreground", "--ave-fg-disabled": "muted-foreground",
  "--ave-primary": "primary", "--ave-primary-fg": "primary-foreground",
  "--ave-secondary": "secondary", "--ave-secondary-fg": "secondary-foreground",
  "--ave-danger": "destructive", "--ave-danger-fg": "destructive-foreground",
  "--ave-warning": "warning", "--ave-warning-fg": "warning-foreground",
  "--ave-success": "success", "--ave-success-fg": "success-foreground",
  "--ave-border": "border", "--ave-ring": "ring",
  "--ave-message-user-bg": "message-user-bg", "--ave-message-user-fg": "message-user-fg",
  "--ave-message-user-border": "message-user-fg", "--ave-message-user-muted": "message-user-fg",
  "--ave-message-user-action": "message-user-fg", "--ave-message-user-emphasis": "message-user-fg",
  "--ave-input-bar-bg": "input-bar-bg", "--ave-input-bar-fg": "foreground",
  "--ave-input-bar-border": "ui-line", "--ave-input-bar-focus": "ring",
  "--ave-input-bar-subtle": "muted", "--ave-input-bar-action": "foreground",
} as const satisfies Partial<Record<AveTokenName, keyof ResolvedTheme["tokens"]>>;

const STATIC_TOKEN_SOURCES = {
  "--ave-radius-xs": "--shape-radius-xs", "--ave-radius-sm": "--shape-radius-sm", "--ave-radius": "--radius",
  "--ave-radius-lg": "--shape-radius-lg", "--ave-radius-full": "--shape-radius-full",
  "--ave-text-xs": "--type-size-12", "--ave-text-sm": "--type-size-14", "--ave-text-base": "--type-size-16", "--ave-text-lg": "--type-size-18",
  "--ave-text-micro": "--type-size-12", "--ave-text-caption": "--type-size-12", "--ave-text-body-sm": "--type-size-14", "--ave-text-body": "--type-size-16",
  "--ave-leading-micro": "--type-leading-16", "--ave-leading-caption": "--type-leading-18", "--ave-leading-body-sm": "--type-leading-20", "--ave-leading-body": "--type-leading-24",
  "--ave-tracking-micro": "--type-tracking-wide", "--ave-tracking-caption": "--type-tracking-normal", "--ave-tracking-body-sm": "--type-tracking-normal", "--ave-tracking-body": "--type-tracking-normal",
  "--ave-weight-normal": "--type-weight-normal", "--ave-weight-medium": "--type-weight-medium", "--ave-weight-semibold": "--type-weight-semibold",
  "--ave-space-1": "--space-1", "--ave-space-2": "--space-2", "--ave-space-3": "--space-3", "--ave-space-4": "--space-4",
  "--ave-motion-fast": "--motion-fast", "--ave-motion-normal": "--motion-normal", "--ave-motion-slow": "--motion-slow", "--ave-motion-layout": "--motion-layout",
  "--ave-motion-ease-standard": "--motion-ease-standard", "--ave-motion-ease-out": "--motion-ease-out", "--ave-motion-ease-in-out": "--motion-ease-in-out",
} as const satisfies Partial<Record<AveTokenName, keyof typeof STATIC_DESIGN_TOKENS>>;

export function schemeToHostTokens(theme: ResolvedTheme): Record<string, string> {
  const colors = Object.fromEntries(Object.entries(COLOR_TOKEN_SOURCES).map(([target, source]) => {
    const [h, s, l] = theme.tokens[source].split(" ");
    return [target, `hsl(${h}, ${s}, ${l})`];
  }));
  const mix = (color: string, base: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, ${base})`;
  const subtle = theme.shell === "light" ? 14 : 18;
  const tokens = {
    ...colors,
    ...Object.fromEntries(Object.entries(STATIC_TOKEN_SOURCES).map(([target, source]) => [target, STATIC_DESIGN_TOKENS[source]])),
    "--ave-input-bar-placeholder": `hsla(${theme.tokens.foreground.split(" ").join(", ")}, 0.82)`,
    "--ave-primary-bg-subtle": mix(colors["--ave-primary"]!, colors["--ave-surface"]!, subtle),
    "--ave-primary-bg-strong": mix(colors["--ave-primary"]!, colors["--ave-surface"]!, theme.shell === "light" ? 28 : 32),
    "--ave-danger-bg-subtle": mix(colors["--ave-danger"]!, "transparent", 14),
    "--ave-warning-bg-subtle": mix(colors["--ave-warning"]!, "transparent", 14),
    "--ave-success-bg-subtle": mix(colors["--ave-success"]!, "transparent", 14),
    "--ave-surface-hover": mix(colors["--ave-fg"]!, colors["--ave-secondary"]!, theme.shell === "light" ? 6 : 10),
    "--ave-focus-shadow": mix(colors["--ave-ring"]!, "transparent", 62),
  };
  for (const key of AVE_TOKEN_NAMES) if (!(key in tokens)) throw new Error(`Missing host style token: ${key}`);
  return tokens as Record<AveTokenName, string>;
}
