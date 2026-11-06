/** Narrow host chrome API for standard app panels in the floating dock. */
import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "./contract/app-contract.js";
import { mcpApiSurface } from "./preload/mcp-api-surface.js";

/** One main-to-dock subscription, returning its own unsubscribe. */
function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const mountedAuthTools = new Map<string, string>();

const dockBridge = {
  onActivity: (handler: (activity: unknown) => void) =>
    subscribe(CHANNELS.dock.activity, handler),
  onMount: (handler: (slot: unknown) => void) => subscribe(CHANNELS.dock.mount, (slot) => {
    const mount = slot as { panelId: string; authStatusTool?: string };
    mountedAuthTools.delete(mount.panelId);
    if (mount.authStatusTool) mountedAuthTools.set(mount.panelId, mount.authStatusTool);
    handler(slot);
  }),
  onResize: (handler: (change: unknown) => void) => subscribe(CHANNELS.dock.resize, handler),
  /** A card's header title changed — the host resolved it in a new UI language. */
  onRetitle: (handler: (change: unknown) => void) => subscribe(CHANNELS.dock.retitle, handler),
  onUnmount: (handler: (slot: unknown) => void) => subscribe(CHANNELS.dock.unmount, (slot) => {
    mountedAuthTools.delete((slot as { panelId: string }).panelId);
    handler(slot);
  }),
  /** Only host-issued mounted panels select a status method; the untrusted app cannot call this chrome API. */
  readAuthStatus: (panelId: string): Promise<unknown> => {
    const method = mountedAuthTools.get(panelId);
    if (!method) throw new Error("Dock panel has no auth status source");
    return ipcRenderer.invoke(CHANNELS.plugins.call, method, undefined, { userAction: false });
  },
  /** The host theme current when the window opened, then each later one (main sends both). */
  onTheme: (handler: (theme: unknown) => void) => subscribe(CHANNELS.dock.theme, handler),

  /** The user pressed the dock's close control. */
  requestClose: (): void => {
    ipcRenderer.send(CHANNELS.dock.requestClose);
  },

  /**
   * One slot's guest died.
   *
   * Reported from the renderer because `<webview>`'s `crashed` and
   * `destroyed` events fire on the element, and main has no handle on a guest
   * it did not create. Main re-checks that the sender is the dock before
   * acting on it.
   */
  reportSlotGone: (panelId: string): void => {
    ipcRenderer.send(CHANNELS.dock.slotGone, { panelId });
  },
};

contextBridge.exposeInMainWorld("aveDock", dockBridge);

export type AveDockBridge = typeof dockBridge;

const appMcp = {
  readUiResource: mcpApiSurface.readUiResource,
  callTool: mcpApiSurface.callTool,
  postUiMessage: mcpApiSurface.postUiMessage,
  downloadFile: mcpApiSurface.downloadFile,
  postUiModelContext: mcpApiSurface.postUiModelContext,
  disposeUiSession: mcpApiSurface.disposeUiSession,
  onServerDisconnected: mcpApiSurface.onServerDisconnected,
};
contextBridge.exposeInMainWorld("ave", { mcp: appMcp });
contextBridge.exposeInMainWorld("aveApi", {
  openExternalUrl: (url: string) => ipcRenderer.invoke(CHANNELS.shell.openExternal, url),
});
