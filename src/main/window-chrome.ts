// Every window shares titlebar geometry: native inset controls on macOS and renderer controls on Windows/Linux. Spread getCommonChromeOptions instead of
// inlining frame, titleBarStyle, or trafficLightPosition.
import { nativeTheme, type BrowserWindowConstructorOptions } from "electron";
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

// ─── Main-window glass (macOS, Windows 11 22H2+) ────────────────────────────
// The main window's backdrop is the system's own material under a semi-opaque tint the renderer paints: NSVisualEffectView on macOS, the DWM
// Mica backdrop on Windows. `vibrancy` / `backgroundMaterial` alone make the page background see-through; `transparent: true` is NOT set, because
// Electron documents that a transparent window loses its resize, its macOS shadow and its transparency while DevTools is open
// (https://github.com/electron/electron/blob/v45.2.1/docs/tutorial/custom-window-styles.md#limitations). Linux and older Windows stay opaque, and a
// user who asked the OS to reduce transparency gets the opaque window too
// (https://github.com/electron/electron/blob/v45.2.1/docs/api/native-theme.md#nativethemeprefersreducedtransparency-readonly).
//
// Windows: `backgroundMaterial` is "only supported on Windows 11 22H2 and up"
// (https://github.com/electron/electron/blob/v45.2.2/docs/api/base-window.md#winsetbackgroundmaterialmaterial-windows; values per
// https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type). The build gate here is required, not redundant:
// Electron records the option and treats the window as translucent on every build (shell/browser/native_window.cc, `IsTranslucent`), but draws the
// backdrop only on 22H2+ (shell/browser/native_window_views.cc, `SetBackgroundMaterial`) — older builds would get a see-through window with nothing
// behind it. The material extends into the client area only for a frameless window (`!has_frame()`, same function), which every Windows main window is
// (`getCommonChromeOptions`), so the renderer-drawn controls stay. Not being `transparent`, the window keeps its thick frame (resize) and the normal
// maximize; Electron already skips the zero DWM insets for a maximized material window (shell/browser/ui/win/electron_desktop_window_tree_host_win.cc).
type GlassOptions = Pick<BrowserWindowConstructorOptions, "vibrancy" | "visualEffectState" | "backgroundMaterial" | "backgroundColor">;

/** The system material a main window can draw behind its tint on this OS, before the reduce-transparency switch is read. */
export type MainWindowGlassMaterial = "vibrancy" | "mica";

// Windows 11 22H2: the first build with `DWMWA_SYSTEMBACKDROP_TYPE`.
const WINDOWS_BACKDROP_MIN_BUILD = 22621;
const MAIN_WINDOW_VIBRANCY = "under-window" as const;
// Fully clear #AARRGGBB so the window's own fill never tints the material; the renderer owns the tint.
const CLEAR_WINDOW_FILL = "#00000000";

/** `release` is `os.release()` — on Windows "major.minor.build", e.g. "10.0.22621". An unreadable build means no material. */
export function mainWindowGlassMaterial(platform: NodeJS.Platform, release: string): MainWindowGlassMaterial | null {
  if (platform === "darwin") return "vibrancy";
  if (platform !== "win32") return null;
  const build = /^\d+\.\d+\.(\d+)$/.exec(release)?.[1];
  return build !== undefined && Number(build) >= WINDOWS_BACKDROP_MIN_BUILD ? "mica" : null;
}

export function mainWindowGlassEnabled(material: MainWindowGlassMaterial | null, prefersReducedTransparency: boolean): boolean {
  return material !== null && !prefersReducedTransparency;
}

/** The window options for the material drawn behind this window — `null` (no material, or reduce transparency) is the opaque window. */
export function getMainWindowGlassOptions(drawn: MainWindowGlassMaterial | null): GlassOptions {
  if (drawn === null) return {};
  // `followWindow` dims the material with the window, as every native app does.
  if (drawn === "vibrancy") return { vibrancy: MAIN_WINDOW_VIBRANCY, visualEffectState: "followWindow", backgroundColor: CLEAR_WINDOW_FILL };
  // Mica is the backdrop Windows prescribes for a long-lived window; DWM itself swaps it for a solid fill while the window is inactive.
  return { backgroundMaterial: "mica", backgroundColor: CLEAR_WINDOW_FILL };
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
