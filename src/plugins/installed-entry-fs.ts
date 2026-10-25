/**
 * Filesystem helpers for plugin install dir removal.
 *
 * Extracted from `marketplace.removeInstalledEntry` so the Windows-atomic
 * uninstall semantics (rename → defer rm) can be unit-tested without
 * standing up a full PluginMarketplaceService.
 *
 * ## Edge cases the rename can still fail (rare, host-side surfacing)
 *
 * - **Antivirus / endpoint protection, or an open Windows handle created
 *   without delete sharing**, holding the directory or a child file →
 *   `rename` throws EPERM/EACCES (errno -4048).
 * - **Process holds the install dir as cwd** → rename fails. Ave host code
 *   does not chdir into plugin dirs (verified — no `process.chdir()` calls
 *   reference plugin paths) so this is only possible if a plugin worker
 *   misuses cwd. Out of scope for this fix; user sees the throw.
 * - **macOS/Linux**: rename is always atomic; `rm` of files with open
 *   handles unlinks the directory entry while the inode persists until
 *   handles close. The whole tombstone-defer pattern is harmless here but
 *   gives uniform code across platforms.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { confinedProcessesMayBeRunning } from "../lib/confined-process-phase.js";
import { sameFileIdentity } from "../lib/file-identity.js";
import { retryOnTransientFsLock } from "../lib/transient-fs-lock-retry.js";

/**
 * Subdirectory under `pluginsRoot` where uninstall tombstones live.
 *
 * The `+` separator is intentional — plugin ids must satisfy
 * `^[a-zA-Z0-9._-]+$` (see marketplace.ts:1184), so `+tombstones+` cannot
 * collide with any installed plugin's directory name. This is a structural
 * defense against the "malicious plugin slug ending in `.uninstalling-1`
 * gets swept on boot" attack: tombstones live under their own namespace,
 * never as siblings of plugin dirs, so the sweeper's name match cannot
 * mistake a real plugin for a tombstone.
 */
export const TOMBSTONE_SUBDIR = "+tombstones+";

/**
 * Subdirectory under `pluginsRoot` where state nobody can attribute is PARKED.
 *
 * Deliberately NOT {@link TOMBSTONE_SUBDIR}. That namespace is a REMOVAL
 * lifecycle: `tombstoneAndDeferredRemove` schedules an `rm` of what it renames,
 * and anything that survives that `rm` is finished off by
 * `sweepOrphanUninstallDirs` on the next boot. A caller that wants to KEEP
 * bytes cannot express that by renaming them there — it only chooses whether
 * they are deleted now or at the next boot.
 *
 * Recovery needs to keep them. When two non-empty plugin data directories
 * arrive at one carry, one of them is state no transaction accounts for, and
 * recovery cannot tell which side a human would want. Deleting the loser makes
 * the carry's "never deletes state" rule untrue; leaving it in place wedges the
 * recovery. So it moves here and STAYS here: nothing sweeps this directory, and
 * it exists precisely so an operator can look at what could not be attributed.
 * The `+` separator is the same structural defence tombstones use — plugin ids
 * match `^[a-zA-Z0-9._-]+$`, so this can never collide with a plugin directory
 * or be mistaken for one.
 */
export const PARKED_PLUGIN_STATE_SUBDIR = "+unattributed-plugin-state+";

const RECURSIVE_REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50,
} as const;

/**
 * Remove a tombstone now when no confined process can be running yet;
 * otherwise leave it for the next boot's sweep. A tombstone can hold a
 * directory a still-running child is bound to (Linux `--bind` follows the
 * directory through the rename), and a recursive delete would race that child
 * (see lib/confined-process-phase.ts).
 */
export function deferTombstoneRemoval(
  tombstonePath: string,
  onError?: (tombstonePath: string, err: Error) => void,
): void {
  if (confinedProcessesMayBeRunning()) return;
  rm(tombstonePath, RECURSIVE_REMOVE_OPTIONS).catch((rmErr) => {
    onError?.(tombstonePath, rmErr as Error);
  });
}

/**
 * Atomic Windows-safe directory removal.
 *
 * 1. Rename `installedManifestDir` → `<pluginsRoot>/+tombstones+/<id>-<ts>-<rand>`.
 *    On POSIX this succeeds even when a plugin worker still holds files
 *    inside. On Windows it succeeds only when those handles allow delete
 *    sharing; otherwise the rename throws and the caller surfaces the
 *    uninstall failure. The `<rand>` suffix prevents collisions when
 *    multiple uninstalls fire within the same millisecond.
 * 2. Fire-and-forget rm of the tombstone, only while no confined process can
 *    be running ({@link deferTombstoneRemoval}); otherwise, and on a Windows
 *    EBUSY from handles still open, the orphan sweeper at next boot removes
 *    it.
 *
 * `pluginsRoot` is required so the tombstone subdirectory ends up in the
 * canonical namespace (resolved via `aveHome()` upstream — never hardcoded).
 *
 * Returns the tombstone path (for callers that want to log it), or null if
 * the install dir was already gone (concurrent uninstall race).
 */
