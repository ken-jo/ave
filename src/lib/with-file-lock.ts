/** Serialize local holders and acquire the sibling cross-process lock. */
import lockfile from "proper-lockfile";
import { realpath } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { errorMessage } from "../shared/error-message.js";

interface FileQueue {
  run: SerialQueue;
  pending: number;
}

const inProcessFileQueues = new Map<string, FileQueue>();
// Callers can already hold an in-process transaction queue for the same path.
const fileLockQueues = new Map<string, FileQueue>();

/**
 * This queue orders only one module instance in one process; use withFileLock for cross-process writers. Return failures to their callers without poisoning later work.
 * Not re-entrant: awaiting a same-key call from inside `fn` waits on itself forever. Same-key work started inside `fn` must not be awaited before `fn` returns.
 * Callers must use a single spelling per file: the key is the lexically resolved path only, so filesystem aliases of one file get separate queues.
 */
export async function withInProcessFileQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withQueuedFileWork(inProcessFileQueues, resolve(filePath), fn);
}

async function withQueuedFileWork<T>(
  queues: Map<string, FileQueue>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  let queue = queues.get(key);
  if (!queue) {
    queue = { run: createSerialQueue(), pending: 0 };
    queues.set(key, queue);
  }
  queue.pending++;
  try {
    return await queue.run(fn);
  } finally {
    queue.pending--;
    if (queue.pending === 0) queues.delete(key);
  }
}

export type SerialQueue = <T>(work: () => Promise<T>) => Promise<T>;

/** Keep FIFO order within one module instance; a rejected task must not wedge later tasks. */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(() => work());
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}


export interface FileLockOptions {
  stale?: number;
  retries?: number;
}

/** The callback completed but release is unconfirmed; durable writers may reconcile their exact output. */
export class FileLockReleaseError<T> extends Error {
  readonly callbackCompleted = true;

  constructor(
    readonly result: T,
    readonly releaseError: unknown,
  ) {
    super(`file lock callback completed but release failed: ${errorMessage(releaseError)}`);
    this.name = "FileLockReleaseError";
    this.cause = releaseError;
  }
}

/**
 * Queue through release so a stale-looking local holder cannot be replaced and release its successor.
 * Callers must use a single spelling per file. The queue converges lexical forms, parent symlinks, junctions and
 * 8.3 names (native parent realpath), and leaf case plus NFC on `darwin` and `win32`; distinct names can then share
 * a queue on case-sensitive or normalization-sensitive volumes. Other filesystem name aliases, such as full Unicode
 * case folding (ß/ẞ), are unsupported and may bypass same-process serialization.
 * Not re-entrant: awaiting a same-key withFileLock from inside `fn` waits on itself forever. Same-key work started inside `fn` must not be awaited before `fn` returns.
 */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const lockPath = resolve(targetPath);
  const parent = dirname(lockPath);
  await mkdir(parent, { recursive: true });
  const canonicalParent = await new Promise<string>((resolve, reject) => {
    realpath.native(parent, (error, canonicalPath) => {
      if (error) reject(error);
      else resolve(canonicalPath);
    });
  });
  const leaf = basename(lockPath);
  const platform = process.platform;
  const queueLeaf = platform === "darwin" || platform === "win32"
    ? leaf.normalize("NFC").toUpperCase().toLowerCase()
    : leaf;
  const queueParent = platform === "win32" ? canonicalParent.toLowerCase() : canonicalParent;
  const key = join(queueParent, queueLeaf);
  return withQueuedFileWork(fileLockQueues, key, () => withCrossProcessFileLock(lockPath, fn, opts));
}

async function withCrossProcessFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions,
): Promise<T> {
  const { stale = 10_000, retries = 5 } = opts;

  // Ignore compromise only after release starts; loss of exclusion during the callback must reject its caller, never crash from a filesystem callback.
  let releasing = false;
  let compromised: { readonly error: unknown } | undefined;
  const release = await lockfile.lock(targetPath, {
    stale,
    retries: {
      retries,
      minTimeout: 50,
      maxTimeout: 500,
      factor: 2,
    },
    realpath: false,
    onCompromised: (error) => {
      if (!releasing) compromised = { error };
    },
  });
  const releaseLock = async (): Promise<void> => {
    releasing = true;
    if (compromised !== undefined) throw compromised.error;
    await release();
  };

  let result: T;
  try {
    // Create the target without overwriting only after lock acquisition; an unlocked Windows open can block replacement.
    const handle = await open(targetPath, "a", 0o600);
    await handle.close();
    result = await fn();
  } catch (callbackError) {
    try {
      await releaseLock();
    } catch (releaseError) {
      throw new AggregateError(
        [callbackError, releaseError],
        "file lock callback and release both failed",
      );
    }
    throw callbackError;
  }

  try {
    await releaseLock();
  } catch (releaseError) {
    throw new FileLockReleaseError(result, releaseError);
  }
  return result;
}
