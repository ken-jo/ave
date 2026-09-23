/**
 * Theme token contract shared by the compiled-in bundles, the theme package
 * installer (design §5.2, blueprint 3.2) and the renderer.
 *
 * Every token is an `H S% L%` triple: the renderer writes it into
 * `hsl(var(--token))`, so a value in any other form either paints nothing or
 * carries text into a CSS declaration. The contrast rules are the ones the
 * compiled-in bundles are held to; an installed theme that fails one is
 * refused at install.
 *
 * No runtime imports: the main process, the renderer and the tests load it.
 */

export const THEME_TOKEN_NAMES = [
  /* Tier B — semantic shell */
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
  /* Tier B' — status / state */
  "info", "info-foreground",
  "emphasis", "emphasis-foreground",
  "border", "input", "ring", "ui-line",
  "message-user-bg", "message-user-fg",
  "input-bar-bg",
  /* Tier B'' — surface overlay + interaction */
  "overlay", "hover-overlay",
  "focus-ring", "link-fg",
  /* Tier B''' — peripheral system */
  "selection-bg", "selection-fg",
  "scrollbar-thumb", "scrollbar-track",
  "kbd-bg", "kbd-border",
  /* Tier C — code surface */
  "code-bg", "code-fg", "code-border",
  /* Tier D — chart palette */
  "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
  /* Action tokens */
  "action-view", "action-branch", "action-compact",
] as const;

type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;

const HSL_TRIPLE = /^(\d{1,3}(?:\.\d{1,4})?) (\d{1,3}(?:\.\d{1,4})?)% (\d{1,3}(?:\.\d{1,4})?)%$/u;

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** `"H S% L%"` with H in [0, 360], S and L in [0, 100]; null for anything else. */
function parseHslTriple(value: string): Hsl | null {
  const match = HSL_TRIPLE.exec(value);
  if (!match) return null;
  const [h, s, l] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (h > 360 || s > 100 || l > 100) return null;
  return { h, s, l };
}

type Rgb = [number, number, number];

