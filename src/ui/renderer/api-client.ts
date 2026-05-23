// Stateless helpers over window.aveApi.

import type { AveApi, PluginUiExtension } from "./types.js";

export function getApi(): AveApi {
  if (!window.aveApi) throw new Error("aveApi not initialized");
  return window.aveApi;
}

export function toViewKey(item: PluginUiExtension): string {
  return `plugin:${item.pluginId}:${item.extension.id}`;
}

export function getPluginViewLabel(item: PluginUiExtension): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}
