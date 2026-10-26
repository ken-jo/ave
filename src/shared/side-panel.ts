/** Renderer resize limits and main window reservation share the same minimum panel width. */
import { SHELL_GUTTER } from "./shell-geometry.js";

export const SIDE_PANEL_MIN_WIDTH = 448;
/** Persist the card plus two gutters; reserve its minimum width when space permits, otherwise give it the available tile width minus gutters. */
const SIDE_PANEL_CARD_INSET = SHELL_GUTTER * 2;
export const SIDE_PANEL_MIN_RESERVE = SIDE_PANEL_MIN_WIDTH + SIDE_PANEL_CARD_INSET;
export const SIDE_PANEL_DEFAULT_WIDTH = SIDE_PANEL_MIN_WIDTH + SIDE_PANEL_CARD_INSET;

/** Persist the expanded card width; main content padding adds a gutter. Fixed collapsed-rail width is outside these bounds. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 232;

export const FILE_TREE_MIN_WIDTH = 180;
export const FILE_TREE_MAX_WIDTH = 520;
export const FILE_TREE_DEFAULT_WIDTH = 300;

/** The tree preference is viewport-independent; the displayed column also fits its live container. */
export function clampFileTreeWidth(value: number): number {
  if (!Number.isFinite(value)) return FILE_TREE_DEFAULT_WIDTH;
  return Math.round(Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, value)));
}

export function normalizeFileTreeWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clampFileTreeWidth(value);
}

/** Non-finite measurements use the default so invalid geometry cannot poison persisted width. */
export function clampSidebarWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value)));
}

/** Percent is the top pane share; clamp both panes away from zero and persist separately per tab kind. */
export const SIDE_PANEL_SPLIT_MIN_PERCENT = 22;
export const SIDE_PANEL_SPLIT_MAX_PERCENT = 78;
export const SIDE_PANEL_SPLIT_DEFAULT_PERCENT = 45;

/** Preserve the old pane preference relative to its default while changing the stored axis to pixels. */
export function fileTreeWidthFromLegacySplit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return FILE_TREE_DEFAULT_WIDTH;
  return clampFileTreeWidth(clampSidePanelSplitPercent(value) * FILE_TREE_DEFAULT_WIDTH / SIDE_PANEL_SPLIT_DEFAULT_PERCENT);
}

/** Clamp before rounding; non-finite measurements use the default. */
export function clampSidePanelSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return SIDE_PANEL_SPLIT_DEFAULT_PERCENT;
  const clamped = Math.min(
    SIDE_PANEL_SPLIT_MAX_PERCENT,
    Math.max(SIDE_PANEL_SPLIT_MIN_PERCENT, value),
  );
  return Math.round(clamped);
}

/** Stored or patched non-finite values are rejected, preserving the prior value; measured geometry uses the clamps and their defaults instead. */
export function normalizeSidePanelWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(SIDE_PANEL_MIN_RESERVE, Math.round(value));
}

export function normalizeSidebarWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clampSidebarWidth(value);
}

export function normalizeSidePanelSplitPercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return clampSidePanelSplitPercent(value);
}
