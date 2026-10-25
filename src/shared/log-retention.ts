/** Share default and accepted retention range between pruning and settings without filesystem dependencies. */

export const LOG_RETENTION_DAYS = 7;

export const LOG_RETENTION_MIN_DAYS = 1;

export const LOG_RETENTION_MAX_DAYS = 365;

/** Clamp valid integers; malformed values use the default so pruning never receives a nonsensical window. */
export function clampLogRetentionDays(value: number): number {
  if (!Number.isInteger(value)) return LOG_RETENTION_DAYS;
  return Math.min(LOG_RETENTION_MAX_DAYS, Math.max(LOG_RETENTION_MIN_DAYS, value));
}
