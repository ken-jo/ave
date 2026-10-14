/**
 * System tray icon + context menu, and the "show or re-create the main
 * window" entry point the tray, menu, and macOS `activate` handler share.
 *
 * The tray instance lives in `app-state.ts`; this module owns its creation,
 * menu template, and click wiring.
 */
import { Menu, nativeImage, Tray } from "electron";
import { t } from "../i18n/index.js";
import { createAveTrayIcon } from "./tray-icon.js";
import { getMainWindow, getMainWindows, getPrimaryMainWindow, getTray, isRendererReloadReady, setTray } from "./app-state.js";
import {
  createWindow,
  loadMainInterface,
  registerMainWindowPluginEventBridge,
  showMainWindow,
} from "./main-window.js";
import { createAlwaysOnTopMenuItem, createSettingsMenuItem, refreshApplicationMenu } from "./app-menu.js";

export function showOrCreateMainWindow(reason: string): void {
  surfaceOrCreateMainWindow(getMainWindow(), reason);
}

/**
 * Launching the app again without a deep link (dock, taskbar, launcher): bring
 * the primary window back — restored and focused — as a normal desktop app
 * does, or open one if none exists. It never opens a window beside an
 * existing one; only an explicit "New Window" action does
 * ({@link openNewMainWindow}), so a local process relaunching the app cannot
 * pile up windows.
 */
export function showOrCreatePrimaryMainWindow(reason: string): void {
  surfaceOrCreateMainWindow(getPrimaryMainWindow() ?? getMainWindow(), reason);
}

function surfaceOrCreateMainWindow(existing: ReturnType<typeof getMainWindow>, reason: string): void {
  if (existing && !existing.isDestroyed()) {
    showMainWindow(existing);
    refreshApplicationMenu();
    refreshTrayMenu();
    return;
  }
  createAndLoadMainWindow(reason);
}

/**
 * Open one more main window — the explicit "New Window" action (menu, tray).
 *
 * Two cases surface an existing window instead: until bootstrap has registered
 * IPC there is no interface to load into a new one, and when every main
 * window is hidden (a hidden auto-launch, or the last window closed to the
 * tray) the user is asking for the app back, not for a second window beside
 * an invisible one.
 */
export function openNewMainWindow(reason: string): void {
  const windows = getMainWindows();
  const noneVisible = windows.length > 0 && windows.every((win) => !win.isVisible());
  if ((!isRendererReloadReady() && getMainWindow()) || noneVisible) {
    showOrCreateMainWindow(reason);
    return;
  }
  createAndLoadMainWindow(reason);
}

function createAndLoadMainWindow(reason: string): void {
  const win = createWindow({ showBootstrapSplash: false });
  if (win) registerMainWindowPluginEventBridge(win);
  if (win && isRendererReloadReady()) {
    void loadMainInterface(win, reason).finally(() => {
      refreshApplicationMenu();
      refreshTrayMenu();
    });
  }
  refreshApplicationMenu();
  refreshTrayMenu();
}

export function refreshTrayMenu(): void {
  const tray = getTray();
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: t("be_main.menuOpenAve"),
      click: () => showOrCreateMainWindow("tray-open"),
    },
    {
      label: t("be_main.menuNewWindow"),
      click: () => openNewMainWindow("tray-new-window"),
    },
    { type: "separator" },
    createAlwaysOnTopMenuItem(),
    createSettingsMenuItem(),
    { type: "separator" },
    { label: t("be_main.menuQuit"), role: "quit" },
  ]));
}

function createTrayIcon() {
  return createAveTrayIcon({ nativeImage });
}

export function ensureTray(): void {
  if (getTray()) return;
  const tray = new Tray(createTrayIcon());
  setTray(tray);
  tray.setToolTip("Ave");
  tray.on("click", () => showOrCreateMainWindow("tray-click"));
  tray.on("double-click", () => showOrCreateMainWindow("tray-double-click"));
  refreshTrayMenu();
}
