/** Private feature storage; Windows boundary creation belongs to boot. */
import { randomBytes } from "node:crypto";
import { chmodSync, constants, promises as fs, linkSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { platform } from "node:process";
import { aveHome, AVE_HOME_PROTECTED_DIRECTORIES } from "../../shared/ave-home.js";
import { admitWindowsReparse, pinWindowsPaths } from "../../shared/windows-path-facts.js";
import { createLogger } from "../../lib/logger.js";
import {
  RENAME_FILE_LOCK_CODES,
  BACKGROUND_ATTEMPTS,
  transientFsLockDelayMs,
} from "../../lib/transient-fs-lock-retry.js";
import { sleep } from "../../shared/abortable-deadline.js";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, replaceUtf8FileAtomicSyncIf } from "../../lib/atomic-file.js";

const log = createLogger("feature-namespace");

function assertProtectedBoundary(dir: string): string | undefined {
  if (platform !== "win32") return undefined;
  const home = aveHome();
  const segment = relative(home, resolve(dir)).split(sep)[0];
  const boundaryName = AVE_HOME_PROTECTED_DIRECTORIES.find((name) => name.toLowerCase() === segment.toLowerCase());
  if (!boundaryName) return undefined;
  const boundary = join(home, boundaryName);
  try {
    const entry = pinWindowsPaths([resolve(boundary)])[0]!;
    if (!entry.exists || !entry.directory || !admitWindowsReparse(entry, "evidence")) throw new Error("Invalid boundary");
  } catch {
    throw new Error(`Protected boundary directory "${boundary}" is missing or invalid; boot must create it`);
  }
  return boundary;
}

