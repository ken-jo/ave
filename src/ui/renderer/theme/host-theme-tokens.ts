import type { AveTokenName } from "../../../shared/plugin-ui-tokens.js";
import type { ResolvedTheme } from "./types.js";

/** Only colors consumed by the embedded app host styling adapter. Typography stays in CSS. */
const HOST_TOKEN_SOURCES = {
  "--ave-bg": "background",
  "--ave-surface": "card",
  "--ave-surface-overlay": "popover",
  "--ave-fg": "foreground",
  "--ave-fg-muted": "muted-foreground",
  "--ave-fg-disabled": "muted-foreground",
  "--ave-border": "border",
  "--ave-primary": "primary",
  "--ave-primary-fg": "primary-foreground",
  "--ave-ring": "ring",
  "--ave-danger": "destructive",
  "--ave-danger-fg": "destructive-foreground",
  "--ave-warning": "warning",
  "--ave-warning-fg": "warning-foreground",
  "--ave-success": "success",
  "--ave-success-fg": "success-foreground",
} as const satisfies Partial<Record<AveTokenName, keyof ResolvedTheme["tokens"]>>;

export function schemeToHostTokens(theme: ResolvedTheme): Record<string, string> {
  return Object.fromEntries(Object.entries(HOST_TOKEN_SOURCES).map(([target, source]) => {
    const [h, s, l] = theme.tokens[source].split(" ");
    return [target, `hsl(${h}, ${s}, ${l})`];
  }));
}
