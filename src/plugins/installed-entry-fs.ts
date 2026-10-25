/** Windows handles without delete sharing or a directory used as cwd can prevent rename; surface the failure. */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { confinedProcessesMayBeRunning } from "../lib/confined-process-phase.js";
import { sameFileIdentity } from "../lib/file-identity.js";
import { retryOnTransientFsLock } from "../lib/transient-fs-lock-retry.js";

/** The +tombstones+ namespace cannot collide with plugin IDs; only entries inside it may be swept. */
export const TOMBSTONE_SUBDIR = "+tombstones+";

// Park unattributed state outside tombstones so no deferred delete or boot sweep can remove it.
// The + namespace cannot collide with plugin IDs.
export const PARKED_PLUGIN_STATE_SUBDIR = "+unattributed-plugin-state+";

const RECURSIVE_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

/** Remove tombstones only before confinement starts; live bind mounts can retain access after rename. */
export function deferTombstoneRemoval(
  tombstonePath: string,
  onError?: (tombstonePath: string, err: Error) => void,
): void {
  if (confinedProcessesMayBeRunning()) return;
  rm(tombstonePath, RECURSIVE_REMOVE_OPTIONS).catch((rmErr) => {
    onError?.(tombstonePath, rmErr as Error);
  });
}

// Rename into a collision-resistant tombstone; return null if already gone.
// Delete only before confinement starts, otherwise leave it for the next boot.
export async function tombstoneAndDeferredRemove(
  installedManifestDir: string,
  pluginsRoot: string,
  options: {
    now?: () => number;
    randomSuffix?: () => string;
    onDeferredRmError?: (tombstonePath: string, err: Error) => void;
    /** Stage only until metadata commits; schedule removal afterwards. */
    deferRemoval?: boolean;
  } = {},
): Promise<string | null> {
  const tombstone = await renameAsideUnder(
    installedManifestDir,
    pluginsRoot,
    TOMBSTONE_SUBDIR,
    options,
  );
  if (tombstone !== null && options.deferRemoval !== false) {
    deferTombstoneRemoval(tombstone, options.onDeferredRmError);
  }
  return tombstone;
}

/** Delete writable trees before confinement starts; afterwards tombstone them until boot to avoid racing live mounts. */
export async function removePluginTreeNowOrAtBoot(
  path: string,
  pluginsRoot: string,
  removeNow: (path: string) => Promise<void>,
): Promise<"removed" | "deferred" | "absent"> {
  if (!confinedProcessesMayBeRunning()) {
    await removeNow(path);
    return "removed";
  }
  const tombstone = await renameAsideUnder(path, pluginsRoot, TOMBSTONE_SUBDIR, {});
  return tombstone === null ? "absent" : "deferred";
}

/** Park without scheduling deletion; return its path or null if already gone. */
export async function parkUnattributedPluginState(
  dir: string,
  pluginsRoot: string,
  options: {
    now?: () => number;
    randomSuffix?: () => string;
  } = {},
): Promise<string | null> {
  return renameAsideUnder(dir, pluginsRoot, PARKED_PLUGIN_STATE_SUBDIR, options);
}

/** A collision-resistant namespace move treats ENOENT as already moved. */
async function renameAsideUnder(
  dir: string,
  pluginsRoot: string,
  subdir: string,
  options: { now?: () => number; randomSuffix?: () => string },
): Promise<string | null> {
  const now = options.now ?? Date.now;
  const randomSuffix =
    options.randomSuffix ?? (() => randomBytes(4).toString("hex"));

  const parent = join(pluginsRoot, subdir);
  // Propagate permission and disk errors; recursive mkdir is safe across concurrent removals.
  await mkdir(parent, { recursive: true });

  const basename = dir.split(/[\\/]/).pop() ?? "plugin";
  const moved = join(parent, `${basename}-${now()}-${randomSuffix()}`);
  try {
    await rename(dir, moved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return moved;
}

const execFileAsync = promisify(execFile);

/** If removal fails, restore owner access and clear macOS immutable flags without following links, then retry once. */
export async function removeOwnedPluginTree(path: string): Promise<void> {
  try {
    await retryOnTransientFsLock(() => rm(path, { recursive: true, force: true }));
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
  }
  await restoreOwnerAccess(path);
  if (process.platform === "darwin") {
    await execFileAsync("/usr/bin/chflags", ["-R", "-P", "nouchg", path]);
  }
  await retryOnTransientFsLock(() => rm(path, { recursive: true, force: true }));
}

// Open directories with O_NOFOLLOW, verify inode identity, and chmod through the descriptor.
// Path-based listing requires host-only staging or boot before confined children start.
export async function restoreOwnerAccess(path: string): Promise<void> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory()) return;
  const mode = Number((entry.mode & 0o7777n) | 0o700n);
  if (process.platform === "win32") {
    // Windows cannot open directory descriptors; mode changes only toggle read-only in a non-child-writable root.
    await chmod(path, mode);
  } else {
    const handle = await openDirectoryNoFollow(path).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
      await grantOwnerAccessNoFollow(path, mode);
      return openDirectoryNoFollow(path);
    });
    try {
      if (!sameFileIdentity(await handle.stat({ bigint: true }), entry)) {
        throw new Error(`plugin removal: ${path} changed while its access was being restored`);
      }
      try {
        await handle.chmod(mode);
      } catch (error) {
        if (process.platform !== "darwin" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        await execFileAsync("/usr/bin/chflags", ["-h", "nouchg", path]);
        await handle.chmod(mode);
      }
    } finally {
      await handle.close();
    }
  }
  for (const name of await readdir(path)) await restoreOwnerAccess(join(path, name));
}

function openDirectoryNoFollow(path: string): Promise<FileHandle> {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

/** Linux O_PATH is not exported by Node; 0o10000000 is shared by its supported Linux architectures. */
const LINUX_O_PATH = 0o10000000;

// Grant access without following links: macOS chmod -h, Linux O_PATH through /proc/self/fd.
// Clear macOS immutable flags before retrying access changes.
async function grantOwnerAccessNoFollow(path: string, mode: number): Promise<void> {
  if (process.platform === "darwin") {
    // Node lchmod opens for writing and fails on directories; use the no-follow syscall through chmod -h.
    const lchmod = () => execFileAsync("/bin/chmod", ["-h", mode.toString(8), path]);
    try {
      await lchmod();
    } catch {
      // Immutable failures appear on stderr; clear the flag and propagate any retry failure.
      await execFileAsync("/usr/bin/chflags", ["-h", "nouchg", path]);
      await lchmod();
    }
    return;
  }
  if (process.platform !== "linux") {
    throw new Error(`plugin removal: no way to restore access to ${path} without following a link on ${process.platform}`);
  }
  const handle = await open(path, LINUX_O_PATH | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    await chmod(`/proc/self/fd/${handle.fd}`, mode);
  } finally {
    await handle.close();
  }
}
