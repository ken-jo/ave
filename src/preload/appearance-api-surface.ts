import { ipcRenderer } from "electron";
import { CHANNELS, SETTINGS } from "../contract/app-contract.js";
import type { AveApi } from "../ui/renderer/types.js";

/** Shared appearance operations for app and dock renderers, safe to bundle into either sandboxed preload. */
export const appearanceApiSurface = {
  getSettings: async () => ipcRenderer.invoke(CHANNELS.settings.get),
  updateSettings: async (partial: Parameters<AveApi["updateSettings"]>[0]) => ipcRenderer.invoke(CHANNELS.settings.update, partial),
  onSettingsUpdated: (handler: Parameters<AveApi["onSettingsUpdated"]>[0]) => {
    const listener = (_event: unknown, settings: Parameters<typeof handler>[0]) => handler(settings);
    ipcRenderer.on(SETTINGS.updated, listener);
    return () => ipcRenderer.removeListener(SETTINGS.updated, listener);
  },
  notifyPluginTheme: (payload: Parameters<AveApi["notifyPluginTheme"]>[0]) =>
    ipcRenderer.invoke(CHANNELS.host.pluginThemeNotify, payload),
} satisfies Pick<AveApi, "getSettings" | "updateSettings" | "onSettingsUpdated" | "notifyPluginTheme">;
