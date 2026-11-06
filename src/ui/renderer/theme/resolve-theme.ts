// Color mixing and contrast bisection adapted under NOTICE and LICENSE-APACHE.
import type { AppearanceSettings } from "../../../shared/appearance-settings.js";
import { FONT_SIZE_SCALE_DEFAULT } from "../../../shared/appearance-font.js";
import { THEME_TOKEN_NAMES, THEME_SURFACE_NAMES } from "../../../shared/theme-tokens.js";
import type { ThemeTokens, ThemeSurfaces } from "../../../shared/theme-tokens.js";
import { hexToOklch, mixOklch, oklchToHex } from "./oklch.js";
import { requireScheme } from "./schemes/index.js";
import type { ColorScheme, ResolvedTheme } from "./types.js";

/** Relative luminance contrast of concrete sRGB colors. */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const linear = (offset: number) => {
      const v = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(1) + 0.7152 * linear(3) + 0.0722 * linear(5);
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** HSL triples preserve the existing alpha-aware CSS utility contract. */
function hexToTriple(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const light = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  let hue = delta === 0 ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + 360) % 360;
  return `${hue.toFixed(4)} ${(saturation * 100).toFixed(4)}% ${(light * 100).toFixed(4)}%`;
}

export function resolveTheme(scheme: ColorScheme): ResolvedTheme {
  const dark = scheme.shell === "dark";
  const palette = scheme.terminal;
  const bg = hexToOklch(palette.background), fg = hexToOklch(palette.foreground);
  const mix = (t: number) => oklchToHex(mixOklch(bg, fg, t));
  const surfaceHex = {
    background: palette.background,
    card: mix(0.025),
    popover: mix(0.055),
    muted: mix(0.065),
    secondary: mix(0.075),
    accent: mix(0.10),
    "message-user-bg": mix(0.10),
    "input-bar-bg": mix(0.025),
    "code-bg": mix(0.025),
    "surface-sunken": mix(0.015),
    surface: mix(0.025),
    "surface-raised": mix(0.045),
    "surface-overlay": mix(0.055),
  };
  const ink = (lightness: number) => oklchToHex({ l: lightness, c: Math.min(fg.c, 0.012), h: fg.h });
  const foreground = ink(dark ? 0.985 : 0.16);
  const surfaces = Object.values(surfaceHex);
  const worst = (l: number) => Math.min(...surfaces.map((surface) => contrastRatio(ink(l), surface)));
  let fails = dark ? 0.708 : 0.523;
  let passes = dark ? 0.985 : 0.16;
  if (worst(passes) < 4.5) throw new Error(`Color scheme has unreadable surfaces: ${scheme.id}`);
  if (worst(fails) >= 4.5) passes = fails;
  else for (let i = 0; i < 20; i++) {
    const middle = (fails + passes) / 2;
    if (worst(middle) >= 4.51) passes = middle;
    else fails = middle;
  }
  const muted = ink(passes);
  const readableOn = (color: string) => contrastRatio("#ffffff", color) >= contrastRatio("#111111", color) ? "#ffffff" : "#111111";
  const border = mix(0.18), strong = mix(0.32);
  const colors: Record<string, string> = {
    ...surfaceHex,
    foreground, "card-foreground": foreground, "popover-foreground": foreground,
    primary: foreground, "primary-foreground": palette.background,
    "secondary-foreground": foreground, "muted-foreground": muted, "accent-foreground": foreground,
    destructive: palette.red, "destructive-foreground": readableOn(palette.red),
    warning: palette.yellow, "warning-foreground": readableOn(palette.yellow),
    success: palette.green, "success-foreground": readableOn(palette.green),
    info: palette.blue, "info-foreground": readableOn(palette.blue),
    emphasis: palette.yellow, "emphasis-foreground": readableOn(palette.yellow),
    border, input: border, ring: foreground, "ui-line": mix(dark ? 0.54 : 0.52),
    "message-user-fg": foreground, overlay: "#000000", "hover-overlay": foreground,
    "focus-ring": foreground, "link-fg": foreground,
    "selection-bg": palette.selectionBackground, "selection-fg": foreground,
    "scrollbar-thumb": strong, "scrollbar-track": palette.background,
    "kbd-bg": mix(0.065), "kbd-border": border, "code-fg": foreground, "code-border": border,
    "chart-1": palette.blue, "chart-2": palette.green, "chart-3": palette.magenta, "chart-4": palette.yellow, "chart-5": palette.red,
    "action-view": palette.magenta, "action-branch": palette.yellow, "action-compact": palette.blue,
    "border-subtle": mix(0.10), "border-strong": strong,
  };
  return {
    id: scheme.id, shell: scheme.shell, terminal: palette,
    tokens: Object.fromEntries(THEME_TOKEN_NAMES.map((name) => [name, hexToTriple(colors[name]!)])) as ThemeTokens,
    surfaces: Object.fromEntries(THEME_SURFACE_NAMES.map((name) => [name, hexToTriple(colors[name]!)])) as ThemeSurfaces,
  };
}

export function resolveAppearanceScheme(appearance: AppearanceSettings, prefersDark: boolean): ColorScheme {
  const shell = appearance.mode === "system" ? (prefersDark ? "dark" : "light") : appearance.mode;
  const scheme = requireScheme(shell === "dark" ? appearance.darkScheme : appearance.lightScheme);
  if (scheme.shell !== shell) throw new Error(`Color scheme does not match mode: ${scheme.id}`);
  return scheme;
}

/** The single pre-paint and live-update path for colors and UI fonts. */
export function applyAppearance(appearance: AppearanceSettings, doc: Document = document, prefersDark = doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false): ResolvedTheme {
  const theme = resolveTheme(resolveAppearanceScheme(appearance, prefersDark));
  const root = doc.documentElement;
  root.setAttribute("data-scheme", theme.id);
  root.setAttribute("data-shell", theme.shell);
  root.style.colorScheme = theme.shell;
  for (const [name, value] of Object.entries({ ...theme.tokens, ...theme.surfaces })) root.style.setProperty(`--${name}`, value);
  const family = appearance.font?.family;
  if (family && family !== "system") root.style.setProperty("--ave-font-family", family);
  else root.style.removeProperty("--ave-font-family");
  root.style.setProperty("--ave-font-size-scale", String(appearance.font?.sizeScale ?? FONT_SIZE_SCALE_DEFAULT));
  return theme;
}
