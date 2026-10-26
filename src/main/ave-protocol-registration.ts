import { lstatSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isE2eTestRuntime } from "../boot/dev-flags.js";

export const AVE_NSIS_PER_MACHINE_MARKER_FILENAME =
  ".ave-nsis-per-machine-v1";

export type PackagedWindowsProtocolMarkerState =
  | "present"
  | "absent"
  | "unknown";

export type LstatSync = typeof lstatSync;

function normalizeLocalDriveWindowsPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.startsWith("\\\\")
  ) {
    return null;
  }

  if (!win32.isAbsolute(value)) {
    return null;
  }

  const normalized = win32.normalize(value);
  if (!/^[a-z]:\\$/i.test(win32.parse(normalized).root)) {
    return null;
  }

  return normalized;
}

// Only the validated per-machine installer marker suppresses HKCU protocol registration. Reject unsafe paths before I/O; unexpected marker-read errors
// fail closed with a path-free warning.
export function getPackagedWindowsProtocolMarkerState(
  currentExecutable: unknown,
  inspectMarker: LstatSync = lstatSync,
): PackagedWindowsProtocolMarkerState {
  const normalizedExecutable =
    normalizeLocalDriveWindowsPath(currentExecutable);
  if (normalizedExecutable === null) {
    return "unknown";
  }

  const markerPath = win32.join(
    win32.dirname(normalizedExecutable),
    AVE_NSIS_PER_MACHINE_MARKER_FILENAME,
  );

  try {
    const marker = inspectMarker(markerPath, { throwIfNoEntry: false });
    return marker?.isFile() === true ? "present" : "absent";
  } catch {
    return "unknown";
  }
}

// Skip protocol registration for unpackaged or isolated launches so they cannot take installed deep links.
// Skip per-machine installs to avoid shadowing HKLM with HKCU; unknown marker state fails closed.
type AveProtocolClientRegistrationSkipReason =
  | "unpackaged"
  | "e2e-runtime"
  | "isolated-ave-home"
  | "isolated-user-data-dir"
  | "nsis-per-machine-install"
  | "nsis-marker-unknown";

export type AveProtocolClientRegistrationDecision =
  | { readonly register: true }
  | { readonly register: false; readonly reason: AveProtocolClientRegistrationSkipReason };

export interface AveProtocolClientRegistrationInput {
  // `app.isPackaged`.
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  // The process environment, after the packaged-env scrub.
  readonly env: NodeJS.ProcessEnv;
  // `defaultAveHome()`: the real data home, `~/.ave`.
  readonly defaultAveHome: string;
  // `app.commandLine.hasSwitch("user-data-dir")`.
  readonly hasUserDataDirSwitch: boolean;
  // Probed only for a packaged Windows launch on its real profile.
  readonly probeWindowsMarker: () => PackagedWindowsProtocolMarkerState;
}

function isIsolatedAveHome(env: NodeJS.ProcessEnv, defaultAveHome: string, platform: NodeJS.Platform): boolean {
  const override = env.AVE_HOME;
  if (override === undefined) return false;
  // Same normalization as `aveHome()`; Windows paths compare case-insensitively.
  const pathApi = platform === "win32" ? win32 : posix;
  const resolved = pathApi.resolve(override);
  const real = pathApi.resolve(defaultAveHome);
  return platform === "win32"
    ? resolved.toLowerCase() !== real.toLowerCase()
    : resolved !== real;
}

// Only a packaged production app on its real profile may register as the OS protocol handler.
export function decideAveProtocolClientRegistration(
  input: AveProtocolClientRegistrationInput,
): AveProtocolClientRegistrationDecision {
  if (!input.isPackaged) return { register: false, reason: "unpackaged" };
  if (isE2eTestRuntime(input.env)) return { register: false, reason: "e2e-runtime" };
  if (isIsolatedAveHome(input.env, input.defaultAveHome, input.platform)) {
    return { register: false, reason: "isolated-ave-home" };
  }
  if (input.hasUserDataDirSwitch) return { register: false, reason: "isolated-user-data-dir" };
  if (input.platform === "win32") {
    const marker = input.probeWindowsMarker();
    if (marker === "present") return { register: false, reason: "nsis-per-machine-install" };
    if (marker === "unknown") return { register: false, reason: "nsis-marker-unknown" };
  }
  return { register: true };
}
