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

/**
 * A per-machine NSIS install places a versioned regular-file marker beside
 * the executable. Electron's Windows protocol setter always writes HKCU, so
 * that marker is the only reason to skip it. ZIP/win-unpacked builds have no
 * marker and keep Electron's normal self-registration behavior.
 *
 * Validate the executable path lexically before touching the filesystem. This
 * prevents malformed, relative, UNC, and device paths from triggering I/O.
 * Unexpected filesystem errors are deliberately tri-state unknown: callers
 * fail closed by skipping registration and emitting a generic warning without
 * exposing the path.
 */
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

/**
 * Why a launch did not register itself as the OS `ave://` handler.
 *
 * - `unpackaged`: a dev / E2E / CDP launch of the vendored Electron. Its
 *   executable is a worktree build, so registering it would point the user's
 *   installed deep links at a directory that disappears.
 * - `e2e-runtime`: the E2E harness signal (`AVE_E2E=1` under `NODE_ENV=test`).
 *   Packaged boot scrubs `AVE_E2E` before this runs, so at runtime this only
 *   repeats `unpackaged`; it is kept so a spec never depends on packaging state.
 * - `isolated-ave-home`: `AVE_HOME` points somewhere other than `~/.ave`, the
 *   way the CDP launcher, packaged smokes and bench runs isolate a launch.
 * - `isolated-user-data-dir`: an explicit `--user-data-dir` switch, the way the
 *   E2E harness and the CDP launcher isolate the Chromium profile.
 * - `nsis-per-machine-install`: the per-machine installer owns the HKLM
 *   association; Electron's Windows setter would shadow it with HKCU.
 * - `nsis-marker-unknown`: the per-machine marker could not be checked; fail
 *   closed rather than risk shadowing HKLM.
 */
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
  /** `app.isPackaged`. */
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  /** The process environment, after the packaged-env scrub. */
  readonly env: NodeJS.ProcessEnv;
  /** `defaultAveHome()`: the real data home, `~/.ave`. */
  readonly defaultAveHome: string;
  /** `app.commandLine.hasSwitch("user-data-dir")`. */
  readonly hasUserDataDirSwitch: boolean;
  /** Probed only for a packaged Windows launch on its real profile. */
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

/**
 * Whether this launch may make itself the OS default `ave://` handler
 * (`app.setAsDefaultProtocolClient`, which writes HKCU on Windows, the
 * LaunchServices default on macOS and the xdg default on Linux).
 *
 * Only a packaged production app on its real profile registers. Every
 * isolated launch — unpackaged, E2E, a relocated `AVE_HOME`, an explicit
 * `--user-data-dir` — skips, so a dev, test or CDP run can never take the
 * installed app's deep links. Pure: the caller supplies every signal.
 */
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
