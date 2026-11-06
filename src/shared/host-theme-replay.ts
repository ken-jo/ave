import { isDarkSchemeId, isLightSchemeId } from "./appearance-settings.js";
import { AVE_TOKEN_NAMES } from "./plugin-ui-tokens.js";

export type SafeThemePayload = {
  bundleId: string;
  shell: "light" | "dark";
  tokens?: Record<string, string>;
};

const PLUGIN_TOKEN_NAMES: Set<string> = new Set(AVE_TOKEN_NAMES);
// Accept only token shapes emitted by the scheme token projection; rejected values leave the plugin fallback in place.
// Allow colors, one non-nested color mix, lengths, weights, and durations; reject URLs and trailing function calls.
const _HSL = String.raw`hsla?\(\s*-?\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)`;
const _HEX = String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})`;
const _COLOR = `(?:${_HSL}|${_HEX}|transparent)`;
// String.raw preserves regex backslashes.
const _COLOR_MIX = String.raw`color-mix\(in srgb,\s*${_COLOR}\s+\d+(?:\.\d+)?%\s*,\s*${_COLOR}\s*\)`;
const _LENGTH = String.raw`\d+(?:\.\d+)?(?:rem|em|px|%)`;
const _WEIGHT = String.raw`[1-9]00`;
const _DURATION = String.raw`\d+(?:\.\d+)?ms`;
// Easing tokens use four numbers in 0..1; bundled curves do not overshoot.
const _NUM = String.raw`-?\d+(?:\.\d+)?`;
const _EASING = String.raw`cubic-bezier\(\s*${_NUM}\s*,\s*${_NUM}\s*,\s*${_NUM}\s*,\s*${_NUM}\s*\)`;
const SAFE_TOKEN_VALUE = new RegExp(
  `^(?:${_COLOR}|${_COLOR_MIX}|${_LENGTH}|${_WEIGHT}|${_DURATION}|${_EASING})$`,
);

let lastThemePayload: SafeThemePayload | null = null;

/** Replay the last validated theme to late webviews; null leaves their fallback active until the first broadcast. */

export function cloneThemePayload(payload: SafeThemePayload): SafeThemePayload {
  const clone: SafeThemePayload = {
    bundleId: payload.bundleId,
    shell: payload.shell,
  };
  if (payload.tokens) clone.tokens = Object.freeze({ ...payload.tokens }) as Record<string, string>;
  return Object.freeze(clone);
}

export function getLastThemePayload(): SafeThemePayload | null {
  return lastThemePayload ? cloneThemePayload(lastThemePayload) : null;
}

export function validateThemePayload(payload: unknown):
  | { ok: true; safe: SafeThemePayload }
  | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid-payload" };
  const candidate = payload as Record<string, unknown>;
  const { bundleId, shell } = candidate;
  if (!isDarkSchemeId(bundleId) && !isLightSchemeId(bundleId)) return { ok: false, error: "invalid-bundle-id" };
  // The scheme's own mode is the only shell it may be announced with.
  if ((shell !== "dark" && shell !== "light") || (shell === "dark") !== isDarkSchemeId(bundleId)) {
    return { ok: false, error: "invalid-shell" };
  }
  if (!candidate.tokens || typeof candidate.tokens !== "object" || Array.isArray(candidate.tokens)) {
    return { ok: false, error: "missing-tokens" };
  }
  const safe: SafeThemePayload = { bundleId, shell };
  const safeTokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate.tokens as Record<string, unknown>)) {
    if (PLUGIN_TOKEN_NAMES.has(key) && typeof value === "string" && SAFE_TOKEN_VALUE.test(value)) {
      safeTokens[key] = value;
    }
  }
  safe.tokens = safeTokens;
  // Fonts are host-owned and do not belong in the replay payload.
  return { ok: true, safe };
}

export function recordValidatedTheme(payload: unknown):
  | { ok: true; safe: SafeThemePayload }
  | { ok: false; error: string } {
  // Invalid input must leave the last known-good payload intact.
  const result = validateThemePayload(payload);
  if (!result.ok) return result;
  const safe = cloneThemePayload(result.safe);
  lastThemePayload = safe;
  return { ok: true, safe };
}

export function resetLastThemePayloadForTests(): void {
  lastThemePayload = null;
}
