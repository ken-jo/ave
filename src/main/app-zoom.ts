import type { BrowserWindow } from "electron";
import { nextZoomLevel, normalizeZoomLevel, type ZoomCommand } from "../shared/app-zoom.js";
import { getMainWindow, getMainWindows, getServices } from "./app-state.js";
import { broadcastSettingsSnapshot } from "../ipc/domains/settings.js";
import { createLogger } from "../lib/logger.js";

import { preserveBrowserGuestZoom } from "./browser/browser-guest-tracking.js";

const log = createLogger("app-zoom");
let pending: Promise<void> = Promise.resolve();

export function runAppZoomCommand(command: ZoomCommand): Promise<void> {
  const run = pending.then(async () => {
    const settingsService = getServices()?.settingsService;
    if (!settingsService) return;
    const level = nextZoomLevel(settingsService.get("appearance").zoomLevel, command);
    await settingsService.patch({ appearance: { zoomLevel: level } });
    await broadcastSettingsSnapshot({ settingsService, getAppWindows: getMainWindows, getMainWindow });
  });
  pending = run.catch(() => {});
  return run;
}

export function applyAppZoomLevel(level: number | undefined): void {
  for (const win of getMainWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      // Embedded app and plugin frames follow shell zoom; browser guests retain their own per-site factor.
      preserveBrowserGuestZoom(win.id, () => win.webContents.setZoomLevel(normalizeZoomLevel(level)));
    }
  }
}

export function bindAppWindowZoom(win: BrowserWindow): void {
  const restoreLevel = () => preserveBrowserGuestZoom(win.id, () => win.webContents.setZoomLevel(normalizeZoomLevel(getServices()?.settingsService.get("appearance").zoomLevel)));
  win.webContents.on("did-navigate", restoreLevel);
  win.webContents.on("did-finish-load", restoreLevel);
  void win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => log.warn("Could not disable visual zoom"));
  win.webContents.on("zoom-changed", (event, direction) => {
    event.preventDefault();
    void runAppZoomCommand(direction === "in" ? "in" : "out").catch(() => log.warn("Could not save app zoom"));
  });
}
