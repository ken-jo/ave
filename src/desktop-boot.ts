import type { MainWindow } from "./main/main-window-host.js";
import { acquireHostInstanceLock } from "./main/host-instance-lock.js";

import { bootstrap as bootstrapHost, type BootLaunch } from "./boot.js";
import { createDesktopBootHost } from "./boot/desktop-host-runtime.js";

export async function bootstrap(
  projectRoot: string,
  mainWindow: MainWindow | null,
  getMainWindow: () => MainWindow | null,
  launch: BootLaunch,
) {
  await acquireHostInstanceLock();
  const host = createDesktopBootHost(projectRoot);
  return bootstrapHost(projectRoot, mainWindow, getMainWindow, launch, host);
}
