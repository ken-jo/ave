import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { lockWindowsExecutable } from "../../scripts/lib/windows-locked-executable.mjs";
import { windowsPeImageDigest } from "../../scripts/lib/windows-path-kind-image-digest.mjs";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { decodeWindowsNativeReply } from "../shared/windows-native-host.js";
import { getHostResources } from "./host-resources.js";

// The signing-stable image digest of the helper built with this bundle; packaging requires the shipped helper to match.
declare const __AVE_WINDOWS_PATH_KIND_SHA256__: string | null;

// The helper's one answer about a drive: the OS has no mapping for it (native/windows-path-kind/README.md).
const EXIT_NO_MAPPING = 1;

// What to do when the helper is broken: it ships with Ave, so the install is incomplete.
const REPAIR = "Reinstall Ave; in a development checkout, build it with bun run build:windows-path-kind.";
// What to do when the helper gave no answer (helper-unavailable): the same restart wording as the home privacy notice.
const RESTART = "Restart Ave; if it persists, reinstall Ave.";

/** Where the helper ships inside the host resources folder `resourcePath`; it may be missing from an incomplete install. */
export function windowsPathKindHelperIn(resourcePath: string): string {
  return join(resourcePath, "windows-path-kind", process.arch, "ave-path-kind.exe");
}

export function resolveWindowsPathKindHelper(resourcePath = getHostResources().resourcePath): string {
  const binary = windowsPathKindHelperIn(resourcePath);
  if (!existsSync(binary)) {
    throw missingWindowsPathKindHelper();
  }
  verifyWindowsPathKindHelper(resourcePath);
  return binary;
}

/** Dispatch synchronously while the file and its parents are held. An async child is opened before spawn returns. */
export function withWindowsPathKindHelper<T>(launch: (helper: string) => T, resourcePath = getHostResources().resourcePath): T {
  if (!pinned()) return launch(resolveWindowsPathKindHelper(resourcePath));
  let executable: ReturnType<typeof lockWindowsExecutable>;
  try {
    executable = lockWindowsExecutable(windowsPathKindHelperIn(resourcePath));
  } catch {
    throw missingWindowsPathKindHelper();
  }
  try {
    assertBuiltHelper(executable.bytes);
    return launch(executable.path);
  } finally {
    executable.close();
  }
}

// Unbundled source modules under unit tests carry no pin.
const pinned = (): boolean => typeof __AVE_WINDOWS_PATH_KIND_SHA256__ !== "undefined";

function assertBuiltHelper(bytes: Buffer): void {
  let digest: string | undefined;
  try {
    digest = windowsPeImageDigest(bytes);
  } catch {
    digest = undefined;
  }
  if (digest === undefined || digest !== __AVE_WINDOWS_PATH_KIND_SHA256__) {
    throw windowsPathKindHelperUnavailable(`Windows folder classifier does not match this build of Ave. ${REPAIR}`);
  }
}

/** Packaged, system-directory and checkout helpers alike must carry the image this bundle was built with. */
export function verifyWindowsPathKindHelper(resourcePath: string): void {
  if (!pinned()) return;
  let bytes: Buffer;
  try {
    bytes = readFileSync(windowsPathKindHelperIn(resourcePath));
  } catch {
    throw missingWindowsPathKindHelper();
  }
  assertBuiltHelper(bytes);
}

function missingWindowsPathKindHelper(): Error {
  return windowsPathKindHelperUnavailable("Windows folder classifier is missing. Ave cannot tell whether a drive is on another computer, "
    + `so it reads no folder on a drive. ${RESTART}`);
}

const HELPER_UNAVAILABLE = Symbol.for("ave.windows-path-kind-helper-unavailable");

/** The helper is missing, could not start, or did not answer in time: no answer, as opposed to a wrong one. No message names the
 * helper's install path: it reaches the privacy failure reason, the boot gate and the audit log. */
export function windowsPathKindHelperUnavailable(message: string, code?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { ...(code === undefined ? {} : { code }), [HELPER_UNAVAILABLE]: true });
}

/** True when `error` or any error in its cause chain carries the marker, so a wrapper never hides a helper failure. */
export function isWindowsPathKindHelperUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; typeof current === "object" && current !== null && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    if ((current as Record<symbol, unknown>)[HELPER_UNAVAILABLE] === true) return true;
    seen.add(current);
  }
  return false;
}

/** A child killed at its deadline: the sync spawns report ETIMEDOUT; `execFile` sets `killed` with no code (an output overrun has one). */
export function isWindowsPathKindHelperTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, killed } = error as { code?: unknown; killed?: unknown };
  return code === "ETIMEDOUT" || (killed === true && (code === null || code === undefined));
}

function helperTimeout(what: string, ms: number): NodeJS.ErrnoException {
  return windowsPathKindHelperUnavailable(`${what} did not answer within ${ms} ms`, "ETIMEDOUT");
}

export async function queryWindowsDocumentsDirectory(signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return withWindowsPathKindHelper(helper => new Promise((resolve, reject) => {
    execFile(helper, ["--documents-directory"], {
      windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs, encoding: "buffer", maxBuffer: 128 * 1024, signal,
    }, (error, stdout) => {
      try {
        signal?.throwIfAborted();
        if (error && isWindowsPathKindHelperTimeout(error)) throw helperTimeout("The Windows Documents lookup", TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs);
        if (error) throw error;
        resolve(decodeWindowsNativeReply(stdout).replace(/\r?\n$/u, ""));
      } catch (cause) {
        reject(cause);
      }
    });
  }));
}

