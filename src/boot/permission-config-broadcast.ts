import type { MainWindow } from "../main/main-window-host.js";

import { sendToWindow } from "../ipc/safe-send.js";
import { PERMISSIONS } from "../shared/ipc-channels.js";

export function broadcastPermissionConfigChangedFromHost(windows: readonly MainWindow[]): void {
  for (const window of windows) sendToWindow(window, PERMISSIONS.configChanged, {});
}
