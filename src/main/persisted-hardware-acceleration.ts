// Read the saved GPU preference before app.whenReady(), when acceleration can still be changed.
import { readPersistedSystemBooleanSync } from "./persisted-settings-sync.js";
import { resolveEnvBackedBoolean } from "../shared/env-backed-settings.js";

// Undefined means no user choice; keep it distinct from false so the Windows platform default is preserved.
export function readPersistedHardwareAccelerationSync(
  userDataPath: string,
): boolean | undefined {
  return readPersistedSystemBooleanSync(userDataPath, "hardwareAcceleration");
}

export interface HardwareAccelerationInputs {
  // Persisted `system.hardwareAcceleration`, or undefined when unset.
  readonly setting: boolean | undefined;
  // The process environment. Which variable can force this on, and at which value, is ENV_BACKED_SETTINGS' business — the same registry the Settings UI
  // reads to tell the user the environment is deciding.
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
}

// Environment GPU recovery override wins over saved preference, then platform default.
// It must remain usable when a bad preference prevents rendering; disabled acceleration still permits a software compositor child.
export function resolveHardwareAcceleration(inputs: HardwareAccelerationInputs): boolean {
  return resolveEnvBackedBoolean(
    "system.hardwareAcceleration",
    inputs.setting,
    inputs.env,
    inputs.platform !== "win32" && inputs.platform !== "linux",
  );
}
