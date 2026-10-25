/** Bound background and plugin output only; foreground chat keeps the user-selected ceiling. */
export const MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT = 16_384;

/** Validate positive integer shape without a transport-wide ceiling; callers apply their own limits. */
export function normalizeOutputTokenLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

/** Clamp background and plugin work to the host ceiling after validating its shape. */
export function clampBackgroundOutputTokenLimit(
  value: number | undefined,
): number | undefined {
  const normalized = normalizeOutputTokenLimit(value);
  return normalized === undefined
    ? undefined
    : Math.min(normalized, MAX_BACKGROUND_OUTPUT_TOKEN_LIMIT);
}
