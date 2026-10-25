// The host fixes dock window geometry and privileges; plugins contribute cards through the existing sandboxed UI shell.
import { BrowserWindow, ipcMain, screen } from "electron";
import { runtimeAssetPath } from "./main-paths.js";
import { pluginPartitionName } from "../shared/plugin-partition.js";
import { CHANNELS } from "../contract/app-contract.js";
import { createLogger } from "../lib/logger.js";
import { onEvent } from "../boot/types.js";
import { getLastThemePayload } from "../shared/plugin-theme-cache.js";
import { dockAssetArgs } from "../shared/floating-dock-args.js";
import { pathToFileURL } from "node:url";
import { preloadBundlePath, preloadPreferences } from "./preload-bundles.js";
import { configurePluginWebviewAttach } from "./plugin-webview-attach.js";
import type {
  DockActivity,
  DockBounds,
  DockSurfaceEvent,
  FloatingDockSurface,
  ResolvedFloatingSurface,
  WorkArea,
} from "./floating-dock.js";

const log = createLogger("floating-dock");

// The real window. Created lazily and destroyed on `hide()` rather than merely hidden: a dock with nothing in it has no state worth keeping alive, and a
// destroyed window cannot be left floating by a bug in the visibility bookkeeping.
export interface ElectronFloatingDockSurfaceDeps {
  // Subscribe to the host theme broadcast (`host.theme.changed`, the payload plugin webviews receive). The dock's own chrome reads the theme once when its
  // window loads; every later theme reaches it through this.
  onThemeChanged(listener: (theme: unknown) => void): () => void;
  // The theme current now — the host renderer's last validated one — or null before the first.
  currentTheme(): unknown;
}

// The host's theme feed, the one plugin webviews get: the validated `host.theme.changed` broadcast and the replay cache behind it. Main pushes both to
// the dock, so the dock asks nothing through the plugin-only `getTheme`, whose guard rightly refuses a non-plugin frame.
export const hostDockThemeSource: ElectronFloatingDockSurfaceDeps = {
  onThemeChanged: (listener) => onEvent("host.theme.changed", listener),
  currentTheme: getLastThemePayload,
};

export class ElectronFloatingDockSurface implements FloatingDockSurface {
  #window: BrowserWindow | null = null;
  #emit: ((event: DockSurfaceEvent) => void) | null = null;
  // Queued while the renderer is still loading; flushed on ready-to-show.
  #pending: Array<{ channel: string; payload: unknown }> = [];
  #ready = false;
  readonly #currentTheme: () => unknown;

