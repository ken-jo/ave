// Unpackaged builds never register login items; Windows persists --hidden while macOS applies the saved login-launch preference.
import { app } from "electron";
import { createLogger } from "../lib/logger.js";
import { getServices } from "./app-state.js";
import { t } from "../i18n/index.js";

const log = createLogger("ave");

// Marker argument for a hidden (tray-only) launch.
export const HIDDEN_LAUNCH_ARG = "--hidden";

export interface StartupLaunchInput {
  launchAtStartup: boolean;
  launchMinimized: boolean;
}

export interface StartupLaunchState {
  // Whether `openAtLogin` is actually set according to the OS.
  openAtLogin: boolean;
  // Whether a hidden start is configured for the login item.
  openAsHidden: boolean;
  // Whether the login-launch state and minimized preference, or an explicit --hidden argument, require boot to suppress the first window show.
  wasOpenedAsHidden: boolean;
  // `true` when the setting was actually applied to the OS this platform/mode.
  applied: boolean;
  // Why `applied` is false, if it is.
  reason?: "dev-unpackaged" | "platform-unsupported";
}

// Injectable Electron surface so the platform semantics can be unit-tested without spinning Electron. Defaults bind to the real `app` + `process`.
export interface StartupLaunchDeps {
  isPackaged: () => boolean;
  platform: () => NodeJS.Platform;
  setLoginItemSettings: (settings: Electron.Settings) => void;
  getLoginItemSettings: () => Electron.LoginItemSettings;
  // Process argv — used on Windows to detect a `--hidden` cold start.
  argv: () => readonly string[];
  launchMinimized: () => boolean;
}

function defaultDeps(): StartupLaunchDeps {
  return {
    isPackaged: () => app.isPackaged,
    platform: () => process.platform,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    getLoginItemSettings: () => app.getLoginItemSettings(),
    argv: () => process.argv,
    launchMinimized: () => getServices()?.settingsService.getAll().system.launchMinimized ?? false,
  };
}

// Apply the persisted launch-at-startup settings to the OS and report the resulting state (queried back from the OS so the UI reflects reality, not the
// value we just wrote).
export function reconcileStartupLaunch(
  input: StartupLaunchInput,
  deps: StartupLaunchDeps = defaultDeps(),
): StartupLaunchState {
  const platform = deps.platform();

  // dev (unpackaged): do not register a login item — it would point at the Electron dev binary. Report honestly.
  if (!deps.isPackaged()) {
    log.info(
      "startup-launch: skipped in dev (unpackaged) — launchAtStartup=%s launchMinimized=%s",
      input.launchAtStartup,
      input.launchMinimized,
    );
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "dev-unpackaged",
    };
  }

  const settings: Electron.Settings = { openAtLogin: input.launchAtStartup };
  if (platform === "win32") {
    // Windows has no openAsHidden — express "start hidden" via a launch arg the boot path reads. Only pass it when both flags are on.
    settings.args =
      input.launchAtStartup && input.launchMinimized ? [HIDDEN_LAUNCH_ARG] : [];
  }

  try {
    deps.setLoginItemSettings(settings);
  } catch (err) {
    log.warn("startup-launch: setLoginItemSettings failed: %s", (err as Error).message);
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "platform-unsupported",
    };
  }

  return readStartupLaunchState({ ...deps, launchMinimized: () => input.launchMinimized });
}

// Query the current OS login-item state. On Windows the OS does not report `openAsHidden`, so we derive "hidden" from our own `--hidden` arg (both in
// the stored login-item args and in the current process argv for cold-start detection).
export function readStartupLaunchState(
  deps: StartupLaunchDeps = defaultDeps(),
): StartupLaunchState {
  if (!deps.isPackaged()) {
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "dev-unpackaged",
    };
  }

  const platform = deps.platform();
  const os = deps.getLoginItemSettings();
  const argvHidden = deps.argv().includes(HIDDEN_LAUNCH_ARG);

  if (platform === "win32") {
    // Electron does not report `openAsHidden` on Windows, so "hidden" is derived from our own `--hidden` launch arg: prefer the persisted login-item args
    // (`launchItems`) when present, else fall back to argv.
    const launchItems = (os as Electron.LoginItemSettings & {
      launchItems?: Array<{ args?: string[] }>;
    }).launchItems;
    const hiddenConfigured =
      launchItems?.some((item) => item.args?.includes(HIDDEN_LAUNCH_ARG)) ?? argvHidden;
    return {
      openAtLogin: os.openAtLogin,
      openAsHidden: hiddenConfigured,
      wasOpenedAsHidden: argvHidden,
      applied: true,
    };
  }

  // The OS reports a login launch; the host owns whether it opens minimized.
  const minimized = platform === "darwin" && deps.launchMinimized();
  return {
    openAtLogin: os.openAtLogin,
    openAsHidden: os.openAtLogin && minimized,
    wasOpenedAsHidden: (os.wasOpenedAtLogin && minimized) || argvHidden,
    applied: platform === "darwin" || platform === "linux",
    reason: platform === "darwin" || platform === "linux" ? undefined : "platform-unsupported",
  };
}

// Notify only when requested startup registration genuinely failed; deliberate development skips and disabling startup remain silent.
export function notifyStartupLaunchFailureIfNeeded(
  input: StartupLaunchInput,
  state: StartupLaunchState,
  notify: (input: StartupLaunchInput, state: StartupLaunchState) => void = defaultNotifyStartupLaunchFailure,
): void {
  if (!input.launchAtStartup) return;
  if (state.applied) return;
  if (state.reason === "dev-unpackaged") return;
  log.warn(
    "startup-launch: launch-at-startup requested but not applied (reason=%s) — notifying user",
    state.reason ?? "unknown",
  );
  notify(input, state);
}

function defaultNotifyStartupLaunchFailure(
  _input: StartupLaunchInput,
  _state: StartupLaunchState,
): void {
  const services = getServices();
  services?.notificationService?.fire({
    kind: "system",
    title: t("startupTab.launchRegisterFailedTitle"),
    body: t("startupTab.launchRegisterFailedBody"),
  });
}
