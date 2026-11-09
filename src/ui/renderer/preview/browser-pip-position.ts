export interface BrowserPipPoint { x: number; y: number }
export interface BrowserPipArea { left: number; top: number; width: number; height: number }

/** Keep the whole card inside the available window area, including after a resize. */
export function clampBrowserPipPosition(point: BrowserPipPoint, card: { width: number; height: number },
  area: BrowserPipArea): BrowserPipPoint {
  return { x: Math.max(area.left, Math.min(point.x, area.left + area.width - card.width)),
    y: Math.max(area.top, Math.min(point.y, area.top + area.height - card.height)) };
}
