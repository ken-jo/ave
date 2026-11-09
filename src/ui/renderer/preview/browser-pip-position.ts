export interface BrowserPipPoint { x: number; y: number }

/** Keep the whole card inside the available window area, including after a resize. */
export function clampBrowserPipPosition(point: BrowserPipPoint, card: { width: number; height: number },
  area: { width: number; height: number }): BrowserPipPoint {
  return { x: Math.max(0, Math.min(point.x, area.width - card.width)),
    y: Math.max(0, Math.min(point.y, area.height - card.height)) };
}
