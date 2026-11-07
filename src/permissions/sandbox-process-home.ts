import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";

import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { appOwnedSandboxHomeRoot, ensureSandboxPrivateRoot } from "./asrt-sandbox.js";
import { drainAgentObservationHome, registerAgentObservationHome } from "../tools/agent-observation-context.js";
import { readWindowsProcessRunStates, type ProcessRunStateProbe } from "./windows-process-start-time.js";

const log = createLogger("sandbox-process-home");
export const SANDBOX_HOME_PREFIX = "ave-sandbox-home-";
// Windows HOMEs share the host temp directory with other Ave instances, so each has a sibling owner marker for the boot sweep (`sweepStaleWindowsSandboxHomes`). The sibling sits in the temp root, which no confined process can write.
export const SANDBOX_HOME_OWNER_SUFFIX = ".owner";
const OWNER_MARKER_MAX_BYTES = 128;
const CLEANUP_RETRY_DELAYS_MS = [50, 250, 1_000] as const;

// The sandbox HOMEs this process created and has not yet removed.
const liveHomes = new Set<string>();

// The sandbox HOMEs this process created and has not yet removed. The boot sweep keeps them: a HOME a process started during this boot is using is never removed, whatever order boot and the first spawn run in.
export function sandboxProcessHomesInUse(): ReadonlySet<string> {
  return liveHomes;
}

// Where a sandbox HOME is created: the app-owned root on macOS and Linux, which the sandbox read floor denies to every other confined process (`appOwnedSandboxHomeRoot`); the host temp directory on Windows, unchanged, where a confined process reaches a path only through an ACL grant.
function sandboxHomeParent(platform: NodeJS.Platform): string {
  if (platform === "win32") return realpathSync.native(tmpdir());
  return realpathSync.native(ensureSandboxPrivateRoot(appOwnedSandboxHomeRoot()));
}

export interface SandboxHomeOwner {
  readonly pid: number;
  // Process creation time as a UTC FILETIME, so a reused pid does not pass for the owner.
  readonly startTime: string;
}

const resolvedOwnerMarkers = new WeakMap<ProcessRunStateProbe, string>();
const pendingOwnerMarkers = new WeakMap<ProcessRunStateProbe, Promise<string | null>>();
const failedOwnerProbes = new WeakMap<ProcessRunStateProbe, number>();
// A blocked probe (script policy) would otherwise cost one spawn and timeout per HOME.
const OWNER_PROBE_FAILURE_BACKOFF_MS = 60_000;
let ownerProbeFailureLogged = false;

// The host's marker text. Only a success is cached; a failure is retried by the first HOME after the backoff.
function resolveHostOwnerMarker(probe: ProcessRunStateProbe): Promise<string | null> {
  const known = resolvedOwnerMarkers.get(probe);
  if (known !== undefined) return Promise.resolve(known);
  const failedAt = failedOwnerProbes.get(probe);
  if (failedAt !== undefined && Date.now() - failedAt < OWNER_PROBE_FAILURE_BACKOFF_MS) return Promise.resolve(null);
  let pending = pendingOwnerMarkers.get(probe);
  if (pending === undefined) {
    pending = probe([process.pid]).then((states) => {
      const state = states.get(process.pid);
      if (!state?.running || state.startTime === null) return null;
      return JSON.stringify({ pid: process.pid, startTime: state.startTime } satisfies SandboxHomeOwner);
    }).catch(() => null).then((marker) => {
      pendingOwnerMarkers.delete(probe);
      if (marker !== null) resolvedOwnerMarkers.set(probe, marker);
      else failedOwnerProbes.set(probe, Date.now());
      if (marker === null && !ownerProbeFailureLogged) {
        ownerProbeFailureLogged = true;
        log.debug("sandbox process HOME owner start time unavailable; HOMEs stay unmarked until it resolves");
      }
      return marker;
    });
    pendingOwnerMarkers.set(probe, pending);
  }
  return pending;
}

// Boot starts the host start-time probe early so the first HOME is normally marked before it exists.
export function warmSandboxHomeOwner(): void {
  void resolveHostOwnerMarker(readWindowsProcessRunStates);
}

export function _resolveHostOwnerMarkerForTest(probe: ProcessRunStateProbe): Promise<string | null> {
  return resolveHostOwnerMarker(probe);
}

