// Attribution and licenses: resources/licenses/appearance/NOTICE.
import type { AppearanceSettings } from "../../../shared/appearance-settings.js";
import { FONT_SIZE_SCALE_DEFAULT } from "../../../shared/appearance-font.js";
import { THEME_TOKEN_NAMES, THEME_SURFACE_NAMES } from "../../../shared/theme-tokens.js";
import type { ThemeTokens, ThemeSurfaces } from "../../../shared/theme-tokens.js";
import { hexToOklch, mixOklch, oklchToHex } from "./oklch.js";
import { requireScheme } from "./schemes/index.js";
import { STATIC_DESIGN_TOKENS } from "./design-tokens.js";
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

/** Keep the hue while finding the nearest lightness that clears every surface. */
function readableColor(color: string, surfaces: readonly string[], minimum: number, light: boolean, label: string): string {
  const source = hexToOklch(color);
  const ink = (l: number) => oklchToHex({ ...source, l });
  const worst = (l: number) => Math.min(...surfaces.map((surface) => contrastRatio(ink(l), surface)));
  let fails = source.l;
  let passes = light ? 1 : 0;
  if (worst(fails) >= minimum + 0.01) return ink(fails);
  if (worst(passes) < minimum + 0.01) throw new Error(`Color cannot reach required contrast: ${label}`);
  for (let i = 0; i < 24; i++) {
    const middle = (fails + passes) / 2;
    if (worst(middle) >= minimum + 0.01) passes = middle;
    else fails = middle;
  }
  const result = ink(passes);
  if (surfaces.some((surface) => contrastRatio(result, surface) < minimum)) throw new Error(`Color contrast failed: ${label}`);
  return result;
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
  const muted = readableColor(ink(dark ? 0.708 : 0.523), surfaces, 4.5, dark, `${scheme.id}/muted`);
  const status = Object.fromEntries(Object.entries({ destructive: palette.red, warning: palette.yellow, success: palette.green, info: palette.blue, emphasis: palette.yellow })
    .map(([key, color]) => [key, readableColor(color, surfaces, 4.5, dark, `${scheme.id}/${key}`)]));
  const uiLine = readableColor(mix(dark ? 0.54 : 0.52), surfaces, 3, dark, `${scheme.id}/ui-line`);
  const selectionForeground = readableColor(foreground, [palette.selectionBackground], 4.5,
    contrastRatio("#ffffff", palette.selectionBackground) > contrastRatio("#000000", palette.selectionBackground), `${scheme.id}/selection`);
  const readableOn = (color: string) => contrastRatio("#ffffff", color) >= contrastRatio("#111111", color) ? "#ffffff" : "#111111";
  const border = mix(0.18), strong = mix(0.32);
  const colors: Record<string, string> = {
    ...surfaceHex,
    foreground, "card-foreground": foreground, "popover-foreground": foreground,
    primary: foreground, "primary-foreground": palette.background,
    "secondary-foreground": foreground, "muted-foreground": muted, "accent-foreground": foreground,
    destructive: status.destructive!, "destructive-foreground": readableOn(status.destructive!),
    warning: status.warning!, "warning-foreground": readableOn(status.warning!),
    success: status.success!, "success-foreground": readableOn(status.success!),
    info: status.info!, "info-foreground": readableOn(status.info!),
    emphasis: status.emphasis!, "emphasis-foreground": readableOn(status.emphasis!),
    border, input: border, ring: foreground, "ui-line": uiLine,
    "message-user-fg": foreground, overlay: "#000000", "hover-overlay": foreground,
    "focus-ring": foreground, "link-fg": foreground,
    "selection-bg": palette.selectionBackground, "selection-fg": selectionForeground,
    "scrollbar-thumb": strong, "scrollbar-track": palette.background,
    "kbd-bg": mix(0.065), "kbd-border": border, "code-fg": foreground, "code-border": border,
    "chart-1": palette.blue, "chart-2": palette.green, "chart-3": palette.magenta, "chart-4": palette.yellow, "chart-5": palette.red,
    "action-view": palette.magenta, "action-branch": palette.yellow, "action-compact": palette.blue,
    "border-subtle": mix(0.10), "border-strong": strong,
  };
  for (const state of ["success", "destructive"]) {
    for (const surface of surfaces) {
      const washed = "#" + [1, 3, 5].map((offset) => Math.round(
        Number.parseInt(colors[state]!.slice(offset, offset + 2), 16) * 0.15
        + Number.parseInt(surface.slice(offset, offset + 2), 16) * 0.85,
      ).toString(16).padStart(2, "0")).join("");
      if (contrastRatio(foreground, washed) < 4.5) throw new Error(`Unreadable diff text: ${scheme.id}/${state}`);
    }
  }
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
  for (const [name, value] of Object.entries(STATIC_DESIGN_TOKENS)) root.style.setProperty(name, value);
  for (const [name, value] of Object.entries({ ...theme.tokens, ...theme.surfaces })) root.style.setProperty(`--${name}`, value);
  const family = appearance.font?.family;
  if (family && family !== "system") root.style.setProperty("--ave-font-family", family);
  else root.style.removeProperty("--ave-font-family");
  root.style.setProperty("--ave-font-size-scale", String(appearance.font?.sizeScale ?? FONT_SIZE_SCALE_DEFAULT));
  return theme;
}
