import { join } from "node:path";
import { app } from "electron";
import { verifyWindowsPathKindHelper } from "./windows-path-kind-launcher.js";

/** The desktop app's host resources folder: the packaged app's resources folder, or the checkout's `resources` in development. */
export function desktopResourcePath(projectRoot: string): string {
  if (app.isPackaged) return process.resourcesPath;
  const resources = join(projectRoot, "resources");
  if (process.platform === "win32") verifyWindowsPathKindHelper(resources);
  return resources;
}
