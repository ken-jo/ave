// Boot reconciliation is unconditional because OS state has not yet been synchronized; surface every registration conflict.
import { reconcileGlobalShortcuts } from "./global-shortcuts.js";
import {
  reconcileStartupLaunch,
  notifyStartupLaunchFailureIfNeeded,
} from "./startup-launch.js";
import type { ShortcutSettings, SystemSettings } from "../data/settings-store.js";

// Injectable surface so boot wiring can be unit-tested without Electron.
export interface OsIntegrationReconcilers {
  reconcileGlobalShortcuts: typeof reconcileGlobalShortcuts;
  reconcileStartupLaunch: typeof reconcileStartupLaunch;
  notifyStartupLaunchFailureIfNeeded: typeof notifyStartupLaunchFailureIfNeeded;
}

function defaultReconcilers(): OsIntegrationReconcilers {
  return {
    reconcileGlobalShortcuts,
    reconcileStartupLaunch,
    notifyStartupLaunchFailureIfNeeded,
  };
}

// Reconcile the OS-level global accelerator + login item to the persisted settings at boot, surfacing a failed login-item registration to the user
// (mirroring the global-shortcut conflict path). Called once from `main()` after services + tray exist.
export function reconcileOsIntegrationOnBoot(
  settings: { shortcuts: ShortcutSettings; system: SystemSettings },
  deps: OsIntegrationReconcilers = defaultReconcilers(),
): void {
  deps.reconcileGlobalShortcuts(settings.shortcuts);
  const launchInput = {
    launchAtStartup: settings.system.launchAtStartup ?? false,
    launchMinimized: settings.system.launchMinimized ?? false,
  };
  const launchState = deps.reconcileStartupLaunch(launchInput);
  deps.notifyStartupLaunchFailureIfNeeded(launchInput, launchState);
}
