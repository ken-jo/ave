/** Clamp untrusted sizes arithmetically; percentage height caps do nothing under an indefinite parent height. */

export const MCP_APP_CARD_DEFAULT_HEIGHT_PX = 300;

/** Clamp undersized cards to a usable chrome floor. */
export const MCP_APP_CARD_MIN_HEIGHT_PX = 40;

/** Allow tall content while keeping inline cards scroll-reachable. */
export const MCP_APP_CARD_MAX_HEIGHT_PX = 1600;

export const MCP_APP_CARD_MIN_WIDTH_PX = 120;

/** Bound pixel width even though CSS constrains its visible width. */
export const MCP_APP_CARD_MAX_WIDTH_PX = 3840;

/** Unset width means responsive full width. */
export interface McpAppCardSize {
  width?: number;
  height: number;
}

/** Invalid dimensions return null so callers preserve current state. */
function clampDimension(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Partial or invalid dimensions retain their current values; valid dimensions clamp independently. */
export function clampMcpAppCardSize(
  next: { width?: number; height?: number },
  prev: McpAppCardSize,
): McpAppCardSize {
  const width =
    next.width === undefined
      ? prev.width
      : (clampDimension(next.width, MCP_APP_CARD_MIN_WIDTH_PX, MCP_APP_CARD_MAX_WIDTH_PX) ?? prev.width);
  const height =
    next.height === undefined
      ? prev.height
      : (clampDimension(next.height, MCP_APP_CARD_MIN_HEIGHT_PX, MCP_APP_CARD_MAX_HEIGHT_PX) ?? prev.height);
  return { width, height };
}

/** Initial server heights use the same bounds as live resize and default when invalid. */
export function mcpAppCardSeedHeight(value: unknown): number {
  return (
    clampDimension(value, MCP_APP_CARD_MIN_HEIGHT_PX, MCP_APP_CARD_MAX_HEIGHT_PX) ??
    MCP_APP_CARD_DEFAULT_HEIGHT_PX
  );
}
