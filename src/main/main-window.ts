import { app, BrowserWindow, screen, shell } from "electron";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../lib/logger.js";
import { mainDir } from "./main-paths.js";
import { validateExternalUrl } from "../shared/external-url.js";
import { attachSideBrowserWebview, isSideBrowserContents } from "./side-browser-webview.js";
import { trackBrowserGuest } from "./browser/browser-guest-tracking.js";
import { configureMainWindowWebviewAttach } from "./plugin-webview-attach.js";
import { getCommonChromeOptions } from "./window-chrome.js";
import { getLastThemePayload } from "../shared/plugin-theme-cache.js";
import { registerWindowEventListeners } from "./window-event-listeners.js";
import {
  INITIAL_THEME_ARG_PREFIX,
  INITIAL_THEME_ARG_MAX_BYTES,
  type InitialThemePrime,
} from "../shared/initial-theme.js";
import { resolveAppIconPath } from "./app-icon.js";
import { computeInitialMainWindowBounds } from "./main-window-bounds.js";
import { MAIN_WINDOW_MIN_HEIGHT, MAIN_WINDOW_MIN_WIDTH } from "../shared/shell-geometry.js";
import { isAppUpdateInstallRequested } from "./app-update-install-intent.js";
import { BOOTSTRAP_SPLASH, markBootstrapSplashShown } from "./bootstrap-splash.js";
import { requestNativeChromeRefresh } from "./native-window-coordinator.js";
import { killTerminalsOwnedBy } from "./terminal/pty-manager.js";
import { preloadPreferences } from "./preload-bundles.js";
import { MAIN_WINDOW_ROLE_QUERY_KEY } from "../shared/main-window-role.js";
import {
  getLastRendererReloadAt,
  getMainWindows,
  getPrimaryMainWindow,
  getServices,
  getTray,
  isAppShutdownCompleted,
  isAppShutdownStarted,
  isRendererReloadReady,
  markMainWindowFocused,
  nextMainWindowRole,
  registerMainWindow,
  setLastRendererReloadAt,
  setPendingRendererReload,
  unregisterMainWindow,
} from "./app-state.js";

const log = createLogger("ave");

export const rendererIndexUrl = () => pathToFileURL(resolve(mainDir, "..", "index.html")).toString();

// The app's own document, bare or carrying the window-role query a secondary window loads with. Any other path, scheme, query or fragment is refused.
function isRendererIndexUrl(url: string): boolean {
  if (url === rendererIndexUrl()) return true;
  return url === `${rendererIndexUrl()}?${MAIN_WINDOW_ROLE_QUERY_KEY}=secondary`;
}

function initialMainWindowBounds(): { x: number; y: number; width: number; height: number } {
  const { workArea } = screen.getPrimaryDisplay();
  return computeInitialMainWindowBounds(workArea);
}

// Prime frame-zero theme through preload arguments; missing or oversized payloads defer to asynchronous hydration.
export function initialThemeArgs(): string[] {
  const payload = getLastThemePayload();
  if (!payload) return [];
  // Prime only initial paint fields; read validated user font overrides from live settings, not cached plugin theme.
  // Omit default font values and leave renderer-only fields to normal hydration.
  const font = getServices()?.settingsService.getAll().appearance?.font;
  const fontSizeScale = typeof font?.sizeScale === "number" ? font.sizeScale : undefined;
  const fontFamily = font?.family && font.family !== "system" ? font.family : undefined;
  const prime: InitialThemePrime = {
    bundleId: payload.bundleId,
    shell: payload.shell,
    ...(payload.tokens ? { tokens: payload.tokens } : {}),
    ...(fontSizeScale !== undefined ? { fontSizeScale } : {}),
    ...(fontFamily !== undefined ? { fontFamily } : {}),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(prime);
  } catch {
    return [];
  }
  if (serialized.length > INITIAL_THEME_ARG_MAX_BYTES) return [];
  return [`${INITIAL_THEME_ARG_PREFIX}${serialized}`];
}