function writeOwnerMarker(homePath: string, marker: string): boolean {
  try {
    writeFileSync(`${homePath}${SANDBOX_HOME_OWNER_SUFFIX}`, marker, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    log.debug({ err: errorMessage(err) }, "sandbox process HOME owner marker not written");
    return false;
  }
}

// With the host start time known, the marker is written before the HOME exists, so no crash leaves an unmarked HOME; otherwise mkdtemp, and the marker follows the first probe. An unmarked HOME is kept by the sweep.
function createHomeDirectory(parentRoot: string, platform: NodeJS.Platform, probe: ProcessRunStateProbe): string {
  const marker = platform === "win32" ? resolvedOwnerMarkers.get(probe) : undefined;
  if (marker !== undefined) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const path = join(parentRoot, `${SANDBOX_HOME_PREFIX}${randomBytes(6).toString("hex")}`);
      if (!writeOwnerMarker(path, marker)) continue;
      try {
        mkdirSync(path, { mode: 0o700 });
        return path;
      } catch (err) {
        rmSync(`${path}${SANDBOX_HOME_OWNER_SUFFIX}`, { force: true });
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
  }
  const path = mkdtempSync(join(parentRoot, SANDBOX_HOME_PREFIX));
  if (platform === "win32") {
    void resolveHostOwnerMarker(probe).then((resolved) => {
      if (resolved !== null && liveHomes.has(path)) writeOwnerMarker(path, resolved);
    });
  }
  return path;
}

// The HOME's owner from its sibling marker, or null when the marker is absent, not a plain small file, or malformed.
export async function readSandboxHomeOwner(homePath: string): Promise<SandboxHomeOwner | null> {
  const markerPath = `${homePath}${SANDBOX_HOME_OWNER_SUFFIX}`;
  try {
    const entry = await lstat(markerPath);
    if (!entry.isFile() || entry.size > OWNER_MARKER_MAX_BYTES) return null;
    const handle = await open(markerPath, "r");
    let text: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > OWNER_MARKER_MAX_BYTES) return null;
      const buffer = Buffer.alloc(OWNER_MARKER_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > OWNER_MARKER_MAX_BYTES) return null;
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, startTime } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
    if (typeof startTime !== "string" || !/^[0-9]{1,20}$/.test(startTime)) return null;
    return { pid, startTime };
  } catch {
    return null;
  }
}

export interface SandboxProcessHome {
  readonly path: string;
  readonly env: Readonly<Record<string, string>>;
  cleanup(): void;
}

export function sandboxProcessProfileEnvironment(
  homePath: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  if (platform === "win32") {
    const appData = win32.join(homePath, "AppData", "Roaming");
    const localAppData = win32.join(homePath, "AppData", "Local");
    const env: Record<string, string> = {
      HOME: homePath,
      USERPROFILE: homePath,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      // Windows only, and it DOES take effect here: ASRT deletes the `TMPDIR` it generates on this platform ("serves no purpose on Windows and breaks msys2 tools") and sets no replacement, so the profile's own value is what the child sees. Node reads TEMP then TMP; both, so a child that consults either lands in the same place.
      TEMP: win32.join(homePath, "tmp"),
      TMP: win32.join(homePath, "tmp"),
      AVE_DOCUMENT_JOURNAL: win32.join(homePath, "document-observation", "journal.jsonl"),
    };
    const drive = win32.parse(homePath).root.slice(0, 2);
    if (/^[A-Za-z]:$/.test(drive)) {
      env.HOMEDRIVE = drive;
      env.HOMEPATH = homePath.slice(2) || "\\";
    } else {
      // Never inherit the real profile pair when TEMP is UNC-backed. Programs that use %HOMEDRIVE%%HOMEPATH% still resolve the isolated profile.
      env.HOMEDRIVE = "";
      env.HOMEPATH = homePath;
    }
    return env;
  }

  return {
    HOME: homePath,
    AVE_DOCUMENT_JOURNAL: join(homePath, "document-observation", "journal.jsonl"),
    XDG_CONFIG_HOME: join(homePath, "config"),
    XDG_DATA_HOME: join(homePath, "data"),
    XDG_CACHE_HOME: join(homePath, "cache"),
    XDG_STATE_HOME: join(homePath, "state"),
    // NO `TMPDIR` here, deliberately. On macOS and Linux ASRT writes its own `TMPDIR=` into the sandboxed command line, which is evaluated INSIDE the sandbox and therefore wins over anything this env carries. Setting one would be a value that never applies — a comment claiming a substitution the child never sees. The POSIX temp directory is set where it CAN take effect: inside the wrap, per principal (`sandboxTempEnvLaunch`, `asrt-sandbox.ts`).
  };
}

