import { rename as fsRename } from "node:fs/promises";
import { sleep } from "../shared/abortable-deadline.js";

/**
 * Single authority for the Windows transient-file-lock retry policy.
 *
 * On Windows another process — a plugin webview/worker, an antivirus scanner,
 * the shell indexer — can hold a handle to a file we are trying to `rename()`
 * or `rm()`, and the call is rejected until the lock clears. That typically
 * happens within a few hundred milliseconds.
 *
 * Three ladders defend against this class and they CANNOT be merged into one:
 * `replaceStagedFile` (lib/atomic-file.ts) is synchronous and waits with
 * `Atomics.wait`; `retryOnTransientFsLock` and its one-file sibling
 * `retryOnFileLock` (below) are asynchronous and wait with `setTimeout`; `renameWithTransientRetry`
 * (tools/file-tools.ts) is asynchronous inside a tool turn. This module owns
 * what they can share — the delay curve, the attempt budgets, and the
 * retryable code sets — so they can never again disagree by accident. They
 * previously did: the sync side budgeted 60ms against a class documented to
 * clear in a few hundred milliseconds, i.e. it could not outlast the thing it
 * existed for; the tool side kept a private 10/25/50/100/200 curve.
 *
 * The budgets are DIFFERENT ON PURPOSE, and that is not the same failure as
 * the drift this module exists to prevent. Drift is two copies nobody
 * reconciled; this is one authority expressing justified budgets, each named
 * for the constraint that sets it (the tool-turn budget lives beside its
 * ladder, since only that caller has the constraint).
 */

/** Delay before retry `attempt` (1-based): 50/100/150/200 then held at 250. */
export function transientFsLockDelayMs(attempt: number): number {
  return Math.min(50 * attempt, 250);
}

function totalWaitFor(attempts: number): number {
  let total = 0;
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    total += transientFsLockDelayMs(attempt);
  }
  return total;
}

/**
 * Budget for a SYNCHRONOUS caller — 5 attempts, 500ms of total wait.
 *
 * Deliberately far smaller than the background budget because this blocks the
 * calling thread, and for `writeUtf8FileAtomicSync` that thread is the Electron
 * main thread: the whole UI including window chrome stops, and a block of
 * ~1s+ is what earns the Windows "not responding" ghost-window treatment. That
 * is a worse outcome than the failed write it would prevent, and a silent one —
 * the failure at least surfaces an error the user can act on.
 *
 * 1000ms, not the 500ms this shipped with. That number rested on "a lock still
 * held past a few hundred milliseconds is a process holding the handle
 * indefinitely, and no budget rescues that" — which the settings store then
 * falsified. `withFileLock` already serializes its writers, so back-to-back
 * locked writes are the normal case, and the OS handle from the previous write
 * outlives the lock release. Under load that lost the race at 500ms
 * deterministically, and the same write succeeds when the machine is quiet: the
 * contention clears, just later than the documented figure.
 *
 * A lost settings write silently discards a permission the user granted, which
 * is worse than the delay. 1000ms is still far short of the point where an
 * unresponsive-window prompt appears, so the reason the budget is small — this
 * blocks the caller, and for the settings/secret/session writers that caller is
 * the Electron main thread — is unchanged.
 */
export const SYNC_UI_BLOCKING_ATTEMPTS = 7;
export const SYNC_UI_BLOCKING_BUDGET_MS = totalWaitFor(SYNC_UI_BLOCKING_ATTEMPTS);

/**
 * Budget for an ASYNCHRONOUS caller — 10 attempts, ~1750ms of total wait.
 *
 * Nothing blocks while these sleeps run, so the install/rollback paths can
 * afford to outlast a slow scanner. Still bounded so an install can never hang
 * the user indefinitely.
 */
export const BACKGROUND_ATTEMPTS = 10;
export const BACKGROUND_BUDGET_MS = totalWaitFor(BACKGROUND_ATTEMPTS);

