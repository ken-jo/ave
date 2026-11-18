import { app, webContents } from "electron";
import { securitySettingsGestures } from "../ipc/security-settings-gesture.js";

let installed = false;
export function installSecuritySettingsGestureTracking(): void {
  if (installed) return;
  installed = true;
  for (const contents of webContents.getAllWebContents()) securitySettingsGestures.observe(contents);
  app.on("web-contents-created", (_event, contents) => securitySettingsGestures.observe(contents));
}
