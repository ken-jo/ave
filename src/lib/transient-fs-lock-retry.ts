import { rename as fsRename } from "node:fs/promises";
import { sleep } from "../shared/abortable-deadline.js";

/** Share Windows lock codes and delay curves across sync and async ladders; separate budgets reflect caller blocking. */

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

/** Bound synchronous retries to one second: settings contention may outlast shorter waits, but the calling UI thread blocks. */
export const SYNC_UI_BLOCKING_ATTEMPTS = 7;
export const SYNC_UI_BLOCKING_BUDGET_MS = totalWaitFor(SYNC_UI_BLOCKING_ATTEMPTS);

/** Async retries can outlast slower scanners without blocking, but must remain bounded. */
export const BACKGROUND_ATTEMPTS = 10;
export const BACKGROUND_BUDGET_MS = totalWaitFor(BACKGROUND_ATTEMPTS);

/** File-only retries exclude directory errors and ENOENT so missing sources remain distinguishable from locks. */
export const RENAME_FILE_LOCK_CODES: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EBUSY",
]);

/** Directory swaps and removal also retry nonempty or existing targets. */
const DIRECTORY_OP_LOCK_CODES: ReadonlySet<string> = new Set([
  ...RENAME_FILE_LOCK_CODES,
  "ENOTEMPTY",
  "EEXIST",
]);

/** Retry directory renames only for Windows lock codes; propagate other errors and report each retry. */
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

const TRANSIENT_FS_LOCK_CODES = DIRECTORY_OP_LOCK_CODES;

export function isTransientFsLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && TRANSIENT_FS_LOCK_CODES.has(code);
}

/** Retry only transient Windows locks; propagate ENOENT and unrelated failures immediately. Tests may inject timing. */
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

/** Use the narrower file-lock set for bounded file retries; identical codes on other platforms are real failures. */
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

/** Replacement must replace target links rather than follow them. */
export function renameFile(from: string, to: string): Promise<void> {
  return retryOnFileLock(() => fsRename(from, to));
}
