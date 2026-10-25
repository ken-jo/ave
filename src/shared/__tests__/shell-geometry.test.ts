import { describe, expect, it } from "vitest";
import { FONT_SIZE_SCALE_VALUES } from "../appearance-font.js";
import {
  BAND_EDGE_PAD,
  BAND_LEAD_PAD_DARWIN,
  CHROME_GAP_HAIR,
  CHROME_GAP_TIGHT,
  CHROME_ICON_BUTTON,
  CLUSTER_LEAD_PAD_DARWIN,
  COLLAPSED_RAIL_RESERVE,
  CONTENT_TITLE_INSET,
  RAIL_CONTROL_REM,
  SHELL_GUTTER,
  collapsedBandLeadClearance,
} from "../shell-geometry.js";

/** Tie the source-readable rail reserve literal to title and band geometry. */
describe("shell geometry: collapsed rail reserve", () => {
  it("puts the collapsed content title exactly on the darwin band's lead line", () => {
    expect(COLLAPSED_RAIL_RESERVE + CONTENT_TITLE_INSET).toBe(BAND_LEAD_PAD_DARWIN);
  });

  it("leaves the rail card room for its widest control at the largest font scale", () => {
    // The widest rail control must fit at the largest font scale; a merely positive width is insufficient.
    const widestRailControlPx = RAIL_CONTROL_REM * 16 * Math.max(...FONT_SIZE_SCALE_VALUES);
    expect(COLLAPSED_RAIL_RESERVE - SHELL_GUTTER * 2).toBeGreaterThanOrEqual(widestRailControlPx);
  });
});

/** Collapsed-band paths must start after the bare sidebar control strip. */
describe("shell geometry: collapsed band lead clearance", () => {
  const stripRun = 4 * CHROME_ICON_BUTTON + 3 * CHROME_GAP_HAIR;

  it("clears the four-control strip by one gutter on darwin, past the traffic lights", () => {
    const firstButtonX = SHELL_GUTTER + CLUSTER_LEAD_PAD_DARWIN;
    expect(collapsedBandLeadClearance(true)).toBe(firstButtonX + stripRun + SHELL_GUTTER);
    // Stay past the band lead pad so its clamp cannot put the path back under controls.
    expect(collapsedBandLeadClearance(true)).toBeGreaterThan(BAND_LEAD_PAD_DARWIN);
  });

  it("clears the strip from the card inset plus its tight pad elsewhere", () => {
    const firstButtonX = SHELL_GUTTER + CHROME_GAP_TIGHT;
    expect(collapsedBandLeadClearance(false)).toBe(firstButtonX + stripRun + SHELL_GUTTER);
    expect(collapsedBandLeadClearance(false)).toBeGreaterThan(BAND_EDGE_PAD);
  });
});