export async function tombstoneAndDeferredRemove(
  installedManifestDir: string,
  pluginsRoot: string,
  options: {
    /** Override clock — tests pass a fixed value for deterministic naming. */
    now?: () => number;
    /** Override random suffix — tests pass a fixed value for assertions. */
    randomSuffix?: () => string;
    /** Hook for the deferred rm's failure path (default: silent). */
    onDeferredRmError?: (tombstonePath: string, err: Error) => void;
    /** Stage only; the caller commits metadata before scheduling removal. */
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

/**
 * Delete a plugin tree a confined process may write — a root holding the
 * plugin's `data/`, `sockets/` or a worker's `run/` leaf — without racing it.
 *
 * Before any confined process has started (boot recovery and reconcile), the
 * tree is removed now with `removeNow`. After that, a child of the plugin may
 * still be bound to a directory inside it: on Linux bubblewrap's `--bind`
 * keeps a renamed directory writable to that child, so a recursive delete
 * would race it (see lib/confined-process-phase.ts). The tree is then renamed
 * into the host-only tombstone namespace instead, and the next boot's sweep
 * deletes it before plugins start.
 *
 * Returns what happened: removed now, deferred to the next boot, or the tree
 * was already gone.
 */
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

/**
 * Move a directory into {@link PARKED_PLUGIN_STATE_SUBDIR} and LEAVE IT THERE.
 *
 * The rename mechanics are the ones {@link tombstoneAndDeferredRemove} uses —
 * one atomic move into a namespace no plugin id can reach, with a timestamp and
 * a random suffix so concurrent parks cannot collide. What differs is the whole
 * point of the call: nothing is scheduled to delete this, and no sweeper looks
 * here. See {@link PARKED_PLUGIN_STATE_SUBDIR} for why that namespace is not
 * the tombstone one.
 *
 * Returns the parked path, or null if the directory was already gone.
 */
export async function parkUnattributedPluginState(
  dir: string,
  pluginsRoot: string,
  options: {
    /** Override clock — tests pass a fixed value for deterministic naming. */
    now?: () => number;
    /** Override random suffix — tests pass a fixed value for assertions. */
    randomSuffix?: () => string;
  } = {},
): Promise<string | null> {
  return renameAsideUnder(dir, pluginsRoot, PARKED_PLUGIN_STATE_SUBDIR, options);
}

/**
 * The move both namespaces share: one rename into `<pluginsRoot>/<subdir>/`
 * under a name that cannot collide. ENOENT means someone else already moved it,
 * which is an outcome rather than a failure for both callers.
 */
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
  // mkdir recursive is idempotent — safe across concurrent uninstalls. Fails
  // only on permission/disk-full errors, which would also fail the rename
  // below; let those surface.
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

/**
 * Remove a staged plugin tree, a boot sweep's tombstone or socket discard
 * directory, or a principal's sandbox temp directory at boot
 * (`sweepSandboxTempRoot`), first taking back what confined code may have
 * taken from its owner.
 *
 * A confined plugin writes inside its data root, so it can `chmod 000` a
 * directory there or, on macOS, set the user-immutable flag (`chflags uchg`)
 * on one. Both stop a recursive `rm`, and the uninstall then leaves the tree
 * behind. The fast path is the plain removal; only when it fails is the tree
 * walked to restore the owner's `rwx` on every directory and, on darwin, to
 * clear `uchg`, before one more removal. No link is followed: the walk uses
 * `lstat` and `chflags -P`. If that removal fails too, its error propagates.
 */
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

/**
 * Give the owner `rwx` on every directory under `path`, depth first from the
 * top so each one can be listed. A directory whose mode cannot be changed is,
 * on darwin, user-immutable: its flag is cleared and the mode set again.
 *
 * NO LINK IS FOLLOWED, even one swapped in after the `lstat`. Each directory
 * is opened `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, which refuses a link with
 * ELOOP or ENOTDIR, its inode is checked against the `lstat`, and the mode is
 * set through that descriptor. A directory the owner cannot read cannot be
 * opened that way, so it first gets owner `rwx` through a call that cannot
 * follow a link either (`grantOwnerAccessNoFollow`). What remains is the
 * listing, which goes by path after the inode check; the tree is staged under
 * the transaction directory or a tombstone, outside every write root a confined
 * child had, or swept at boot before any confined child runs.
 */
export async function restoreOwnerAccess(path: string): Promise<void> {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory()) return;
  const mode = Number((entry.mode & 0o7777n) | 0o700n);
  if (process.platform === "win32") {
    // No descriptor can be opened on a Windows directory, and no confined
    // child there writes inside a pinned root; the mode only toggles read-only.
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

/**
 * Linux's `O_PATH`, which Node does not export. 0o10000000 is the generic
 * value every architecture Node supports on Linux uses (x64, arm, arm64,
 * ppc64, s390x, riscv64, loong64).
 */
const LINUX_O_PATH = 0o10000000;

/**
 * Owner `rwx` on a directory the owner cannot read, without following a link
 * that may have replaced it. On darwin that is `chmod -h`, the `lchmod`
 * syscall, which changes a link itself and never its target. On Linux it is a
 * `chmod` of the `O_PATH | O_NOFOLLOW | O_DIRECTORY` descriptor's
 * `/proc/self/fd` entry, which names the opened inode and refuses a link. On
 * darwin a user-immutable directory refuses the change until its flag is
 * cleared, as in {@link restoreOwnerAccess}.
 */
async function grantOwnerAccessNoFollow(path: string, mode: number): Promise<void> {
  if (process.platform === "darwin") {
    // BSD `chmod -h` is the `lchmod` syscall. Node's own `lchmod` cannot stand
    // in: it opens the path for writing, which a directory refuses (EISDIR).
    const lchmod = () => execFileAsync("/bin/chmod", ["-h", mode.toString(8), path]);
    try {
      await lchmod();
    } catch {
      // A user-immutable directory refuses the change; `chmod` reports that
      // only on stderr, so the flag is cleared and the change tried once more,
      // whose failure propagates.
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
