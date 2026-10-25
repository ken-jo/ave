// Menu builders read live state and rebuild when window or plugin state changes.
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { getLocale, t } from "../i18n/index.js";
import { getPluginViewLabel } from "../shared/plugin-view-label.js";
import { normalizeSettingsTab } from "../shared/settings-tabs.js";
import { getMainWindow, getServices } from "./app-state.js";
import {
  requestNativeChromeRefresh,
  requestOpenNewMainWindow,
  requestShowOrCreateMainWindow,
} from "./native-window-coordinator.js";

function activateView(viewKey: string) {
  getMainWindow()?.webContents.send("ave:view:activate", { viewKey });
}

// Restore or create the main window, then activate inline settings; defer IPC until did-finish-load if needed.
export function activateInlineSettings(tabInput: unknown = "llm"): void {
  const settingsTab = normalizeSettingsTab(tabInput);
  requestShowOrCreateMainWindow("settings-open");
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const send = () => {
    if (!win.isDestroyed()) {
      win.webContents.send("ave:view:activate", { viewKey: "settings", settingsTab });
    }
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", send);
  } else {
    send();
  }
}

function createViewMenu() {
  const services = getServices();
  if (!services) return { label: t("be_main.menuPlugins"), submenu: [] as MenuItemConstructorOptions[] };
  const pluginViews = services.pluginRuntime
    .listUiExtensions()
    .filter((item) => item.extension.slot === "sidebar")
    .map((item) => ({
      key: `plugin:${item.pluginId}:${item.extension.id}`,
      label: getPluginViewLabel(item, getLocale()),
    }));
  return {
    label: t("be_main.menuPlugins"),
    submenu: [
      { label: t("be_main.menuHome"), click: () => activateView("home") },
      ...pluginViews.map((item) => ({
        label: item.label,
        click: () => activateView(item.key),
      })),
    ],
  };
}

export function createSettingsMenuItem(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuSettings"),
    accelerator: "CommandOrControl+,",
    click: () => {
      activateInlineSettings("llm");
    },
  };
}

function isMainWindowAlwaysOnTop(): boolean {
  const mainWindow = getMainWindow();
  return mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isAlwaysOnTop();
}

export function createAlwaysOnTopMenuItem(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuAlwaysOnTop"),
    type: "checkbox",
    checked: isMainWindowAlwaysOnTop(),
    click: () => {
      const mainWindow = getMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.setAlwaysOnTop(!isMainWindowAlwaysOnTop());
      requestNativeChromeRefresh();
    },
  };
}

function createDisplayMenu(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuView"),
    submenu: [
      { role: "reload" },
      { type: "separator" },
      createAlwaysOnTopMenuItem(),
    ],
  };
}

function createHelpMenu(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuHelp"),
    role: "help",
    submenu: [],
  };
}

function createNewWindowMenuItem(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuNewWindow"),
    accelerator: "CommandOrControl+Shift+N",
    click: () => {
      requestOpenNewMainWindow("menu-new-window");
    },
  };
}

function createEditMenu(): MenuItemConstructorOptions {
  return {
    label: t("be_main.menuEdit"),
    submenu: [
      { role: "undo", label: t("be_main.menuUndo") },
      { role: "redo", label: t("be_main.menuRedo") },
      { type: "separator" },
      { role: "cut", label: t("be_main.menuCut") },
      { role: "copy", label: t("be_main.menuCopy") },
      { role: "paste", label: t("be_main.menuPaste") },
      { role: "pasteAndMatchStyle", label: t("be_main.menuPasteAndMatchStyle") },
      { role: "delete", label: t("be_main.menuDelete") },
      { type: "separator" },
      { role: "selectAll", label: t("be_main.menuSelectAll") },
    ],
  };
}

export function refreshApplicationMenu() {
  const settingsMenuItem = createSettingsMenuItem();
  const editMenu = createEditMenu();
  const displayMenu = createDisplayMenu();
  const helpMenu = createHelpMenu();
  const template: MenuItemConstructorOptions[] =
    process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              createNewWindowMenuItem(),
              createAlwaysOnTopMenuItem(),
              settingsMenuItem,
              { type: "separator" },
              { role: "quit" },
            ],
          },
          editMenu,
          createViewMenu(),
          displayMenu,
          helpMenu,
        ]
      : [
          { label: t("be_main.menuApp"), submenu: [createNewWindowMenuItem(), createAlwaysOnTopMenuItem(), settingsMenuItem, { type: "separator" }, { role: "quit" }] },
          editMenu,
          createViewMenu(),
          displayMenu,
          helpMenu,
        ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