function createProfileDirectories(env: Readonly<Record<string, string>>): void {
  for (const directory of new Set([
    env.HOME,
    env.USERPROFILE,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_STATE_HOME,
    // The temp root has to EXIST, and that is the whole point of it being here. ASRT substitutes a temp root and creates nothing, so a confined child's `os.tmpdir` routinely names a directory that is not there — `readdirSync` and `mkdtempSync` fail `ENOENT` while a recursive `mkdir` on the same path succeeds. An unguarded sweep of `tmpdir` in a plugin's activation body therefore does not degrade a feature, it stops the plugin from loading.
    env.TMPDIR,
    env.TEMP,
    env.TMP,
  ])) {
    if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

// Give each process a fresh HOME and temp root so writable config cannot alter later commands; never store durable state there because cleanup discards it. POSIX homes live under a read-denied app root with only the process's own home re-allowed; Windows sets TEMP/TMP, while POSIX wrap/bootstrap owns TMPDIR.
export function createSandboxProcessHome(
  platform: NodeJS.Platform = process.platform,
  removeHome: typeof rmSync = rmSync,
  probeOwner: ProcessRunStateProbe = readWindowsProcessRunStates,
): SandboxProcessHome {
  const parentRoot = sandboxHomeParent(platform);
  const createdPath = createHomeDirectory(parentRoot, platform, probeOwner);
  let homePath = createdPath;
  let env: Readonly<Record<string, string>>;
  try {
    if (lstatSync(createdPath).isSymbolicLink()) {
      throw new Error(`refusing symlink sandbox process HOME: ${createdPath}`);
    }
    homePath = realpathSync.native(createdPath);
    if (
      dirname(homePath) !== parentRoot ||
      !basename(homePath).startsWith(SANDBOX_HOME_PREFIX)
    ) {
      throw new Error(`refusing unsafe sandbox process HOME: ${homePath}`);
    }

    env = Object.freeze(sandboxProcessProfileEnvironment(homePath, platform));
    createProfileDirectories(env);
    mkdirSync(join(homePath, "document-observation"), { mode: 0o700 });
    registerAgentObservationHome(homePath);
  } catch (err) {
    if (
      dirname(createdPath) === parentRoot &&
      basename(createdPath).startsWith(SANDBOX_HOME_PREFIX)
    ) {
      try {
        rmSync(createdPath, { recursive: true, force: true });
        rmSync(`${createdPath}${SANDBOX_HOME_OWNER_SUFFIX}`, { force: true });
      } catch {
        // Preserve the initialization error; cleanup failures are secondary.
      }
    }
    throw err;
  }

  liveHomes.add(homePath);
  let cleaned = false;
  let failedAttempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const attemptCleanup = (): void => {
    try {
      removeHome(homePath, { recursive: true, force: true });
      cleaned = true;
      liveHomes.delete(homePath);
      failedAttempts = 0;
      // After the HOME, so a crash between the two leaves an orphan marker the sweep drops, never an unmarked HOME.
      if (platform === "win32") {
        try {
          rmSync(`${homePath}${SANDBOX_HOME_OWNER_SUFFIX}`, { force: true });
        } catch (err) {
          log.debug({ err: errorMessage(err) }, "sandbox process HOME owner marker not removed");
        }
      }
    } catch (err) {
      failedAttempts += 1;
      log.warn(
        { homePath, err: errorMessage(err) },
        "sandbox process HOME cleanup failed",
      );
      const delay = CLEANUP_RETRY_DELAYS_MS[failedAttempts - 1];
      if (delay === undefined) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        attemptCleanup();
      }, delay);
      const nodeTimer = retryTimer as ReturnType<typeof setTimeout> & { unref?: () => void };
      nodeTimer.unref?.();
    }
  };
  return Object.freeze({
    path: homePath,
    env,
    cleanup(): void {
      if (cleaned) return;
      drainAgentObservationHome(homePath);
      if (
        dirname(homePath) !== parentRoot ||
        !basename(homePath).startsWith(SANDBOX_HOME_PREFIX)
      ) {
        log.error({ homePath }, "sandbox process HOME cleanup refused unsafe path");
        return;
      }
      // A later definitive lifecycle event may arrive before the scheduled retry. Let that call retry immediately instead of waiting for backoff.
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      attemptCleanup();
    },
  });
}
