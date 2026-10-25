// Use the shared app version; the runtime's version API reports the binary version in unpackaged runs.
// The host-renderer guard is the disclosure boundary for this unprojected response.
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerAppHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  ipcMain.handle(CHANNELS.app.info, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.app.info, e);
      return UNAUTHORIZED_FRAME;
    }
    const { app } = await import("electron");
    return {
      version: getAveAppVersion(),
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node ?? "",
      chromeVersion: process.versions.chrome ?? "",
      v8Version: process.versions.v8 ?? "",
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath("userData"),
    };
  });
}
