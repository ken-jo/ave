import { isAppRelaunchRequested } from "./app-relaunch-state.js";

// The updater closes windows before quitting; intercept its first quit for bounded cleanup and never restart that cleanup.
let appUpdateInstallRequested = false;
let appUpdateInstallPrepared = false;

export function beginAppUpdateInstallRequest(): void {
  if (isAppRelaunchRequested()) throw new Error("relaunch-in-progress");
  appUpdateInstallRequested = true;
  appUpdateInstallPrepared = false;
}

export function clearAppUpdateInstallRequested(): void {
  appUpdateInstallRequested = false;
  appUpdateInstallPrepared = false;
}

export function isAppUpdateInstallRequested(): boolean {
  return appUpdateInstallRequested;
}

export function isAppUpdateInstallPrepared(): boolean {
  return appUpdateInstallRequested && appUpdateInstallPrepared;
}

export function markAppUpdateInstallPrepared(): void {
  if (!appUpdateInstallRequested) return;
  appUpdateInstallPrepared = true;
}
