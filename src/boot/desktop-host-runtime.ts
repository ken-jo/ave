import { closeMainWindowDocuments } from "../main/main-window-host.js";
import { app, BaseWindow, dialog, nativeImage, Notification, powerMonitor, session, shell } from "electron";
import { createDeviceCodePresentation } from "../main/device-code-dialog.js";
import { desktopSecretEncryption } from "../main/desktop-secret-encryption.js";
import { browserCapturePixelRatio } from "../main/browser/browser-capture-desktop.js";
import { browserGuestOwnerWindow } from "../main/browser/browser-guest-owner.js";
import { join } from "node:path";
import { createDesktopNetworkFetch } from "./steps/desktop-network-fetch.js";
import { prepareDesktopRelease } from "./steps/desktop-release.js";
import { adaptPowerMonitor } from "../main/idle-scheduler.js";
import { getAppWindows } from "../main/main-window.js";
import { isAppShutdownStarted, findSessionMainWindowContents, findTerminalMainWindowContents, getMainWindows, getPrimaryMainWindow } from "../main/app-state.js";
import { isAppUpdateInstallRequested } from "../main/app-update-install-intent.js";
import { unregisterAllGlobalShortcuts } from "../main/global-shortcuts.js";
import { openAuthWindow, clearAuthPartition, openOAuthInAuthWindow } from "../main/auth-window-service.js";
import { installOAuthLoginOpener, type OpenOAuthLogin } from "../main/oauth-login.js";
import { openLinkWindow } from "../main/link-window-service.js";
import { openAuthPartitionViewer } from "../main/auth-partition-viewer-service.js";
import { ElectronAudioCaptureSurface } from "../main/audio-capture-surface.js";
import { ElectronFloatingDockSurface, hostDockThemeSource } from "../main/floating-dock-surface.js";
import { peekFloatingDock } from "./steps/plugin-runtime/host-api-factory.js";
import { pickFoldersForPlugin } from "../main/host-api/pick-folders.js";
import { getBrowserWorkspaceService } from "../main/browser/browser-workspace-desktop.js";
import type { BootHost } from "./host-runtime.js";
import { relaunchDesktopHost } from "./desktop-relaunch.js";
import { settingsFilePath } from "../data/settings-store.js";
import { protectRuntimeSettingsPath } from "../permissions/sensitive-paths.js";

export function createDesktopBootHost(projectRoot: string): BootHost {
  const openLogin: OpenOAuthLogin = (url, options) => {
    const parent = getPrimaryMainWindow();
    if (!parent || parent.isDestroyed()) throw new Error("OAuth login requires a main window");
    return openOAuthInAuthWindow(parent, url, options);
  };
  const host: BootHost = {
    userDataPath: app.getPath("userData"),
    resourcePath: app.isPackaged ? process.resourcesPath : join(projectRoot, "resources"),
    systemLocale: app.getPreferredSystemLanguages()[0] ?? "en",
    isPackaged: app.isPackaged,
    encryption: desktopSecretEncryption,
    ...createDesktopNetworkFetch(),
    resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    exit: (code) => app.exit(code),
    relaunch: () => relaunchDesktopHost(app),
    close: async () => {},
    desktop: {
      hasSingleInstanceLock: () => app.hasSingleInstanceLock(),
      getAppWindows,
      openOAuthLogin: openLogin,
      deviceCodePresentation: createDeviceCodePresentation(() => getPrimaryMainWindow()),
      getFocusedWindow: () => BaseWindow.getFocusedWindow(),
      findSessionSurface: findSessionMainWindowContents,
      findTerminalSurface: findTerminalMainWindowContents,
      getAuthPartition: (partition) => session.fromPartition(partition),
      openAuthWindowService: openAuthWindow,
      openLinkWindowService: openLinkWindow,
      openAuthPartitionViewerService: (_parent, options) => openAuthPartitionViewer(options),
      clearAuthPartitionService: clearAuthPartition,
      shellOpenExternal: (url) => shell.openExternal(url),
      onBootShutdown: (run, needed) => {
        app.once("before-quit", (event) => {
          if (isAppUpdateInstallRequested() || isAppShutdownStarted() || !needed()) return;
          event.preventDefault();
          void run().finally(() => app.quit());
        });
      },
      // Notification support detection creates the OS presenter; see initializeNotificationPresenter.
      initializeNotificationPresenter: () => Notification.isSupported(),
      notificationOptions: {
        isReady: () => app.isReady(),
        isAnyWindowFocused: () => BaseWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused()),
        notificationFactory: (options) => {
          const notification = new Notification(options);
          return { show: () => notification.show(), on: (event, handler) => notification.on(event, handler) };
        },
        notificationActivationRegistration: process.platform === "win32"
          ? (handler) => Notification.handleActivation(handler) : null,
      },
      powerMonitor: adaptPowerMonitor(powerMonitor),
      createAudioCaptureSurface: () => new ElectronAudioCaptureSurface(),
      createFloatingDockSurface: (settings) => new ElectronFloatingDockSurface(hostDockThemeSource, settings),
      pickFolders: (pluginId, parentWindow) => pickFoldersForPlugin(pluginId, { parentWindow }),
      pickBrowserUploadFiles: async (request) => {
        const owner = getMainWindows().find((window) => window.id === request.windowId && !window.isDestroyed());
        if (!owner || request.signal.aborted) return null;
        const selection = await dialog.showOpenDialog(owner, { title: request.origin, properties: ["openFile", "multiSelections"] });
        return owner.isDestroyed() || request.signal.aborted || selection.canceled ? null : selection.filePaths;
      },
      browserGuestContentOrigin: (guest) => {
        const window = browserGuestOwnerWindow(guest);
        if (!window || window.isDestroyed()) return null;
        const bounds = window.getContentBounds();
        return { x: bounds.x, y: bounds.y, windowId: window.id };
      },
      browserCapturePixelRatio,
      browserAgentPreview: {
        decodePng: (png) => nativeImage.createFromBuffer(Buffer.from(png, "base64")),
        record: (windowId, preview) => getBrowserWorkspaceService().recordAgentCapture(windowId, preview),
      },
      prepareRelease: prepareDesktopRelease,
      beforeShutdown: () => {
        unregisterAllGlobalShortcuts();
        peekFloatingDock()?.shutdown();
      },
      closeDocuments: (signal) => closeMainWindowDocuments(getAppWindows(), signal),
    },
  };
  const releaseSettingsPath = protectRuntimeSettingsPath(settingsFilePath(host.userDataPath));
  const releaseOAuthOpener = installOAuthLoginOpener(openLogin);
  host.close = async () => { releaseOAuthOpener(); releaseSettingsPath(); };
  return host;
}