// Open one main app window. Several may be open at once; the first live one owns the primary conversation (see `app-state.ts`). Returns the window, or
// `null` for a headless run.
export function createWindow(
  options: { showBootstrapSplash?: boolean; headless?: boolean } = {},
): BrowserWindow | null {
  // One-shot runs have no desktop surface and must not allocate a renderer.
  if (options.headless) return null;
  const showBootstrapSplash = options.showBootstrapSplash ?? true;
  const hostPreload = preloadPreferences("preload");
  if (!existsSync(hostPreload.preload)) {
    throw new Error(`[ave] preload.cjs not found at ${hostPreload.preload} — run 'npm run build:preload' first`);
  }

  const win = new BrowserWindow({
    ...initialMainWindowBounds(),
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: true,
    icon: resolveAppIconPath(),
    autoHideMenuBar: false,
    // Cross-platform titlebar — see `src/main/window-chrome.ts` for the full rationale. The helper unifies main / settings / link / auth.
    ...getCommonChromeOptions(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The host preload and its sandbox (false: it needs Node built-ins), from the one table.
      ...hostPreload,
      // render_html tool renders LLM-produced HTML inside an Electron <webview>. The webview runs on its own webContents / OS process so a malicious or
      // runaway payload (e.g. `while(true){}`) can't freeze the main UI. The <webview> tag is gated by webPreferences.webviewTag.
      webviewTag: true,
      // Apply the cached theme before the renderer mounts.
      additionalArguments: initialThemeArgs(),
    },
  });
  registerMainWindow(win, nextMainWindowRole());
  // Read now: a closed window's id is what its terminals are recorded under.
  const windowId = win.id;
  // Point-to-point sends (menu actions, dialogs) follow the window in use.
  win.on("focus", () => markMainWindowFocused(win));

  // Register native state listeners on every new window instance; IPC’s live window lookup does not restore lost instance bindings.
  registerWindowEventListeners(win);

  // Development debugging is provided by the renderer-side eruda console (AVE_DEV_CONSOLE=1). Do not auto-open native Chromium DevTools: it changes the
  // runtime viewport and makes UI regressions look different from the real app window.

  win.once("ready-to-show", () => {
    log.info("window ready-to-show");
    showMainWindow(win);
  });
  win.on("close", (event) => {
    if (isAppUpdateInstallRequested()) return;
    if (isAppShutdownStarted() || isAppShutdownCompleted() || !getTray() || win.isDestroyed()) return;
    // With another main window still open, closing this one closes it for real: only the last remaining window follows the close-button preference (hide to
    // tray / quit), so extra windows never pile up as hidden zombies and closing one window never quits the others.
    if (getMainWindows().some((other) => other !== win)) return;
    // hide-to-tray keeps background work alive; it is also the early-boot and missing-system-settings default.
    const behavior = getServices()?.settingsService.getAll().system?.closeBehavior ?? "hide-to-tray";
    if (behavior === "quit") {
      // Prevent default close and let before-quit own destruction after bounded asynchronous cleanup.
      event.preventDefault();
      app.quit();
      return;
    }
    event.preventDefault();
    win.hide();
    requestNativeChromeRefresh();
  });
  win.on("closed", () => {
    unregisterMainWindow(win);
    // Its shells go with it. On macOS the app outlives its last window, and a window opened later restores the layout under the same terminal ids, in new
    // shells (`pty-manager.ts` waits for these to exit first).
    killTerminalsOwnedBy(windowId);
    requestNativeChromeRefresh();
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    log.error({ code, desc, url }, "window failed to load");
  });
  // Recovery: if the renderer crashes (e.g. GPU-lost after GPU utility failure), reload index.html. IPC handlers are registered on the main-process side
  // and survive a renderer restart — the reloaded renderer reconnects automatically.
  win.webContents.on("render-process-gone", (_e, details) => {
    log.error({ details }, "main window renderer process gone");
    if (!isRendererReloadReady()) {
      setPendingRendererReload(true);
      log.warn("renderer reload deferred until bootstrap + IPC registration complete");
      return;
    }
    const now = Date.now();
    if (!win.isDestroyed() && now - getLastRendererReloadAt() > 3000) {
      setLastRendererReloadAt(now);
      void loadMainInterface(win, "render-process-gone");
    } else if (!win.isDestroyed()) {
      log.warn("render-process-gone reload suppressed to avoid crash loop");
    }
  });

  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    // Plugin frames, MCP app frames and the side browser each have a guard that sets the guest's preferences in main; a guest no guard owns is refused.
    const attach = configureMainWindowWebviewAttach({
      event,
      webPreferences: webPreferences as Record<string, unknown>,
      params: params as unknown as Record<string, string>,
    });
    if (attach.result === "blocked" || attach.result === "refused") {
      log.warn({ src: params.src, partition: params.partition, owner: attach.owner }, "blocked webview attach");
    }
  });
  // Track only guests admitted by a partition guard, then bind by webContents ID; URLs cannot identify duplicate tabs.
  win.webContents.on("did-attach-webview", (_event, contents) => {
    if (!isSideBrowserContents(contents)) return;
    attachSideBrowserWebview(contents, win);
    trackBrowserGuest(contents, win.id);
    log.debug({ webContentsId: contents.id }, "browser webview attached");
  });

  // 외부 URL → 시스템 브라우저로 리다이렉트 (앱 내 탐색 방지) window.open() 차단
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsedUrl = new URL(url);
      const allowedProtocols = new Set(["http:", "https:"]);

      if (allowedProtocols.has(parsedUrl.protocol)) {
        void shell.openExternal(parsedUrl.toString()).catch((err) => {
          log.error({ url: parsedUrl.toString(), err }, "failed to open external URL");
        });
      } else {
        log.warn({
          url,
          protocol: parsedUrl.protocol,
        }, "blocked external URL with disallowed protocol");
      }
    } catch (err) {
      log.warn({ url, err }, "blocked invalid external URL");
    }
    return { action: "deny" };
  });
  // <a href> 클릭 또는 location.href 변경으로 인한 탐색 차단. Electron 24+ exposes the URL on `details.url`; the legacy positional `url` arg is deprecated and arrives
  // empty on Electron 41.x, so we read the canonical event payload only.
  win.webContents.on("will-navigate", (details) => {
    const url = details.url;
    // Pin navigation to the app’s own document; any other file document would inherit the full host preload and pass file-origin sender checks.
    if (isRendererIndexUrl(url)) return;
    details.preventDefault();
    // The fallback used to hand the raw URL to `shell.openExternal`, which launches any registered handler — `ms-msdt:`, `smb://` (NTLM leak), `search-ms:`.
    // The sibling `setWindowOpenHandler` above already enforces http/https; route through the shared validator so both agree.
    const validated = validateExternalUrl(url);
    if (!validated.ok) {
      log.warn({ url, error: validated.error }, "blocked navigation to disallowed URL");
      return;
    }
    void shell.openExternal(validated.url).catch((err) => {
      log.error({ url: validated.url, err }, "failed to open external URL");
    });
  });

  if (showBootstrapSplash) {
    // §M-race: bootstrap 동안 splash만 표시. 실 index.html 로드는 main()이 IPC 핸들러 등록 후 수행.
    markBootstrapSplashShown();
    void win
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BOOTSTRAP_SPLASH)}`)
      .then(() => showMainWindow(win))
      .catch((err) => log.error({ err }, "splash load failed"));
  }
  return win;
}

export async function loadMainInterface(win: BrowserWindow, reason: string) {
  if (win.isDestroyed()) return;
  try {
    // A secondary window's renderer is told so through the document URL (the primary loads the bare index, exactly as before multi-window). Crash recovery
    // reloads through here too, so the role is re-derived each time.
    const isPrimary = getPrimaryMainWindow() === win;
    await win.loadFile(
      resolve(mainDir, "..", "index.html"),
      isPrimary ? undefined : { query: { [MAIN_WINDOW_ROLE_QUERY_KEY]: "secondary" } },
    );
    setPendingRendererReload(false);
    showMainWindow(win);
    log.info({ reason }, "main interface loaded");
  } catch (err) {
    log.error({ reason, err }, "failed to load index.html");
  }
}

export function showMainWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.moveTop();
}

// Raise hidden or unfocused windows; hide only a visible focused window so the first shortcut press always brings the app forward.
export function toggleMainWindowVisibility(win: BrowserWindow): "shown" | "hidden" {
  if (win.isDestroyed()) return "shown";
  const visibleAndFocused = win.isVisible() && !win.isMinimized() && win.isFocused();
  if (visibleAndFocused) {
    win.hide();
    return "hidden";
  }
  showMainWindow(win);
  return "shown";
}

// Every open main window — the broadcast target set (see `app-state.ts`).
export function getAppWindows(): BrowserWindow[] {
  return getMainWindows();
}

export function registerMainWindowPluginEventBridge(win: BrowserWindow): void {
  getServices()?.registerPluginEventBridge?.(win);
}