// QueryDosDeviceW opens nothing on the drive; no-mapping is a classification, while helper failure is a broken-install error.
// See multi-source-git-marketplace.md §18.4.1 for the path contract.
export async function queryDosDevice(drive: string): Promise<string | null> {
  if (process.platform !== "win32") throw new Error("the folder classifier requires Windows");
  if (!/^[A-Za-z]:$/u.test(drive)) throw new Error(`not a drive letter: ${drive}`);
  return withWindowsPathKindHelper(helper => new Promise((resolve, reject) => {
    execFile(helper, [drive], { windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs, encoding: "buffer" }, (error, stdout, stderr) => {
      try {
        // A slow start is no broken install: a restart, not a reinstall, recovers it. Partial output is not read.
        if (error && isWindowsPathKindHelperTimeout(error)) {
          reject(helperTimeout(`the Windows folder classifier for ${drive}`, TOOL_TIMEOUT_POLICY.windowsPathKindQueryMs));
          return;
        }
        const reply = decodeWindowsNativeReply(stdout);
        const diagnostics = decodeWindowsNativeReply(stderr);
        if (error) {
          // A numeric code is the helper's exit status; a string one (ENOENT, EACCES) is a launch failure.
          if (error.code === EXIT_NO_MAPPING && !error.killed) {
            resolve(null);
            return;
          }
          // The spawn error's message and fields name the install path, so only its code is kept.
          if (typeof error.code === "string") {
            reject(windowsPathKindHelperUnavailable(`the Windows folder classifier for ${drive} could not start (${error.code}). ${RESTART}`));
            return;
          }
          const detail = diagnostics.trim();
          reject(new Error(`the Windows folder classifier failed for ${drive}${detail ? `: ${detail}` : ` (exit ${error.code ?? error.signal ?? "unknown"})`}. ${REPAIR}`));
          return;
        }
        const mapping = reply.replace(/\r?\n$/u, "");
        if (mapping.length === 0 || /[\r\n]/u.test(mapping)) {
          reject(new Error(`the Windows folder classifier answered ${JSON.stringify(reply)} for ${drive}, not one mapping. ${REPAIR}`));
          return;
        }
        resolve(mapping);
      } catch (cause) {
        reject(cause);
      }
    });
  }));
}

// The helper asks the OS directly; environment variables cannot choose a system verifier.
export async function queryWindowsSystemDirectory(timeout: number = TOOL_TIMEOUT_POLICY.globalCeilingMs, deadline?: number): Promise<string> {
  if (process.platform !== "win32") throw new Error("Windows system directory query requires Windows");
  const { resourcePath } = getHostResources();
  const launch = (helper: string) => new Promise<string>((resolve, reject) => {
    const options = windowsSystemDirectorySpawnOptions(helper);
    const remaining = deadline === undefined ? timeout : Math.min(timeout, deadline - performance.now());
    if (deadline !== undefined && remaining <= 0) {
      reject(new DOMException("Windows system directory query timed out", "TimeoutError"));
      return;
    }
    execFile(helper, ["--system-directory"], {
      ...options, timeout: Math.ceil(remaining), encoding: "buffer",
    }, (error, stdout, stderr) => {
      if (error && isWindowsPathKindHelperTimeout(error)) {
        reject(helperTimeout("The Windows system directory query", timeout));
        return;
      }
      if (error || stderr.length > 0) {
        reject(new Error(`Windows system directory query failed. ${REPAIR}`, { cause: error ?? undefined }));
        return;
      }
      try {
        resolve(parseWindowsSystemDirectory(stdout));
      } catch (cause) {
        reject(cause);
      }
    });
  });
  if (pinned()) return withWindowsPathKindHelper(launch, resourcePath);
  const helper = windowsPathKindHelperIn(resourcePath);
  try {
    await access(helper);
  } catch {
    throw missingWindowsPathKindHelper();
  }
  return launch(helper);
}

export function queryWindowsSystemDirectorySync(): string {
  if (process.platform !== "win32") throw new Error("Windows system directory query requires Windows");
  return withWindowsPathKindHelper(helper => {
    const options = windowsSystemDirectorySpawnOptions(helper);
    const result = spawnSync(helper, ["--system-directory"], options);
    if (isWindowsPathKindHelperTimeout(result.error)) throw helperTimeout("The Windows system directory query", options.timeout);
    if (result.error || result.status !== 0 || result.stderr.length > 0) {
      throw new Error(`Windows system directory query failed. ${REPAIR}`, { cause: result.error });
    }
    return parseWindowsSystemDirectory(result.stdout);
  });
}

export function windowsSystemDirectorySpawnOptions(helper: string) {
  return {
    cwd: dirname(helper), windowsHide: true, shell: false,
    // Explicit values block parent defaults injected during child creation. NODE_OPTIONS is left alone: the helper is native and Ave never runs under Node's --permission model.
    env: {
      HOMEDRIVE: "", HOMEPATH: "", LOGONSERVER: "", PATH: "", SYSTEMDRIVE: "", SYSTEMROOT: "",
      TEMP: "", USERDOMAIN: "", USERNAME: "", USERPROFILE: "", WINDIR: "", NODE_V8_COVERAGE: "",
    },
    timeout: TOOL_TIMEOUT_POLICY.projectGitQueryMs, maxBuffer: 128 * 1024,
  };
}

function parseWindowsSystemDirectory(stdout: Uint8Array): string {
  const directory = decodeWindowsNativeReply(stdout).replace(/\r?\n$/u, "");
  const root = win32.dirname(directory);
  if (directory.length > 32767 || !/^[a-z]:\\/iu.test(directory)
    || /[\u0000-\u001f\u007f<>"|?*]/u.test(directory) || directory.slice(2).includes(":")
    || win32.normalize(directory) !== directory || root === win32.parse(directory).root
    || root.length > 512) {
    throw new Error(`Windows system directory query returned an invalid path. ${REPAIR}`);
  }
  return directory;
}
