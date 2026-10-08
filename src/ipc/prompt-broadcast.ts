import { CHANNELS } from "../contract/app-contract.js";
import type { IpcDeps } from "./types.js";

export function broadcastPromptsUpdated(deps: IpcDeps): void {
  for (const win of deps.getAppWindows?.() ?? [deps.getMainWindow()]) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(CHANNELS.prompts.updated);
  }
}
