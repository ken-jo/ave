/** Dependency-free guards share settings and pre-paint validation without loading privileged modules. */

/** Discrete scales keep settings usable; the standard scale matches the dense root typography. */
export const FONT_SIZE_SCALE_VALUES = [0.75, 0.875, 1, 1.125] as const;
export type FontSizeScale = (typeof FONT_SIZE_SCALE_VALUES)[number];
/** Keep the default scale aligned with the CSS fallback and settings label. */
export const FONT_SIZE_SCALE_DEFAULT: FontSizeScale = 0.875;

export interface AppearanceFontSettings {
  /** `"system"` = HOST_FONT_STACK default; otherwise a validated raw CSS font-family stack. */
  family?: "system" | string;
  sizeScale?: FontSizeScale;
}

const _FONT_FAMILY_RE = /^[\p{L}\p{N} ,"'_-]+$/u;
// Allow enough characters for the longest installed font name plus the host stack.
const _FONT_FAMILY_MAX = 256;

export function isValidFontFamilyOverride(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= _FONT_FAMILY_MAX
    && _FONT_FAMILY_RE.test(value);
}
