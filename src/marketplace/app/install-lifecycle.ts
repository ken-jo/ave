import { hasInstalledStateMutationInFlight, withInstalledStateMutation } from "../../main/installed-state-mutation.js";
import { hasExclusivePluginLifecycleMutation, hasPluginInstallInFlight } from "../../plugins/install-lifecycle.js";

export function hasMarketplaceInstallInFlight(): boolean {
  return hasInstalledStateMutationInFlight() || hasPluginInstallInFlight() || hasExclusivePluginLifecycleMutation();
}

export function withMarketplaceInstall<T>(install: () => Promise<T>): Promise<T> {
  return withInstalledStateMutation(install);
}
