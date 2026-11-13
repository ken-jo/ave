import type { MainWindow } from "./main/main-window-host.js";
import { acquireHostInstanceLock } from "./main/host-instance-lock.js";
import { isAppQuitRequested } from "./main/app-state.js";

import { bootstrap as bootstrapHost, type BootLaunch } from "./boot.js";
import { createDesktopBootHost } from "./boot/desktop-host-runtime.js";

export async function bootstrap(
  projectRoot: string,
  mainWindow: MainWindow | null,
  getMainWindow: () => MainWindow | null,
  launch: BootLaunch,
  startupSignal?: AbortSignal,
) {
  startupSignal?.throwIfAborted();
  if (isAppQuitRequested()) return null;
  await acquireHostInstanceLock();
  startupSignal?.throwIfAborted();
  if (isAppQuitRequested()) return null;
  const host = createDesktopBootHost(projectRoot);
  return bootstrapHost(projectRoot, mainWindow, getMainWindow, launch, host, startupSignal);
}
