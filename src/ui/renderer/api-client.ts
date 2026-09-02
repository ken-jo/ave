// Stateless helpers over window.aveApi.

import type { AveApi, AvePlatformApi, PluginUiExtension } from "./types.js";
import { pluginViewKey, type PluginViewKey } from "../../shared/view-key.js";

export { getPluginViewLabel } from "../../shared/plugin-view-label.js";

export function getApi(): AveApi {
  if (!window.aveApi) throw new Error("aveApi not initialized");
  return window.aveApi;
}

export function toViewKey(item: PluginUiExtension): PluginViewKey {
  return pluginViewKey(item.pluginId, item.extension.id);
}

/** The preload platform bridge, or null outside Electron (jsdom, Storybook, SSR). */
export function getPlatformBridge(): AvePlatformApi | null {
  return window.avePlatform ?? null;
}

export function isDarwin(): boolean {
  return getPlatformBridge()?.isDarwin ?? false;
}
