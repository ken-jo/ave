/** Zero keeps owner-away approval cards open until the owner answers. */
export const DEFAULT_OWNER_AWAY_AUTO_SKIP_MINUTES = 0;
export const OWNER_AWAY_AUTO_SKIP_MAX_MINUTES = 10080;

export function isOwnerAwayAutoSkipMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= OWNER_AWAY_AUTO_SKIP_MAX_MINUTES;
}
