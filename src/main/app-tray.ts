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
import { getMainWindow, getTray, isRendererReloadReady, setTray } from "./app-state.js";
import {
  createWindow,
  loadMainInterface,
  registerMainWindowPluginEventBridge,
  showMainWindow,
} from "./main-window.js";
import { createAlwaysOnTopMenuItem, createSettingsMenuItem, refreshApplicationMenu } from "./app-menu.js";

export function showOrCreateMainWindow(reason: string): void {
  const existing = getMainWindow();
  if (existing && !existing.isDestroyed()) {
    showMainWindow(existing);
    refreshApplicationMenu();
    refreshTrayMenu();
    return;
  }
  createAndLoadMainWindow(reason);
}

/**
 * Open one more main window ("New Window", a second launch of the app). Until
 * bootstrap has registered IPC there is no interface to load into it, so an
 * early request surfaces the window that boot is about to load instead.
 */
export function openNewMainWindow(reason: string): void {
  if (!isRendererReloadReady() && getMainWindow()) {
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
