export const MIN_ZOOM_LEVEL = -8;
export const MAX_ZOOM_LEVEL = 8;
export type ZoomCommand = "in" | "out" | "reset";

export function isZoomLevel(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_ZOOM_LEVEL && value <= MAX_ZOOM_LEVEL;
}

export function normalizeZoomLevel(value: unknown): number {
  return isZoomLevel(value) ? value : 0;
}

export function zoomLevelToZoomFactor(level: number): number {
  return 1.2 ** normalizeZoomLevel(level);
}

export function nextZoomLevel(level: number | undefined, command: ZoomCommand): number {
  if (command === "reset") return 0;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, normalizeZoomLevel(level) + (command === "in" ? 1 : -1)));
}
