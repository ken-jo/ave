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
}
const DEFAULT_TERMINAL_FONT: Readonly<TerminalFontSettings> = Object.freeze({
  family: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", size: 12, lineHeight: 1.2,
});
export const DEFAULT_APPEARANCE: Readonly<AppearanceSettings> = Object.freeze({
  schemaVersion: 3, mode: "system", darkScheme: "github-dark", lightScheme: "github-light",
  terminalFont: DEFAULT_TERMINAL_FONT, language: "en",
});
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
export function normalizeAppearance(input: unknown): AppearanceSettings {
  const obj = isAppearanceRecord(input) ? input : {};
  const result: AppearanceSettings = { ...DEFAULT_APPEARANCE, terminalFont: { ...DEFAULT_APPEARANCE.terminalFont }, language: normalizeLocaleSetting(obj.language) };
  const font = normalizeAppearanceFont(obj.font);
  if (font) result.font = font;
  if (obj.schemaVersion !== 3) return result;
  if (isAppearanceMode(obj.mode)) result.mode = obj.mode;
  if (isDarkSchemeId(obj.darkScheme)) result.darkScheme = obj.darkScheme;
  if (isLightSchemeId(obj.lightScheme)) result.lightScheme = obj.lightScheme;
  const terminalFont = isAppearanceRecord(obj.terminalFont) ? obj.terminalFont : {};
  if (isValidFontFamilyOverride(terminalFont.family)) result.terminalFont.family = terminalFont.family;
  if (isTerminalFontSize(terminalFont.size)) result.terminalFont.size = terminalFont.size;
  if (isTerminalLineHeight(terminalFont.lineHeight)) result.terminalFont.lineHeight = terminalFont.lineHeight;
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
