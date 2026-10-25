// Every window shares titlebar geometry: native inset controls on macOS and renderer controls on Windows/Linux. Spread getCommonChromeOptions instead of
// inlining frame, titleBarStyle, or trafficLightPosition.
import type { BrowserWindowConstructorOptions } from "electron";
import { TRAFFIC_LIGHT_POSITION } from "../shared/shell-geometry.js";

// The frame options every Ave window shares — never `webPreferences`, which each window sets from the preload table.
type CommonChromeOptions = Pick<BrowserWindowConstructorOptions, "frame" | "titleBarStyle" | "trafficLightPosition">;

export function getCommonChromeOptions(): CommonChromeOptions {
  const isDarwin = process.platform === "darwin";
  return {
    frame: isDarwin,
    titleBarStyle: isDarwin ? "hiddenInset" : "hidden",
    // The position, and the reason it pairs with the band height, live in `shared/shell-geometry.ts` — the renderer derives its own clearances from the same
    // constant, so the two sides cannot drift apart.
    trafficLightPosition: isDarwin ? { ...TRAFFIC_LIGHT_POSITION } : undefined,
  };
}
