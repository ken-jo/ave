import { type BrowserWindow, session, type WebContents } from "electron";
import { browserTabRegistry } from "../../../src/main/browser/browser-tab-registry.js";

export async function clearNativeBrowserStorage(partitionName: string): Promise<void> {
  await Promise.all([session.defaultSession, session.fromPartition(partitionName)].map(async (partition) => {
    await partition.clearStorageData();
    await partition.clearCache();
  }));
}

export function assertNativeBrowserState(window: BrowserWindow, guest: WebContents, rendererTabId: string): void {
  if (browserTabRegistry.controlState(window.id).tabs.length !== 1) {
    throw new Error("Browser fixture tab registry is dirty");
  }
  const tab = browserTabRegistry.liveRendererTab(window.id, rendererTabId);
  if (!tab?.guest || tab.guest !== guest || guest.isDestroyed()) {
    throw new Error("Browser fixture guest binding is dirty");
  }
  if (guest.getZoomFactor() !== 1) throw new Error("Browser fixture zoom is dirty");
}
