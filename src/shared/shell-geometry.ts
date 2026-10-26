/** Main and renderer share device-pixel geometry; controls aligned to OS window buttons must not scale with user type size. */

/** Opening size and minimum size remain independently settable even when equal; renderer docking and collapse thresholds share these bounds. */
export const MAIN_WINDOW_WIDTH = 460;
export const MAIN_WINDOW_HEIGHT = 840;
export const MAIN_WINDOW_MIN_WIDTH = 460;
export const MAIN_WINDOW_MIN_HEIGHT = 640;

/** Keep button position aligned with the chrome band and control centers. */
export const TRAFFIC_LIGHT_POSITION = { x: 18, y: 12 } as const;

const TRAFFIC_LIGHT_CLUSTER_RUN = 58;

const TRAFFIC_LIGHT_RIGHT_EDGE = TRAFFIC_LIGHT_POSITION.x + TRAFFIC_LIGHT_CLUSTER_RUN;

/** px value of `--chrome-gap-tight` in src/styles.css. */
export const CHROME_GAP_TIGHT = 4;

/** Share the card/content gutter with --chrome-gap and --shell-card-inset in CSS. */
export const SHELL_GUTTER = 8;

/** Files need readable tree and detail columns; narrower workspaces use tree-to-detail navigation. */
export const FILE_WORKSPACE_COLUMNS_MIN_WIDTH = 520;

/** Window controls sit flush on win/linux, so those bands must not add trailing padding. */
export const BAND_EDGE_PAD = 12;

/** Measured from the window edge, past the native buttons and their gap. */
export const BAND_LEAD_PAD_DARWIN = TRAFFIC_LIGHT_RIGHT_EDGE + CHROME_GAP_TIGHT;

/** Card inset is distinct from inter-surface gutter; keep its CSS mirror aligned. */
const CARD_LEFT_INSET = SHELL_GUTTER;

/** Measure strip padding from the card edge, subtracting its inset from the native-button clearance; backing paint behind OS buttons is safe. */
const CLUSTER_FIRST_BUTTON_X = TRAFFIC_LIGHT_RIGHT_EDGE + SHELL_GUTTER;
export const CLUSTER_LEAD_PAD_DARWIN = CLUSTER_FIRST_BUTTON_X - CARD_LEFT_INSET;

export const CHROME_ICON_BUTTON = 24;

export const CHROME_GAP_HAIR = 2;

const CLUSTER_STRIP_CONTROLS = 4;
const CLUSTER_STRIP_RUN = CLUSTER_STRIP_CONTROLS * CHROME_ICON_BUTTON + (CLUSTER_STRIP_CONTROLS - 1) * CHROME_GAP_HAIR;

/** The bare cluster strip remains when the rail collapses; band content must clear it by one gutter. */
export function collapsedBandLeadClearance(isDarwin: boolean): number {
  const firstButtonX = isDarwin ? CLUSTER_FIRST_BUTTON_X : CARD_LEFT_INSET + CHROME_GAP_TIGHT;
  return firstButtonX + CLUSTER_STRIP_RUN + SHELL_GUTTER;
}

/** Content titles begin two gutters from the card edge, matching the band label above. */
export const CONTENT_TITLE_INSET = SHELL_GUTTER * 2;

/** Native-button clearance fixes the collapsed reserve; keep the CSS mirror and geometry identity aligned. The literal is consumed by the source-reading gate. */
export const COLLAPSED_RAIL_RESERVE = 64;

/** The widest rail control must fit the reserve at the largest supported font scale. */
export const RAIL_CONTROL_REM = 2.25;

/** Keep the literal utility classes in source so the CSS scanner discovers them. */
export const RAIL_CONTROL_SIZE_CLASS = "h-9 w-9";
