/** Acquire the sibling cross-process lock and release in finally; recover stale holders with bounded retries. */
import lockfile from "proper-lockfile";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { errorMessage } from "../shared/error-message.js";

/** This queue orders only one module instance in one process; use withFileLock for cross-process writers. Return failures to their callers without poisoning later work. */
export async function withInProcessFileQueue<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  let queue = inProcessFileQueues.get(key);
  if (!queue) {
    queue = createSerialQueue();
    inProcessFileQueues.set(key, queue);
  }
  return queue(fn);
}

const inProcessFileQueues = new Map<string, SerialQueue>();

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

/** Touch the target only after acquiring the lock; a waiting Windows open can block the holder's replacement. */
export async function withFileLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const { stale = 10_000, retries = 5 } = opts;

  await mkdir(dirname(targetPath), { recursive: true });

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
