import {
  MAIN_WINDOW_HEIGHT,
  MAIN_WINDOW_MIN_HEIGHT,
  MAIN_WINDOW_MIN_WIDTH,
  MAIN_WINDOW_WIDTH,
} from "../shared/shell-geometry.js";

export type WorkAreaBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function computeInitialMainWindowBounds(
  workArea: WorkAreaBounds,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(MAIN_WINDOW_MIN_WIDTH, Math.min(MAIN_WINDOW_WIDTH, workArea.width));
  const height = Math.max(MAIN_WINDOW_MIN_HEIGHT, Math.min(MAIN_WINDOW_HEIGHT, workArea.height));
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}