function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const hue = h % 360;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let r = 0, g = 0, b = 0;
  if (hue < 60) { r = c; g = x; }
  else if (hue < 120) { r = x; g = c; }
  else if (hue < 180) { g = c; b = x; }
  else if (hue < 240) { g = x; b = c; }
  else if (hue < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** WCAG 2.x relative luminance of an sRGB colour (0–255 channels). */
function relativeLuminance(rgb: Rgb): number {
  const lin = (channel: number): number => {
    const cs = channel / 255;
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blend(overlay: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return overlay.map((channel, index) => channel * alpha + backdrop[index]! * (1 - alpha)) as Rgb;
}

export interface ThemeContrastRule {
  /** What the rule measures, for a failure message. */
  label: string;
  minimum: number;
  ratio(tokens: ThemeTokens): number;
}

function pair(background: ThemeTokenName, foreground: ThemeTokenName, minimum: number): ThemeContrastRule {
  return {
    label: `${background} ↔ ${foreground}`,
    minimum,
    ratio: (tokens) => contrastRatio(rgbOf(tokens, background), rgbOf(tokens, foreground)),
  };
}

function rgbOf(tokens: ThemeTokens, name: ThemeTokenName): Rgb {
  const hsl = parseHslTriple(tokens[name]);
  if (!hsl) throw new Error(`${name} is not an "H S% L%" triple: ${tokens[name]}`);
  return hslToRgb(hsl);
}

/** Share of a state colour washed over the background behind a diff hunk. */
const DIFF_WASH_ALPHA = 0.15;

/**
 * Body text needs WCAG AA (4.5); buttons, chips and badges carry short,
 * heavier labels and need AA Large (3.0); the visible UI line is a non-text
 * element (3.0); diff hunk text sits on a translucent state wash (4.5).
 */
export const THEME_CONTRAST_RULES: readonly ThemeContrastRule[] = Object.freeze([
  pair("background", "foreground", 4.5),
  pair("card", "card-foreground", 4.5),
  pair("popover", "popover-foreground", 4.5),
  pair("muted", "muted-foreground", 4.5),
  pair("message-user-bg", "message-user-fg", 4.5),
  pair("primary", "primary-foreground", 3),
  pair("secondary", "secondary-foreground", 3),
  pair("destructive", "destructive-foreground", 3),
  pair("accent", "accent-foreground", 3),
  pair("warning", "warning-foreground", 3),
  pair("success", "success-foreground", 3),
  pair("info", "info-foreground", 3),
  pair("emphasis", "emphasis-foreground", 3),
  pair("background", "ui-line", 3),
  pair("input-bar-bg", "ui-line", 3),
  ...(["success", "destructive"] as const).map((state): ThemeContrastRule => ({
    label: `foreground over the ${state} diff wash`,
    minimum: 4.5,
    ratio: (tokens) => contrastRatio(blend(rgbOf(tokens, state), rgbOf(tokens, "background"), DIFF_WASH_ALPHA), rgbOf(tokens, "foreground")),
  })),
]);

/**
 * Every problem with `value` as a token set: missing, unknown or malformed
 * tokens first (contrast is not measured over those), then each contrast
 * rule it fails. Empty when the tokens are usable.
 */
export function themeTokenProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["tokens must be an object"];
  const record = value as Record<string, unknown>;
  const known = new Set<string>(THEME_TOKEN_NAMES);
  const problems: string[] = [];
  for (const name of Object.keys(record)) {
    if (!known.has(name)) problems.push(`unknown token ${name}`);
  }
  for (const name of THEME_TOKEN_NAMES) {
    const token = record[name];
    if (token === undefined) problems.push(`missing token ${name}`);
    else if (typeof token !== "string" || !parseHslTriple(token)) problems.push(`${name} is not an "H S% L%" triple`);
  }
  if (problems.length > 0) return problems;
  const tokens = record as ThemeTokens;
  for (const rule of THEME_CONTRAST_RULES) {
    const ratio = rule.ratio(tokens);
    if (ratio < rule.minimum) problems.push(`${rule.label} contrast ${ratio.toFixed(2)} is under ${rule.minimum}`);
  }
  return problems;
}

/**
 * The depth ladder a compiled bundle declares in its `styles.css` block
 * besides its tokens: the surface elevation rungs and the border split. An
 * installed theme declares them in `theme.json` (`surfaces`), as triples.
 */
export const THEME_SURFACE_NAMES = [
  "surface-sunken", "surface", "surface-raised", "surface-overlay",
  "border-subtle", "border-strong",
] as const;

type ThemeSurfaceName = (typeof THEME_SURFACE_NAMES)[number];
export type ThemeSurfaces = Record<ThemeSurfaceName, string>;

/** Every problem with `value` as a surface set: missing, unknown or malformed entries. */
export function themeSurfaceProblems(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["surfaces must be an object"];
  const record = value as Record<string, unknown>;
  const known = new Set<string>(THEME_SURFACE_NAMES);
  const problems = Object.keys(record).filter((name) => !known.has(name)).map((name) => `unknown surface ${name}`);
  for (const name of THEME_SURFACE_NAMES) {
    const surface = record[name];
    if (surface === undefined) problems.push(`missing surface ${name}`);
    else if (typeof surface !== "string" || !parseHslTriple(surface)) problems.push(`surface ${name} is not an "H S% L%" triple`);
  }
  return problems;
}

/**
 * Elevation shadows by shell: the stacks every compiled light and dark bundle
 * uses (light: soft layered greys; dark: deeper drop plus an inset top-edge
 * highlight). An installed theme takes its shell's stack; the shadows read
 * the theme's own `--overlay`.
 */
const SHELL_SHADOWS: Readonly<Record<"light" | "dark", Readonly<Record<string, string>>>> = Object.freeze({
  light: Object.freeze({
    "shadow-e1": "0 1px 2px hsl(var(--overlay) / 0.06), 0 1px 1px hsl(var(--overlay) / 0.04)",
    "shadow-e2": "0 2px 4px hsl(var(--overlay) / 0.06), 0 4px 12px hsl(var(--overlay) / 0.06)",
    "shadow-e3": "0 8px 24px hsl(var(--overlay) / 0.1), 0 2px 6px hsl(var(--overlay) / 0.06)",
    "shadow-e4": "0 16px 48px hsl(var(--overlay) / 0.14), 0 4px 12px hsl(var(--overlay) / 0.08)",
  }),
  dark: Object.freeze({
    "shadow-e1": "inset 0 1px 0 hsl(0 0% 100% / 0.04), 0 1px 2px hsl(var(--overlay) / 0.5), 0 1px 1px hsl(var(--overlay) / 0.4)",
    "shadow-e2": "inset 0 1px 0 hsl(0 0% 100% / 0.04), 0 2px 4px hsl(var(--overlay) / 0.5), 0 4px 10px hsl(var(--overlay) / 0.4)",
    "shadow-e3": "inset 0 1px 0 hsl(0 0% 100% / 0.05), 0 8px 24px hsl(var(--overlay) / 0.5), 0 2px 6px hsl(var(--overlay) / 0.4)",
    "shadow-e4": "inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 16px 48px hsl(var(--overlay) / 0.6), 0 4px 12px hsl(var(--overlay) / 0.45)",
  }),
});

/**
 * The CSS custom properties an installed theme sets on `:root`, where a
 * compiled bundle's `styles.css` block would: its tokens, its surfaces, its
 * shell's shadows. Values are the validated triples and the fixed stacks
 * above, never text from the package.
 */
export function installedThemeCustomProperties(theme: { shell: "light" | "dark"; tokens: ThemeTokens; surfaces: ThemeSurfaces }): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const name of THEME_TOKEN_NAMES) properties[`--${name}`] = theme.tokens[name];
  for (const name of THEME_SURFACE_NAMES) properties[`--${name}`] = theme.surfaces[name];
  for (const [name, value] of Object.entries(SHELL_SHADOWS[theme.shell])) properties[`--${name}`] = value;
  return properties;
}