/** Never let recursive creation recreate a missing protected boundary. */
async function ensureDir(dir: string): Promise<void> {
  const boundary = assertProtectedBoundary(dir);
  if (boundary) {
    let current = boundary;
    const remainder = relative(boundary, resolve(dir));
    if (!remainder) return;
    for (const segment of remainder.split(sep)) {
      current = join(current, segment);
      try { await fs.mkdir(current, { mode: PRIVATE_DIR_MODE }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    return;
  }
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    await fs.chmod(dir, PRIVATE_DIR_MODE);
  } catch {
    /* best effort; pre-existing dir may already be 0o755 on some hosts */
  }
}

/** Exclusive slots never chmod a path that another process can replace. */
async function createExclusiveChild(parent: string, name: string): Promise<void> {
  await ensureDir(parent);
  const child = resolve(parent, name);
  const boundary = assertProtectedBoundary(child);
  if (boundary && child.toLowerCase() === boundary.toLowerCase()) {
    throw Object.assign(new Error(`Protected boundary directory "${boundary}" already exists`), { code: "EEXIST" });
  }
  if (platform === "win32") {
    await fs.mkdir(join(parent, name), { mode: PRIVATE_DIR_MODE });
    return;
  }
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const parentHandle = await fs.open(parent, flags);
  try {
    await parentHandle.chmod(PRIVATE_DIR_MODE);
    const child = platform === "linux" ? `/proc/self/fd/${parentHandle.fd}/${name}` : join(parent, name);
    await fs.mkdir(child, { mode: PRIVATE_DIR_MODE });
    // mkdir already grants at most 0700. Opening without following a link verifies the slot without a path-based chmod after its creation.
    const childHandle = await fs.open(child, flags);
    await childHandle.close();
  } finally {
    await parentHandle.close();
  }
}

/** Read + JSON-parse `filePath`. Any failure (missing file, permission denied, corrupt JSON) returns `fallback`; this mirrors the pre-existing
 * "read-never-throws" contract every namespace store relied on. Callers that need a security boundary must layer their own validation on top. */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Missing files return empty; damaged JSON is quarantined before returning empty, and a failed quarantine is logged.
 * Other read errors propagate; hydrate owns validation of unknown parsed data. */
export async function readJsonFileOrEmpty<T>(
  filePath: string,
  empty: () => T,
  hydrate: (parsed: unknown) => T,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return empty();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const backup = `${filePath}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
    try {
      await fs.rename(filePath, backup);
      log.warn(`corrupt JSON in ${filePath}; moved to ${backup}, starting empty`);
    } catch (err) {
      log.warn(`corrupt JSON in ${filePath}; could not move it to ${backup} (${(err as Error).message}), starting empty`);
    }
    return empty();
  }
  return hydrate(parsed);
}

/** fsync the directory that now holds the renamed entry. `rename` orders the replacement but does not make the new directory entry durable; without this the file survives a process crash and not a power cut, which is the half of the promise the docstring
 * below used to make and the code did not keep. Skipped entirely on Windows, where a directory cannot be opened for fsync at all; the same line {@link ../../lib/atomic-file} draws, rather than opening it and sorting the resulting errno into "expected" and "not". */
async function syncDirectoryEntry(dir: string): Promise<void> {
  if (platform === "win32") return;
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Retry only shared transient Windows lock codes under the background budget.
 * EEXIST must not trigger deletion or recovery; file replacement already overwrites regular-file targets. */
async function renameStagedFile(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable =
        platform === "win32" &&
        code !== undefined &&
        RENAME_FILE_LOCK_CODES.has(code) &&
        attempt < BACKGROUND_ATTEMPTS;
      if (!retryable) throw err;
      await sleep(transientFsLockDelayMs(attempt));
    }
  }
}

/** Random exclusive staging prevents planted symlinks and shared-writer splices; fsync bytes before rename and the parent afterward.
 * Clean up failures and retry transient Windows locks; Windows privacy comes from the owning directory's DACL. */
export async function writeFileAtomicAtPath(
  filePath: string,
  body: string | Uint8Array,
): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmp = `${filePath}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    const handle = await fs.open(
      tmp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameStagedFile(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await syncDirectoryEntry(dir);
}

/** Atomically write `value` (serialized as pretty JSON + trailing newline) to `<dir>/<name>`, under the contract {@link writeFileAtomicAtPath} states. */
export async function writeJsonAtomic<T>(dir: string, name: string, value: T): Promise<void> {
  await writeFileAtomicAtPath(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Finish asynchronous preparation before checking authority and committing without yielding. */
export async function writeFileAtomicAtPathIf(filePath: string, body: string, canCommit: () => boolean, prepareCommit?: () => Promise<void>): Promise<boolean> {
  await ensureDir(dirname(filePath));
  await prepareCommit?.();
  return replaceUtf8FileAtomicSyncIf(filePath, body, canCommit);
}

export interface FeatureNamespaceHandle {
  /** Absolute path to the feature's `~/.ave/<feature>/` directory. Resolved lazily on every access through {@link aveHome}, so the
   * `AVE_HOME` env override (set per-test by e2e fixtures) is always honoured even when the handle is created once at module load. */
  readonly dir: string;
  /** Read + parse `<dir>/<name>`; returns `fallback` on any failure. */
  readJson<T>(name: string, fallback: T): Promise<T>;
  /** Atomically write `<dir>/<name>` (0o700 dir, 0o600 file). */
  writeJson<T>(name: string, value: T): Promise<void>;
  /** Create a 0o700 subdirectory; exclusive creation rejects an existing entry. */
  childDir(name: string, options?: { exclusive?: boolean }): Promise<string>;
  /** Create an exclusive 0o600 file below existing non-linked namespace directories. The caller owns streaming, sync and close. */
  createFile(name: string): Promise<FileHandle>;
}

async function createNamespaceFile(root: string, name: string): Promise<FileHandle> {
  if (!name || isAbsolute(name) || name.includes("\\") || name.includes("\0") || name.includes(":")
    || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid namespace file name");
  }
  const path = resolve(root, name);
  if (relative(root, path).startsWith("..")) throw new Error("Namespace file is outside its root");
  const parent = dirname(path);
  const components = [root];
  for (const part of relative(root, parent).split(/[\\/]/).filter(Boolean)) components.push(join(components.at(-1)!, part));
  for (const component of components) {
    const info = await fs.lstat(component);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Namespace file parent is not a plain directory");
  }
  const flags = constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const directory = platform === "win32" ? undefined : await fs.open(parent, flags);
  try {
    const before = directory ? await directory.stat({ bigint: true }) : await fs.lstat(parent, { bigint: true });
    const target = platform === "linux" ? `/proc/self/fd/${directory!.fd}/${name.split("/").at(-1)!}` : path;
    const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (platform === "win32" ? 0 : constants.O_NOFOLLOW), PRIVATE_FILE_MODE);
    try {
      const current = await fs.lstat(parent, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) {
        throw new Error("Namespace file parent changed during creation");
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } finally { await directory?.close(); }
}

/** Open a handle to the `~/.ave/<featureId>/` namespace. Ordinary directories materialize on first write; Windows boundaries must already exist. `featureId` is a single path segment
 * (the domain name or plugin id). The directory path is resolved through {@link aveHome} on every operation (never cached) so a module-level handle still respects a later `AVE_HOME` override; matching the lazy-resolution contract documented on `aveHome`. */
export function openFeatureNamespace(featureId: string): FeatureNamespaceHandle {
  if (!featureId || featureId.includes("/") || featureId.includes("\\") || featureId.includes("..")) {
    throw new Error(`openFeatureNamespace: invalid featureId "${featureId}"`);
  }
  const resolveDir = (): string => join(aveHome(), featureId);
  return {
    get dir(): string {
      return resolveDir();
    },
    readJson: <T>(name: string, fallback: T) => readJsonFile(join(resolveDir(), name), fallback),
    writeJson: <T>(name: string, value: T) => writeJsonAtomic(resolveDir(), name, value),
    childDir: async (name: string, options) => {
      const child = join(resolveDir(), name);
      if (options?.exclusive) await createExclusiveChild(resolveDir(), name);
      else await ensureDir(child);
      return child;
    },
    createFile: (name) => createNamespaceFile(resolveDir(), name),
  };
}

/** Migrate by hard-linking then unlinking; existing destinations are the idempotency marker and must never be overwritten.
 * Failures are non-fatal; remove this migration when pre-move installations are unsupported, tracked for the release after 2026-11-01. */
export function adoptLegacyRootFileSync(
  featureId: string,
  destinationName: string,
  legacyRootFileName: string,
): void {
  if (!featureId || featureId.includes("/") || featureId.includes("\\") || featureId.includes("..")) {
    throw new Error(`adoptLegacyRootFileSync: invalid featureId "${featureId}"`);
  }
  const home = aveHome();
  const legacyPath = join(home, legacyRootFileName);
  const destinationPath = join(home, featureId, destinationName);
  const boundaryExists = assertProtectedBoundary(join(home, featureId));
  try {
    if (!boundaryExists) mkdirSync(join(home, featureId), { recursive: true, mode: PRIVATE_DIR_MODE });
    linkSync(legacyPath, destinationPath);
  } catch (err) {
    // ENOENT; no legacy file, which is the steady state from the second run onward. EEXIST; the destination already owns the name. Both
    // are the ordinary outcome, and neither needed a stat to discover: asking is what creates the window between the answer and the act.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return;
    log.warn(
      `storage migration: ${legacyRootFileName} -> ${featureId}/${destinationName} could not be linked: %s`,
      (err as Error).message,
    );
    return;
  }
  try {
    // The link published the legacy INODE under the new name, so it published the legacy mode
    // with it. Restore the namespace's own file mode while the two names still share the inode.
    chmodSync(destinationPath, PRIVATE_FILE_MODE);
    rmSync(legacyPath, { force: true });
    log.info(`storage migration: adopted ${legacyRootFileName} as ${featureId}/${destinationName}`);
  } catch (err) {
    // The data is already safe under the new name; only the tidying failed.
    log.warn(
      `storage migration: ${legacyRootFileName} -> ${featureId}/${destinationName} linked, but could not be tidied: %s`,
      (err as Error).message,
    );
  }
}
