import { join } from "node:path";
import { app } from "electron";

/** The desktop app's host resources folder: the packaged app's resources folder, or the checkout's `resources` in development. */
export function desktopResourcePath(projectRoot: string): string {
  return app.isPackaged ? process.resourcesPath : join(projectRoot, "resources");
}
