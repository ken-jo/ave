import { normalizeLocaleSetting, type Locale } from "../i18n/locale.js";
import { FONT_SIZE_SCALE_VALUES, isValidFontFamilyOverride, type FontSizeScale, type AppearanceFontSettings } from "./appearance-font.js";

export const DARK_SCHEME_IDS = ["github-dark", "gruvbox-dark", "catppuccin-mocha", "tokyo-night", "nord", "solarized-dark"] as const;
export const LIGHT_SCHEME_IDS = ["github-light", "gruvbox-light", "catppuccin-latte", "one-light", "solarized-light", "tokyo-night-day"] as const;
export type DarkSchemeId = (typeof DARK_SCHEME_IDS)[number];
export type LightSchemeId = (typeof LIGHT_SCHEME_IDS)[number];
export type AppearanceMode = "system" | "dark" | "light";
interface TerminalFontSettings { family: string; size: number; lineHeight: number }
export interface AppearanceSettings {
  schemaVersion: 3;
  mode: AppearanceMode;
  darkScheme: DarkSchemeId;
  lightScheme: LightSchemeId;
  font?: AppearanceFontSettings;
  terminalFont: TerminalFontSettings;
  language?: Locale;
  /** How much of the card colour covers the macOS window material, 0–100 (100 = opaque). Absent = {@link DEFAULT_GLASS_TINT}. */
  glassTint?: number;
}
const DEFAULT_TERMINAL_FONT: Readonly<TerminalFontSettings> = Object.freeze({
  family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", size: 12, lineHeight: 1.2,
});
export const DEFAULT_APPEARANCE: Readonly<AppearanceSettings> = Object.freeze({
  schemaVersion: 3, mode: "system", darkScheme: "github-dark", lightScheme: "github-light",
  terminalFont: DEFAULT_TERMINAL_FONT, language: "en",
});
/**
 * The glass tint is ONE user value that drives both shells: 0 is the most see-through tint that still keeps the sidebar's text
 * legible over the material, 100 is fully opaque. Each shell maps it linearly onto its own alpha range; the ranges are chosen so
 * the default lands on 0.75 (light) and 0.6 (dark), the values the owner picked from the prototype.
 */
export const GLASS_TINT_MIN = 0;
export const GLASS_TINT_MAX = 100;
export const DEFAULT_GLASS_TINT = 33;
const GLASS_TINT_ALPHA_FLOOR = { light: 0.625, dark: 0.4 } as const;

export function isGlassTint(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= GLASS_TINT_MIN && value <= GLASS_TINT_MAX;
}

/** The `--glass-tint-alpha` for a shell. The tint is clamped to its range, so the alpha never drops below the shell's floor. */
export function glassTintAlpha(tint: number, shell: "light" | "dark"): number {
  const t = Math.min(GLASS_TINT_MAX, Math.max(GLASS_TINT_MIN, tint)) / GLASS_TINT_MAX;
  const floor = GLASS_TINT_ALPHA_FLOOR[shell];
  return Math.round((floor + (1 - floor) * t) * 1000) / 1000;
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === "system" || value === "dark" || value === "light";
}
export function isDarkSchemeId(value: unknown): value is DarkSchemeId {
  return typeof value === "string" && (DARK_SCHEME_IDS as readonly string[]).includes(value);
}
export function isLightSchemeId(value: unknown): value is LightSchemeId {
  return typeof value === "string" && (LIGHT_SCHEME_IDS as readonly string[]).includes(value);
}
export function isTerminalFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 8 && value <= 32;
}
export function isTerminalLineHeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 2;
}

function isAppearanceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Retire released bundle selections once; current settings keep only the curated scheme contract. */
export function normalizeAppearance(input: unknown, warn: (field: string) => void = (field) => console.warn(`Invalid appearance setting: ${field}`)): AppearanceSettings {
  const obj = isAppearanceRecord(input) ? input : {};
  const result: AppearanceSettings = { ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont }, language: normalizeLocaleSetting(obj.language) };
  const font = normalizeAppearanceFont(obj.font);
  if (font) result.font = font;
  if (obj.schemaVersion === 2) {
    if (obj.bundleId === "moonstone" || obj.bundleId === "gallery") result.mode = "light";
    return result;
  }
  if (input !== undefined && obj.schemaVersion !== 3) warn("schemaVersion");
  if (isAppearanceMode(obj.mode)) result.mode = obj.mode;
  else if ("mode" in obj) warn("mode");
  if (isDarkSchemeId(obj.darkScheme)) result.darkScheme = obj.darkScheme;
  else if ("darkScheme" in obj) warn("darkScheme");
  if (isLightSchemeId(obj.lightScheme)) result.lightScheme = obj.lightScheme;
  else if ("lightScheme" in obj) warn("lightScheme");
  const terminalFont = isAppearanceRecord(obj.terminalFont) ? obj.terminalFont : {};
  if (isValidFontFamilyOverride(terminalFont.family)) result.terminalFont.family = terminalFont.family;
  if (isTerminalFontSize(terminalFont.size)) result.terminalFont.size = terminalFont.size;
  if (isTerminalLineHeight(terminalFont.lineHeight)) result.terminalFont.lineHeight = terminalFont.lineHeight;
  if (isGlassTint(obj.glassTint)) result.glassTint = obj.glassTint;
  else if ("glassTint" in obj) warn("glassTint");
  return result;
}

function normalizeAppearanceFont(input: unknown): AppearanceFontSettings | undefined {
  if (!isAppearanceRecord(input)) return undefined;
  const o = input;
  const out: AppearanceFontSettings = {};
  if (typeof o.family === "string") {
    if (o.family === "system") {
      out.family = "system";
    } else if (isValidFontFamilyOverride(o.family)) {
      out.family = o.family;
    }
  }
  if (typeof o.sizeScale === "number"
    && (FONT_SIZE_SCALE_VALUES as readonly number[]).includes(o.sizeScale)) {
    out.sizeScale = o.sizeScale as FontSizeScale;
  } else if (o.sizeScale === 1.25) {
    // Map the former largest font step to the new largest step rather than silently resetting it.
    out.sizeScale = FONT_SIZE_SCALE_VALUES[FONT_SIZE_SCALE_VALUES.length - 1]!;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
