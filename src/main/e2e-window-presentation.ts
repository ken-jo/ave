import type { BrowserWindow } from "electron";
import { getIsPackaged, isConfigured, isE2eTestRuntime, isPackagedElectronProcess } from "../boot/dev-flags.js";

export function isBackgroundE2eRuntime(): boolean {
  const packaged = isConfigured() ? getIsPackaged() : isPackagedElectronProcess();
  return !packaged && isE2eTestRuntime() && process.env.AVE_NATIVE_FIXTURE_MODE !== "foreground";
}

export function showWindowForRuntime(window: BrowserWindow): void {
  if (isBackgroundE2eRuntime()) window.showInactive();
  else window.show();
}
