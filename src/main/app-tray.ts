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

// Relaunch restores or recreates the primary window without disturbing secondary windows.
export function showOrCreatePrimaryMainWindow(reason: string): void {
  surfaceOrCreateMainWindow(getPrimaryMainWindow(), reason);
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

// Before IPC registration or when all main windows are hidden, surface an existing window instead of creating another.
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
