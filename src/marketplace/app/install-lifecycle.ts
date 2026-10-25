import { isAppRelaunchRequested } from "../../main/app-relaunch-state.js";
import { hasExclusivePluginLifecycleMutation, hasPluginInstallInFlight } from "../../plugins/install-lifecycle.js";

let pendingMarketplaceInstalls = 0;

export function hasMarketplaceInstallInFlight(): boolean {
  return pendingMarketplaceInstalls > 0 || hasPluginInstallInFlight() || hasExclusivePluginLifecycleMutation();
}

export async function withMarketplaceInstall<T>(install: () => Promise<T>): Promise<T> {
  if (isAppRelaunchRequested()) {
    throw Object.assign(new Error("Marketplace installs are paused while Ave is restarting."), { code: "relaunch-in-progress" });
  }
  pendingMarketplaceInstalls += 1;
  try {
    return await install();
  } finally {
    pendingMarketplaceInstalls -= 1;
  }
}
