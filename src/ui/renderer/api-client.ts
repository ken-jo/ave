import type { AveApi, AvePlatformApi, PluginUiExtension } from "./types.js";
import { pluginViewKey, type PluginViewKey } from "../../shared/view-key.js";

export { getPluginViewDescription, getPluginViewLabel } from "../../shared/plugin-view-label.js";

export function getApi(): AveApi {
  if (!window.aveApi) throw new Error("aveApi not initialized");
  return window.aveApi;
}

export function toViewKey(item: PluginUiExtension): PluginViewKey {
  return pluginViewKey(item.pluginId, item.extension.id);
}

const WINDOW_CONTROLS_PLACEMENTS: readonly unknown[] = ["native", "trailing", "leading"];

/**
 * The preload platform bridge, or null outside Electron (jsdom, Storybook, SSR). A present bridge is preload's contract: an
 * unknown window-controls placement, or one that disagrees with `isDarwin` (macOS, and only macOS, draws native controls),
 * fails clearly instead of falling back to a placement.
 */
export function getPlatformBridge(): AvePlatformApi | null {
  const bridge = window.avePlatform;
  if (!bridge) return null;
  if (typeof bridge.isDarwin !== "boolean" || !WINDOW_CONTROLS_PLACEMENTS.includes(bridge.windowControls)) {
    throw new Error(`[ave] invalid avePlatform bridge: ${JSON.stringify(bridge)}`);
  }
  if (bridge.isDarwin !== (bridge.windowControls === "native")) {
    throw new Error(`[ave] avePlatform disagrees with itself: isDarwin=${bridge.isDarwin}, windowControls=${bridge.windowControls}`);
  }
  return bridge;
}

export function isDarwin(): boolean {
  return getPlatformBridge()?.isDarwin ?? false;
}
