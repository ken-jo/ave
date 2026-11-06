// Every window shares titlebar geometry: native inset controls on macOS and renderer controls on Windows/Linux. Spread getCommonChromeOptions instead of
// inlining frame, titleBarStyle, or trafficLightPosition.
import { nativeTheme, type BrowserWindow, type BrowserWindowConstructorOptions } from "electron";
import type { AppearanceMode } from "../shared/appearance-settings.js";
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

// ─── Main-window glass (macOS) ──────────────────────────────────────────────
// The main window's backdrop is the system's own material (NSVisualEffectView) under a semi-opaque tint the renderer paints.
// `vibrancy` alone makes the page background see-through; `transparent: true` is NOT set, because Electron documents that a
// transparent window loses its resize, its macOS shadow and its transparency while DevTools is open
// (https://github.com/electron/electron/blob/v45.2.1/docs/tutorial/custom-window-styles.md#limitations). Windows and Linux stay opaque, and a user who
// asked the OS to reduce transparency gets the opaque window too
// (https://github.com/electron/electron/blob/v45.2.1/docs/api/native-theme.md#nativethemeprefersreducedtransparency-readonly).
type GlassOptions = Pick<BrowserWindowConstructorOptions, "vibrancy" | "visualEffectState" | "backgroundColor">;

const MAIN_WINDOW_VIBRANCY = "under-window" as const;
// The opaque window colour under reduced transparency, before the renderer paints (and between resize frames).
const OPAQUE_WINDOW_BACKGROUND = { light: "#FFFFFF", dark: "#1E1E1E" } as const;

export function mainWindowGlassEnabled(platform: NodeJS.Platform, prefersReducedTransparency: boolean): boolean {
  return platform === "darwin" && !prefersReducedTransparency;
}

export function getMainWindowGlassOptions(glass: boolean): GlassOptions {
  if (!glass) return {};
  // `followWindow` dims the material with the window, as every native app does. Fully clear #AARRGGBB so the window's own fill
  // never tints the material; the renderer owns the tint.
  return { vibrancy: MAIN_WINDOW_VIBRANCY, visualEffectState: "followWindow", backgroundColor: "#00000000" };
}

/** Drop or restore the material on a live window when the OS reduce-transparency switch changes. */
export function applyMainWindowGlass(
  win: Pick<BrowserWindow, "setVibrancy" | "setBackgroundColor">,
  glass: boolean,
  dark: boolean,
): void {
  if (glass) {
    win.setBackgroundColor("#00000000");
    win.setVibrancy(MAIN_WINDOW_VIBRANCY);
    return;
  }
  win.setVibrancy(null);
  win.setBackgroundColor(OPAQUE_WINDOW_BACKGROUND[dark ? "dark" : "light"]);
}

/**
 * Electron's native theme follows the app's own appearance mode, as the v45.2.1 docs prescribe for a three-way dark-mode
 * setting ("Follow OS" -> `system`, "Dark Mode" -> `dark`, "Light Mode" -> `light`;
 * https://github.com/electron/electron/blob/v45.2.1/docs/api/native-theme.md#nativethemethemesource). That one value drives the
 * macOS material and window frame, Electron-drawn menus on Windows/Linux, and `prefers-color-scheme` in every web contents — so
 * plugin views, MCP app frames, the splash and the auth window's chrome all see the scheme the user chose instead of the OS's.
 */
export function syncNativeThemeSource(mode: AppearanceMode | undefined): void {
  if (mode === undefined) return;
  if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode;
}
