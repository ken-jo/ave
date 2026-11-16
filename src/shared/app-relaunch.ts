export type AppRelaunchError =
  | "unauthorized-frame"
  | "user-keyboard-required"
  | "plugin-install-in-progress"
  | "update-install-in-progress"
  | "relaunch-in-progress"
  | "relaunch-unsupported"
  | "relaunch-failed";

export type AppRelaunchResult = { ok: true } | { ok: false; error: AppRelaunchError };

export const APP_RESTART_ERROR_KEYS: Record<AppRelaunchError, string> = {
  "unauthorized-frame": "permissionsTab.sandboxRestartUnauthorized",
  "user-keyboard-required": "permissionsTab.sandboxRestartGestureRequired",
  "plugin-install-in-progress": "permissionsTab.sandboxRestartPluginBusy",
  "update-install-in-progress": "permissionsTab.sandboxRestartUpdateBusy",
  "relaunch-in-progress": "permissionsTab.sandboxRestartBusy",
  "relaunch-unsupported": "permissionsTab.sandboxRestartUnsupported",
  "relaunch-failed": "permissionsTab.sandboxRestartFailed",
};
