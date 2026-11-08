import { describe, expect, it } from "vitest";
import { FONT_SIZE_SCALE_VALUES } from "../appearance-font.js";
import {
  BAND_EDGE_PAD,
  BAND_LEAD_PAD_DARWIN,
  BAND_LEAD_PAD_LINUX,
  CHROME_GAP_TIGHT,
  WINDOW_CONTROL_BUTTON_WIDTH,
  windowControlsPlacement,
  COLLAPSED_RAIL_RESERVE,
  CONTENT_TITLE_INSET,
  RAIL_CONTROL_REM,
  SHELL_GUTTER,
  DOCK_ENTER_WIDTH,
  DOCK_EXIT_WIDTH,
  MIN_DOCKED_TRANSCRIPT_WIDTH,
  PANE_MIN_WIDTH,
  SINGLE_TILE_ENTER_WIDTH,
  SINGLE_TILE_EXIT_WIDTH,
  RAIL_BAND_LEAD,
  sidebarPushThreshold,
} from "../shell-geometry.js";
import { SIDE_PANEL_MIN_RESERVE } from "../side-panel.js";

describe("responsive shell thresholds", () => {
  it("leaves room for both surface floors, a 60px tile return band and a 24px dock return band", () => {
    expect(SINGLE_TILE_ENTER_WIDTH).toBe(2 * PANE_MIN_WIDTH + SHELL_GUTTER);
    expect(DOCK_ENTER_WIDTH).toBe(SIDE_PANEL_MIN_RESERVE + MIN_DOCKED_TRANSCRIPT_WIDTH);
    expect(SINGLE_TILE_EXIT_WIDTH - SINGLE_TILE_ENTER_WIDTH).toBe(60);
    expect(DOCK_EXIT_WIDTH - DOCK_ENTER_WIDTH).toBe(24);
    // The rail's reserve, the list and the narrowest readable transcript.
    expect(sidebarPushThreshold(232)).toBe(68 + 232 + 320);
  });
});

/** Tie the source-readable rail reserve literal to title and band geometry. */
describe("shell geometry: collapsed rail reserve", () => {
  it("makes the rail card 52px wide between the card inset and one gutter", () => {
    expect(COLLAPSED_RAIL_RESERVE - SHELL_GUTTER * 2).toBe(52);
  });

  it("starts the rail-only band on the content title's line, past the darwin traffic lights", () => {
    expect(RAIL_BAND_LEAD).toBe(COLLAPSED_RAIL_RESERVE + CONTENT_TITLE_INSET);
    expect(RAIL_BAND_LEAD).toBeGreaterThanOrEqual(BAND_LEAD_PAD_DARWIN);
    expect(RAIL_BAND_LEAD).toBeGreaterThan(BAND_EDGE_PAD);
  });

  it("leaves the rail card room for its widest control at the largest font scale", () => {
    // The widest rail control must fit at the largest font scale; a merely positive width is insufficient.
    const widestRailControlPx = RAIL_CONTROL_REM * 16 * Math.max(...FONT_SIZE_SCALE_VALUES);
    expect(COLLAPSED_RAIL_RESERVE - SHELL_GUTTER * 2).toBeGreaterThanOrEqual(widestRailControlPx);
  });
});

describe("window controls placement", () => {
  it("leaves macOS its lights, trails on Windows and leads on Linux", () => {
    expect(windowControlsPlacement("darwin")).toBe("native");
    expect(windowControlsPlacement("win32")).toBe("trailing");
    expect(windowControlsPlacement("linux")).toBe("leading");
  });

  it("starts Linux band content past the three leading buttons by the same gap macOS leaves after its lights", () => {
    expect(BAND_LEAD_PAD_LINUX).toBe(WINDOW_CONTROL_BUTTON_WIDTH * 3 + CHROME_GAP_TIGHT);
    expect(BAND_LEAD_PAD_LINUX).toBe(136);
  });
});
