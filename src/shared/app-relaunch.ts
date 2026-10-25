export type AppRelaunchError =
  | "unauthorized-frame"
  | "user-keyboard-required"
  | "plugin-install-in-progress"
  | "update-install-in-progress"
  | "relaunch-in-progress"
  | "relaunch-unsupported"
  | "relaunch-failed";

export type AppRelaunchResult = { ok: true } | { ok: false; error: AppRelaunchError };
