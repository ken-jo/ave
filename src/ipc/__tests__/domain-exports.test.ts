// Snapshot runtime exports; type-only exports need separate compile-time checks.
import { describe, expect, it, vi } from "vitest";

// Domain imports load the full dependency graph, so mock the native IPC module before importing.
vi.mock("electron", () => {
  const electron = {
    ipcMain: {
      handle: () => {},
      handleOnce: () => {},
      on: () => {},
      removeHandler: () => {},
      removeAllListeners: () => {},
      off: () => {},
      emit: () => {},
    },
    BrowserWindow: class BrowserWindow {
      static getAllWindows() {
        return [];
      }
      static fromWebContents() {
        return null;
      }
      static getFocusedWindow() {
        return null;
      }
    },
    app: {
      getPath: () => "/tmp/ave-test",
      getAppPath: () => "/tmp/ave",
      getName: () => "ave",
      getVersion: () => "0.0.0-test",
      getLocale: () => "en-US",
      isPackaged: false,
      on: () => {},
      whenReady: () => Promise.resolve(),
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
      showMessageBox: async () => ({ response: 0 }),
    },
    Menu: class Menu {
      append() {}
      popup() {}
      static buildFromTemplate() {
        return new Menu();
      }
      static setApplicationMenu() {}
    },
    MenuItem: class MenuItem {},
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }),
      createFromDataURL: () => ({ isEmpty: () => true }),
    },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    shell: { openExternal: async () => {}, openPath: async () => "" },
    webContents: { getAllWebContents: () => [], fromId: () => null },
    clipboard: { readText: () => "", writeText: () => {} },
    session: {
      fromPartition: () => ({ setPermissionRequestHandler: () => {} }),
      defaultSession: { setPermissionRequestHandler: () => {} },
    },
    contextBridge: { exposeInMainWorld: () => {} },
    ipcRenderer: { invoke: async () => {}, on: () => {}, send: () => {}, removeListener: () => {} },
  };
  return { ...electron, default: electron };
});

import * as attach from "../domains/attach.js";
import * as audit from "../domains/audit.js";
import * as chat from "../domains/chat.js";
import * as dev from "../domains/dev.js";
import * as app from "../domains/app.js";
import * as routines from "../domains/routines.js";
import * as sessionTasks from "../domains/session-tasks.js";
import * as sessionGoal from "../domains/session-goal.js";
import * as permissions from "../domains/permissions.js";
import * as plugins from "../domains/plugins.js";
import * as prompts from "../domains/prompts.js";
import * as pluginStudio from "../domains/plugin-studio.js";
import * as settings from "../domains/settings.js";
import * as tour from "../domains/tour.js";
import * as ui from "../domains/ui.js";
import * as usage from "../domains/usage.js";
import * as window from "../domains/window.js";
import * as workBoard from "../domains/work-board.js";

const keys = (mod: Record<string, unknown>): string[] => Object.keys(mod).sort();

describe("IPC domain runtime named-export lock", () => {
  it("locks the sorted named-export list of every ipc domain", () => {
    const exportsByDomain = {
      attach: keys(attach),
      audit: keys(audit),
      chat: keys(chat),
      dev: keys(dev),
      app: keys(app),
      routines: keys(routines),
      "session-tasks": keys(sessionTasks),
      "session-goal": keys(sessionGoal),
      permissions: keys(permissions),
      plugins: keys(plugins),
      prompts: keys(prompts),
      "plugin-studio": keys(pluginStudio),
      settings: keys(settings),
      tour: keys(tour),
      ui: keys(ui),
      usage: keys(usage),
      window: keys(window),
      "work-board": keys(workBoard),
    };
    expect(exportsByDomain).toMatchInlineSnapshot(`
      {
        "app": [
          "registerAppHandlers",
        ],
        "attach": [
          "DROP_TOKEN_TTL_MS",
          "registerAttachHandlers",
        ],
        "audit": [
          "parseIsoDate",
          "registerAuditHandlers",
        ],
        "chat": [
          "registerChatHandlers",
        ],
        "dev": [
          "registerDevHandlers",
        ],
        "permissions": [
          "broadcastPermissionConfigChanged",
          "registerPermissionsHandlers",
        ],
        "plugin-studio": [
          "registerPluginStudioHandlers",
        ],
        "plugins": [
          "__resetLastThemePayloadForTests",
          "getLastThemePayload",
          "pluginLifecycleServices",
          "publishHostThemeChanged",
          "recordValidatedTheme",
          "registerPluginsHandlers",
          "replayThemeToWebview",
          "revokePluginWebviewsForPlugin",
          "unregisterPluginWebview",
          "validateThemePayload",
        ],
        "prompts": [
          "PROMPTS_UPDATED",
          "registerPromptHandlers",
        ],
        "routines": [
          "registerRoutineHandlers",
        ],
        "session-goal": [
          "registerSessionGoalHandlers",
        ],
        "session-tasks": [
          "registerSessionTasksHandlers",
        ],
        "settings": [
          "broadcastSettingsSnapshot",
          "mutateMarketplaceProviderPresets",
          "registerSettingsHandlers",
          "rendererSettingsSnapshot",
        ],
        "tour": [
          "TOUR_START_CHANNEL",
          "registerTourHandlers",
        ],
        "ui": [
          "registerUiHandlers",
        ],
        "usage": [
          "registerUsageHandlers",
        ],
        "window": [
          "registerWindowEventListeners",
          "registerWindowHandlers",
        ],
        "work-board": [
          "registerWorkBoardHandlers",
        ],
      }
    `);
  });
});

// Type-only export checks require a test-inclusive typecheck; the default project excludes tests.
type _SafeThemePayloadLock = import("../domains/plugins.js").SafeThemePayload;
type _SerializedHistoryMessageLock = import("../domains/chat.js").SerializedHistoryMessage;
const _typeExportLocks: {
  safeTheme?: _SafeThemePayloadLock;
  serializedHistory?: _SerializedHistoryMessageLock;
} = {};
void _typeExportLocks;
