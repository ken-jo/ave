import { describe, expect, it } from "vitest";
import { DEFAULT_OWNER_AWAY_AUTO_SKIP_MINUTES, OWNER_AWAY_AUTO_SKIP_MAX_MINUTES, isOwnerAwayAutoSkipMinutes } from "../owner-away-permission.js";

describe("owner-away wait bounds", () => {
  it.each([0, 1, 60, 1440, 10080])("accepts integer minutes %s within one week", (minutes) => {
    expect(isOwnerAwayAutoSkipMinutes(minutes)).toBe(true);
  });

  it.each([-1, 0.5, 10081, Number.NaN, Number.POSITIVE_INFINITY, "10", null, undefined])("refuses invalid minutes %s", (minutes) => {
    expect(isOwnerAwayAutoSkipMinutes(minutes)).toBe(false);
  });

  it("keeps unlimited waiting as the default and exposes the generous ceiling", () => {
    expect(DEFAULT_OWNER_AWAY_AUTO_SKIP_MINUTES).toBe(0);
    expect(OWNER_AWAY_AUTO_SKIP_MAX_MINUTES).toBe(7 * 24 * 60);
  });
});
