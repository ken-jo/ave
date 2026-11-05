/** Main and renderer share device-pixel geometry; controls aligned to OS window buttons must not scale with user type size. */

/** Opening size and minimum size remain independently settable even when equal; renderer docking and collapse thresholds share these bounds. */
export const MAIN_WINDOW_WIDTH = 1243;
export const MAIN_WINDOW_HEIGHT = 768;
export const MAIN_WINDOW_MIN_WIDTH = 360;
export const MAIN_WINDOW_MIN_HEIGHT = 640;

/** Keep button position aligned with the chrome band and control centers. */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 12 } as const;

const TRAFFIC_LIGHT_CLUSTER_RUN = 58;

const TRAFFIC_LIGHT_RIGHT_EDGE = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_CLUSTER_RUN;

/** px value of `--chrome-gap-tight` in src/styles.css. */
export const CHROME_GAP_TIGHT = 4;

/** Share the card/content gutter with --chrome-gap and --shell-card-inset in CSS. */
export const SHELL_GUTTER = 8;

/** Surface floors and responsive thresholds are shared with the CSS container variants. */
export const PANE_MIN_WIDTH = 448;
export const MIN_DOCKED_TRANSCRIPT_WIDTH = 320;
export const NARROW_DEAD_BAND_PX = 60;
export const DOCK_ENTER_WIDTH = 784;
/**
 * The side panel's own hysteresis, narrower than `NARROW_DEAD_BAND_PX`. Since the rail took 60px of the window (Sidebar E),
 * a 1100px window with a 200px list leaves an 812px tile: wide enough to dock (784), but under a 60px band's exit (844), so a
 * window widened to 1100 would keep the panel floating. 24px still stops a resize jitter from flapping it.
 */
const DOCK_DEAD_BAND_PX = 24;
export const DOCK_EXIT_WIDTH = DOCK_ENTER_WIDTH + DOCK_DEAD_BAND_PX;
export const SINGLE_TILE_ENTER_WIDTH = 904;
export const SINGLE_TILE_EXIT_WIDTH = SINGLE_TILE_ENTER_WIDTH + NARROW_DEAD_BAND_PX;
export const SETTINGS_NARROW_ENTER_WIDTH = 640;
export const SETTINGS_NARROW_EXIT_WIDTH = SETTINGS_NARROW_ENTER_WIDTH + NARROW_DEAD_BAND_PX;

/** Expanded navigation overlays when the rail, the list and a readable content column do not all fit. */
export function sidebarPushThreshold(sidebarWidth: number): number {
  return COLLAPSED_RAIL_RESERVE + sidebarWidth + MIN_DOCKED_TRANSCRIPT_WIDTH;
}

/** Files need readable tree and detail columns; narrower workspaces use tree-to-detail navigation. */
export const FILE_WORKSPACE_COLUMNS_MIN_WIDTH = 520;

/** Window controls sit flush on win/linux, so those bands must not add trailing padding. */
export const BAND_EDGE_PAD = 12;

/** Measured from the window edge, past the native buttons and their gap. */
export const BAND_LEAD_PAD_DARWIN = TRAFFIC_LIGHT_RIGHT_EDGE + CHROME_GAP_TIGHT;

/** Content titles begin two gutters from the card edge, matching the band label above. */
export const CONTENT_TITLE_INSET = SHELL_GUTTER * 2;

/** What the content reserves on its leading edge for the rail: the card inset, the 52px rail card and one gutter. Keep the CSS
 * mirror aligned; the literal is consumed by the source-reading gate. */
export const COLLAPSED_RAIL_RESERVE = 68;

/** The band's lead while only the rail shows: the content title's line past the rail. On darwin the rail starts below the band,
 * and this lead also clears the native buttons. */
export const RAIL_BAND_LEAD = COLLAPSED_RAIL_RESERVE + CONTENT_TITLE_INSET;

/** The widest rail control must fit the reserve at the largest supported font scale. */
export const RAIL_CONTROL_REM = 2.25;

/** Keep the literal utility classes in source so the CSS scanner discovers them. */
export const RAIL_CONTROL_SIZE_CLASS = "h-9 w-9";
