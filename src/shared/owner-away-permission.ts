/** Zero keeps owner-away approval cards open until the owner answers. */
export const DEFAULT_OWNER_AWAY_AUTO_SKIP_MINUTES = 0;

export function isOwnerAwayAutoSkipMinutes(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
