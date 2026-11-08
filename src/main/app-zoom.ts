import type { BrowserWindow } from "electron";
import { MAX_ZOOM_LEVEL, MIN_ZOOM_LEVEL, nextZoomLevel, normalizeZoomLevel, type ZoomCommand } from "../shared/app-zoom.js";
import { getMainWindow, getMainWindows, getServices } from "./app-state.js";
import { broadcastSettingsSnapshot } from "../ipc/domains/settings.js";
import { createLogger } from "../lib/logger.js";

import { preserveBrowserGuestZoom } from "./browser/browser-guest-tracking.js";

const log = createLogger("app-zoom");
let pending: Promise<void> = Promise.resolve();

export function runAppZoomCommand(command: ZoomCommand): Promise<void> {
  return enqueueZoomCommand(command);
}

function enqueueZoomCommand(command: ZoomCommand, steps: () => number = () => 1): Promise<void> {
  const run = pending.then(async () => {
    const settingsService = getServices()?.settingsService;
    if (!settingsService) return;
    let level = normalizeZoomLevel(settingsService.get("appearance").zoomLevel);
    const count = steps();
    for (let step = 0; step < count; step++) level = nextZoomLevel(level, command);
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
  let wheelBatch: { command: ZoomCommand; steps: number } | undefined;
  win.webContents.on("zoom-changed", (event, direction) => {
    event.preventDefault();
    const command = direction === "in" ? "in" : "out";
    if (wheelBatch?.command === command) {
      wheelBatch.steps = Math.min(MAX_ZOOM_LEVEL - MIN_ZOOM_LEVEL, wheelBatch.steps + 1);
      return;
    }
    const batch: { command: ZoomCommand; steps: number } = { command, steps: 1 };
    wheelBatch = batch;
    void enqueueZoomCommand(command, () => {
      if (wheelBatch === batch) wheelBatch = undefined;
      return batch.steps;
    }).catch(() => log.warn("Could not save app zoom"));
  });
}
