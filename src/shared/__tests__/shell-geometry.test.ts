import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_SIZE_SCALE_VALUES } from "../appearance-font.js";
import {
  BAND_EDGE_PAD,
  BAND_LEAD_PAD_DARWIN,
  BAND_LEAD_PAD_LINUX,
  CHROME_GAP_TIGHT,
  WINDOW_CONTROL_BUTTON_WIDTH,
  windowControlsPlacement,
  COLLAPSED_RAIL_EDGE,
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

  it("starts the rail-only band on the content title's line past the rail", () => {
    expect(CONTENT_TITLE_INSET).toBe(CHROME_GAP_TIGHT + SHELL_GUTTER);
    expect(RAIL_BAND_LEAD).toBe(72);
    expect(RAIL_BAND_LEAD).toBeGreaterThan(BAND_EDGE_PAD);
    // The traffic lights end past the title line; CustomTitleBar's darwin floor keeps the path clear of them.
    expect(BAND_LEAD_PAD_DARWIN).toBeGreaterThan(RAIL_BAND_LEAD);
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

describe("shell card top (styles.css)", () => {
  // The band above the sidebar card holds the macOS lights and the Linux leading buttons; a card that starts inside the band
  // covers them. Read the stylesheet itself so a return to a shallow literal (the old 6px) goes red.
  const css = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  function declared(name: string): string {
    const values = [...css.matchAll(new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;}]+)`, "gm"))].map((match) => match[1].trim());
    expect(values, `${name} must be declared exactly once`).toHaveLength(1);
    return values[0];
  }
  function px(name: string): number {
    const value = declared(name);
    const literal = /^(\d+(?:\.\d+)?)px$/.exec(value);
    if (literal) return Number(literal[1]);
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    if (alias) return px(alias[1]);
    // calc() of var() terms joined by + or -, the only shape the shell tokens use.
    const calculation = /^calc\((.*)\)$/.exec(value);
    if (!calculation) throw new Error(`${name}: unsupported value ${value}`);
    const terms = /^\s*var\((--[\w-]+)\)((?:\s*[+-]\s*var\(--[\w-]+\))*)\s*$/.exec(calculation[1]);
    if (!terms) throw new Error(`${name}: unsupported calc ${value}`);
    let total = px(terms[1]);
    for (const [, sign, term] of terms[2].matchAll(/([+-])\s*var\((--[\w-]+)\)/g)) total += (sign === "+" ? 1 : -1) * px(term);
    return total;
  }

  it("starts the sidebar card at or below the window band on every platform", () => {
    expect(px("--shell-card-top")).toBeGreaterThanOrEqual(px("--chrome-band-height"));
    expect(css).not.toMatch(/--shell-card-top-darwin/);
  });

  it("puts the rail-only content edge on the rail card's trailing edge", () => {
    expect(px("--shell-collapsed-rail-edge")).toBe(px("--shell-card-inset") + px("--shell-collapsed-rail-width"));
    expect(px("--shell-collapsed-rail-edge")).toBe(COLLAPSED_RAIL_EDGE);
    expect(COLLAPSED_RAIL_EDGE).toBe(60);
  });

  it("derives the canvas origin from the shared card top and the cell half-gutter", () => {
    expect(px("--shell-canvas-top") + px("--chrome-gap-tight")).toBe(px("--shell-card-top"));
    expect(px("--shell-canvas-top")).toBeGreaterThanOrEqual(px("--chrome-band-height"));
  });
});