  constructor(deps: ElectronFloatingDockSurfaceDeps) {
    this.#currentTheme = deps.currentTheme;
    // The surface lives as long as the app, so this subscription is never undone. No window: nothing to repaint, and the next one is sent the current theme on opening.
    deps.onThemeChanged((theme) => this.#post(CHANNELS.dock.theme, theme));
    // Register IPC once per surface instance and validate this dock’s sender so reopen cannot stack handlers or permit cross-window control.
    ipcMain.on(CHANNELS.dock.requestClose, (event) => {
      if (!this.ownsSender(event.sender.id)) return;
      this.#emit?.({ kind: "dock-closed" });
    });
    ipcMain.on(CHANNELS.dock.slotGone, (event, payload: { panelId?: unknown }) => {
      if (!this.ownsSender(event.sender.id)) return;
      const panelId = payload?.panelId;
      if (typeof panelId !== "string" || !panelId) return;
      this.#emit?.({ kind: "slot-gone", panelId, reason: "renderer-gone" });
    });
  }

  workArea(): WorkArea {
    // `getPrimaryDisplay` rather than the display the main window is on: the dock is a persistent overlay and moving it when the app window moves would be
    // more surprising than leaving it where the user last saw it.
    return screen.getPrimaryDisplay().workArea;
  }

  onSurfaceEvent(listener: (event: DockSurfaceEvent) => void): void {
    this.#emit = listener;
  }

  show(bounds: DockBounds): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.setBounds(bounds);
      return;
    }
    this.#ready = false;
    const win = new BrowserWindow({
      ...bounds,
      // The dock has no titlebar; common window chrome would place native macOS controls over its transparent overlay.
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        // Use the shared sandboxed CommonJS preload: it needs require and hosts plugin guests.
        ...preloadPreferences("floatingDockPreload"),
        // The sandboxed preload cannot resolve files itself (no `node:path`).
        additionalArguments: dockAssetArgs({
          pluginShellUrl: pathToFileURL(runtimeAssetPath("plugin-ui-shell.html")).toString(),
          pluginPreloadUrl: pathToFileURL(preloadBundlePath("pluginPreload")).toString(),
        }),
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        webviewTag: true,
      },
    });
    this.#window = win;
    // The dock hosts only plugin cards. Each attaches under the same main-side guard as the main window's plugin frames (sandbox, isolation, no Node, no
    // nested webviews), whatever the element asked for; anything else is refused.
    win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      const enforced = configurePluginWebviewAttach({
        webPreferences: webPreferences as Record<string, unknown>,
        params: params as unknown as Record<string, string>,
      });
      if (enforced !== "enforced") event.preventDefault();
    });
    // The theme current now goes first, queued with anything later until the window is ready, so the chrome paints in it from the first frame it shows.
    const opening = this.#currentTheme();
    if (opening !== null) this.#post(CHANNELS.dock.theme, opening);

    // Above full-screen applications where the platform supports it. The "floating" level is ignored elsewhere and `alwaysOnTop` still applies.
    try {
      win.setAlwaysOnTop(true, "floating");
    } catch {
      // platform without the level; the flag above still holds
    }
    // Visible on whichever space the user switches to, which is what "the app is doing something" has to mean for a status surface.
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      // not supported everywhere
    }

    win.once("ready-to-show", () => {
      this.#ready = true;
      for (const queued of this.#pending) this.#post(queued.channel, queued.payload);
      this.#pending = [];
      win.show();
    });

    win.on("closed", () => {
      this.#window = null;
      this.#ready = false;
      this.#pending = [];
      // The user hit the close control, or the OS took the window. Either way every attachment is gone and the plugins have to hear it — a recorder whose
      // window vanished has an orphaned session to clean up.
      this.#emit?.({ kind: "dock-closed" });
    });

    void win.loadFile(runtimeAssetPath("floating-dock-window.html")).catch((err) => {
      log.error(`dock window failed to load: ${(err as Error).message}`);
      // Fail loudly rather than leaving an invisible always-on-top window behind that nothing can reach.
      if (!win.isDestroyed()) win.destroy();
    });
  }

  setBounds(bounds: DockBounds): void {
    if (!this.#window || this.#window.isDestroyed()) return;
    this.#window.setBounds(bounds);
  }

  hide(): void {
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    // Cleared first, so the `closed` handler's `dock-closed` does not travel back into a service that is already tearing this down.
    this.#emit = null;
    this.#window = null;
    win.destroy();
  }

  mountSlot(panelId: string, surface: ResolvedFloatingSurface, height: number): void {
    this.#post(CHANNELS.dock.mount, {
      panelId,
      pluginId: surface.pluginId,
      // The shell resolves the real module through `getEntryUrl` after `registerWebview`; this is the URL the renderer registers WITH, and main re-validates
      // it against the install root before minting anything.
      entryUrl: surface.entryUrl,
      // Compute the hashed plugin partition in main; renderer reconstruction could open a different session without the asset scheme.
      partition: pluginPartitionName(surface.pluginId),
      title: surface.title,
      height,
    });
  }

  resizeSlot(panelId: string, height: number): void {
    this.#post(CHANNELS.dock.resize, { panelId, height });
  }

  retitleSlot(panelId: string, title: string): void {
    this.#post(CHANNELS.dock.retitle, { panelId, title });
  }

  unmountSlot(panelId: string): void {
    this.#post(CHANNELS.dock.unmount, { panelId });
  }

  setActivity(activity: DockActivity | null): void {
    this.#post(CHANNELS.dock.activity, activity);
  }

  // Whether `event.sender` is this dock's window. The dock's IPC uses it.
  ownsSender(webContentsId: number): boolean {
    const win = this.#window;
    return !!win && !win.isDestroyed() && win.webContents.id === webContentsId;
  }

  #post(channel: string, payload: unknown): void {
    const win = this.#window;
    if (!win || win.isDestroyed()) return;
    if (!this.#ready) {
      // A mount that arrived before the renderer finished loading would be dropped by `send`, leaving a slot the service believes exists and the user cannot see. Queue instead.
      this.#pending.push({ channel, payload });
      return;
    }
    win.webContents.send(channel, payload);
  }
}