/**
 * Retryable codes when renaming ONE FILE onto another (`replaceStagedFile`).
 *
 * `ENOTEMPTY`/`EEXIST` are absent on purpose rather than by oversight: they are
 * directory-shaped and unreachable here, so listing them would advertise
 * coverage that does not exist. `ENOENT` is absent from both sets — an absent
 * source is a legitimate "first install" signal callers must be able to tell
 * apart from a locked one.
 */
export const RENAME_FILE_LOCK_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);

/**
 * Retryable codes for directory-level swaps and `rm()`
 * (`retryOnTransientFsLock`). Superset of {@link RENAME_FILE_LOCK_CODES}: a
 * non-empty or already-existing directory target is reachable on these paths.
 */
const DIRECTORY_OP_LOCK_CODES: ReadonlySet<string> = new Set([
  ...RENAME_FILE_LOCK_CODES,
  "ENOTEMPTY",
  "EEXIST",
]);

/**
 * Rename a directory into place, retrying transient Windows locks on the
 * background budget. On other platforms, and for any other code, the first
 * error propagates (an absent source stays distinguishable from a locked one).
 * `onRetry` hears each retried lock, so a caller can log the contention it
 * would otherwise never see.
 */
export async function renameDirectory(
  from: string,
  to: string,
  onRetry?: (attempt: number, code: string) => void,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fsRename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && code !== undefined && DIRECTORY_OP_LOCK_CODES.has(code) && attempt < BACKGROUND_ATTEMPTS;
      if (!retryable) throw error;
      onRetry?.(attempt, code);
      await new Promise((resolve) => setTimeout(resolve, transientFsLockDelayMs(attempt)));
    }
  }
}

/**
 * Windows transient-lock codes for the directory-swap / `rm()` paths: the
 * directory set above, beside the narrower set the file-rename ladder uses and
 * the shared delay curve, so the ladders cannot drift apart again. macOS/Linux
 * do not surface these for this path.
 */
const TRANSIENT_FS_LOCK_CODES = DIRECTORY_OP_LOCK_CODES;

export function isTransientFsLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && TRANSIENT_FS_LOCK_CODES.has(code);
}

/**
 * Run a filesystem op with bounded retry for transient Windows lock
 * contention. Only {@link TRANSIENT_FS_LOCK_CODES} are retried; `ENOENT` and
 * every other error propagate immediately so the caller can distinguish
 * "source absent" (first install) from "source locked" (worth retrying) from a
 * genuine failure. With the defaults the total wait is bounded to ~1.75s
 * (9 sleeps: 50+100+150+200 then 250×5) so an install can never hang the user.
 *
 * `sleep`/`delayMs` are injectable so tests exercise the retry ladder without
 * real timers.
 */
export async function retryOnTransientFsLock<T>(
  op: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, code: string | undefined) => void;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? BACKGROUND_ATTEMPTS;
  const delayMs = opts.delayMs ?? transientFsLockDelayMs;
  const wait = opts.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= attempts || !isTransientFsLockError(err)) throw err;
      opts.onRetry?.(attempt, (err as NodeJS.ErrnoException).code);
      await wait(delayMs(attempt));
    }
  }
}

/**
 * Bounded retry for ONE-FILE ops (a rename onto a file, an unlink, a read) on
 * the background budget. Only {@link RENAME_FILE_LOCK_CODES} retry, and only
 * on Windows: elsewhere those codes are real permission errors and fail at once.
 */
export async function retryOnFileLock<T>(op: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && code !== undefined && RENAME_FILE_LOCK_CODES.has(code) && attempt < BACKGROUND_ATTEMPTS;
      if (!retryable) throw error;
      await sleep(transientFsLockDelayMs(attempt));
    }
  }
}

/**
 * Rename one file onto another, retrying Windows file locks. Whatever sits at
 * `to`, a link included, is replaced and never followed.
 */
export function renameFile(from: string, to: string): Promise<void> {
  return retryOnFileLock(() => fsRename(from, to));
}
