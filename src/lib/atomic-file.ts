import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pid, platform } from "node:process";
import {
  RENAME_FILE_LOCK_CODES,
  SYNC_UI_BLOCKING_ATTEMPTS,
  retryOnTransientFsLock,
  transientFsLockDelayMs,
} from "./transient-fs-lock-retry.js";

/** The modes every user-data file and directory under `~/.ave/` is created with; the storage-namespace rule (dir 0o700, file 0o600). POSIX-only: Win32 maps `mode` onto the read-only attribute, and `ave-home.ts`
 * sets the DACL instead. Declared here because `lib/` is the lowest layer that writes files; the feature-namespace store, the log sink, the session search index and the secret document store all read them from here. */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;
const DIRECTORY_SYNC_ERROR_CODE = "ATOMIC_FILE_DIRECTORY_SYNC_FAILED";

interface ParentDirectorySyncRuntime {
  platform: NodeJS.Platform;
  open(parentDir: string): number;
  fsync(fd: number): void;
  close(fd: number): void;
  rename?(from: string, to: string): void;
  wait?(milliseconds: number): void;
}

const DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME: ParentDirectorySyncRuntime = {
  platform,
  open: (parentDir) => openSync(parentDir, "r"),
  fsync: fsyncSync,
  close: closeSync,
};

/** Rename a staged entry with the shared lock policy. Guard failures abort without retry. */
export function replaceStagedFile(
  from: string,
  to: string,
  runtime: ParentDirectorySyncRuntime = DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME,
  beforeRename?: () => void,
): void {
  const rename = runtime.rename ?? renameSync;
  const wait = runtime.wait ?? ((milliseconds: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  });
  // Policy (codes, curve, budget) comes from transient-fs-lock-retry.ts so this ladder and the async one in plugin-artifact-store.ts cannot drift apart again; they previously
  // disagreed 60ms vs 1750ms. The SYNC budget is the small one on purpose: this blocks the caller, and for the settings/secret/ session writers that caller is the Electron main thread.
  for (let attempt = 1; ; attempt += 1) {
    beforeRename?.();
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = runtime.platform === "win32"
        && code !== undefined
        && RENAME_FILE_LOCK_CODES.has(code)
        && attempt < SYNC_UI_BLOCKING_ATTEMPTS;
      if (!retryable) throw error;
      wait(transientFsLockDelayMs(attempt));
    }
  }
}

/** For file readers, ENOTDIR is absent just like ENOENT; directory-shape probes must retain their separate ENOENT check. */
export function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function syncParentDirectoryAfterRename(
  parentDir: string,
  runtime: ParentDirectorySyncRuntime,
): void {
  if (runtime.platform === "win32") return;

  let directoryFd: number | undefined;
  let syncError: unknown;
  try {
    directoryFd = runtime.open(parentDir);
    runtime.fsync(directoryFd);
  } catch (error) {
    syncError = error;
  } finally {
    if (directoryFd !== undefined) {
      try {
        runtime.close(directoryFd);
      } catch (error) {
        syncError = syncError === undefined
          ? error
          : new AggregateError(
              [syncError, error],
              "parent directory sync and close both failed",
            );
      }
    }
  }

  if (syncError !== undefined) {
    throw Object.assign(
      new Error("atomic file rename committed but parent directory sync failed"),
      {
        code: DIRECTORY_SYNC_ERROR_CODE,
        committed: true as const,
        cause: syncError,
      },
    );
  }
}

/** Whether `error` is the one thrown above: the rename landed, only the parent-directory sync did not. A caller that can verify the bytes on disk treats it as a commit; every other error is a failed write. Strict
 * `instanceof Error` because that is what this module throws; the two earlier per-store copies disagreed on whether a bare `{ committed: true }` object counted, and only one answer describes what is actually thrown. */
export function isCommittedAtomicWriteError(error: unknown): error is Error & { committed: true } {
  return error instanceof Error && (error as { committed?: unknown }).committed === true;
}

/** Stage exclusively beside the target, fsync before rename, and remove uncommitted staging on failure.
 * POSIX modes do not enforce Windows ACLs; owner-only access there depends on the private home directory's inherited DACL. */
export function writeUtf8FileAtomicSync(
  filePath: string,
  content: string,
  mode?: number,
): void;
export function writeUtf8FileAtomicSync(
  filePath: string,
  content: string,
  mode = PRIVATE_FILE_MODE,
  directorySyncRuntime: ParentDirectorySyncRuntime = DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME,
): void {
  writeUtf8FileAtomicSyncInternal(
    filePath,
    content,
    mode,
    directorySyncRuntime,
  );
}

/** Atomically replace a UTF-8 file only while a caller-owned precondition still holds. The candidate is fully written
 * and fsynced before the final check, so a false precondition or any staging failure leaves the destination intact. */
export function replaceUtf8FileAtomicSyncIf(
  filePath: string,
  content: string,
  precondition: () => boolean,
  mode = PRIVATE_FILE_MODE,
): boolean {
  return writeUtf8FileAtomicSyncInternal(
    filePath,
    content,
    mode,
    DEFAULT_PARENT_DIRECTORY_SYNC_RUNTIME,
    precondition,
  );
}

function writeUtf8FileAtomicSyncInternal(
  filePath: string,
  content: string,
  mode: number,
  directorySyncRuntime: ParentDirectorySyncRuntime,
  precondition?: () => boolean,
): boolean {
  const parentDir = dirname(filePath);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    parentDir,
    `.${basename(filePath)}.${pid}.${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  let committed = false;
  let operationError: unknown;

  try {
    fd = openSync(tempPath, "wx", mode);
    writeFileSync(fd, content, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // The adjacent precondition and rename are not compare-and-swap: another same-user writer may win the whole-file race.
    // Mismatches fail closed; staging still prevents partial files or outside-path writes.
    if (precondition && !precondition()) return false;
    replaceStagedFile(tempPath, filePath, directorySyncRuntime);
    committed = true;
    syncParentDirectoryAfterRename(parentDir, directorySyncRuntime);
    return true;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (!committed) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        if (!isMissingPathError(error)) cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      if (operationError !== undefined) {
        throw new AggregateError(
          [operationError, ...cleanupErrors],
          "atomic UTF-8 file write and cleanup both failed",
        );
      }
      throw cleanupErrors[0];
    }
  }
}

/** Async twin of {@link writeUtf8FileAtomicSync} for writers on a hot path of the main process (the turn journal's streaming snapshot): the same staging file, fsync, rename and
 * parent-directory sync, but every syscall runs on the libuv pool, so the event loop that is delivering stream frames never waits on the disk. Windows rename locks retry on the background budget. */
export async function writeUtf8FileAtomic(
  filePath: string,
  content: string,
  mode = PRIVATE_FILE_MODE,
): Promise<void> {
  const parentDir = dirname(filePath);
  await fsp.mkdir(parentDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const tempPath = join(parentDir, `.${basename(filePath)}.${pid}.${randomUUID()}.tmp`);
  let committed = false;
  try {
    const handle = await fsp.open(tempPath, "wx", mode);
    try {
      await handle.writeFile(content, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await retryOnTransientFsLock(() => fsp.rename(tempPath, filePath));
    committed = true;
    if (platform !== "win32") {
      const directory = await fsp.open(parentDir, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    if (!committed) {
      await fsp.unlink(tempPath).catch((error: unknown) => {
        if (!isMissingPathError(error)) throw error;
      });
    }
  }
}
