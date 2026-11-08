import type { BrowserWindow } from "electron";
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, nextZoomLevel, normalizeZoomLevel, type ZoomCommand } from "../shared/app-zoom.js";
import { getMainWindow, getMainWindows, getServices } from "./app-state.js";
import { broadcastSettingsSnapshot } from "../ipc/domains/settings.js";
import { createLogger } from "../lib/logger.js";

import { preserveBrowserGuestZoom } from "./browser/browser-guest-tracking.js";

const log = createLogger("app-zoom");
let pending: Promise<void> = Promise.resolve();
let wheelBatch: { window: BrowserWindow; levels: number[] } | undefined;

export function runAppZoomCommand(command: ZoomCommand): Promise<void> {
  return enqueueZoomCommand(command);
}

function enqueueZoomCommand(command: ZoomCommand, resolveLevel = (level: number) => nextZoomLevel(level, command)): Promise<void> {
  wheelBatch = undefined;
  const run = pending.then(async () => {
    const settingsService = getServices()?.settingsService;
    if (!settingsService) return;
    const level = resolveLevel(normalizeZoomLevel(settingsService.get("appearance").zoomLevel));
    await settingsService.patch({ appearance: { zoomLevel: level } });
    await broadcastSettingsSnapshot({ settingsService, getAppWindows: getMainWindows, getMainWindow });
  });
  pending = run.catch(() => {});
  return run;
}

export function applyAppZoomLevel(level: number | undefined): void {
  for (const win of getMainWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      // MCP app and plugin frames follow shell zoom; browser guests retain their own per-site factor.
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
    const command = direction === "in" ? "in" : "out";
    if (wheelBatch?.window === win) {
      wheelBatch.levels = wheelBatch.levels.map((level) => nextZoomLevel(level, command));
      return;
    }
    // Store the result for each possible starting level to preserve ordered clamping in bounded space.
    const batch = { window: win, levels: Array.from({ length: MAX_ZOOM_LEVEL - MIN_ZOOM_LEVEL + 1 }, (_, index) => nextZoomLevel(MIN_ZOOM_LEVEL + index, command)) };
    void enqueueZoomCommand(command, (level) => {
      if (wheelBatch === batch) wheelBatch = undefined;
      return batch.levels[level - MIN_ZOOM_LEVEL] ?? level;
    }).catch(() => log.warn("Could not save app zoom"));
    wheelBatch = batch;
  });
}
