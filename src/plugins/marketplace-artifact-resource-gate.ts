/** Serialize artifact materialization across plugin kinds to bound simultaneous compressed and decompressed allocations. */
import { createSerialQueue } from "../lib/with-file-lock.js";

const slot = createSerialQueue();

export async function withMarketplaceArtifactResourceSlot<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  const signal = options.signal;
  if (signal?.aborted) throw abortedWhileQueued();
  let started = false;
  const turn = slot(async () => {
    if (signal?.aborted) throw abortedWhileQueued();
    started = true;
    return operation();
  });
  if (!signal) return turn;
  // Only queue waiting is abortable; running operations own cancellation.
  let onAbort: (() => void) | undefined;
  const abortedWhileWaiting = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      if (!started) reject(abortedWhileQueued());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([turn, abortedWhileWaiting]);
  } catch (err) {
    if (!started) void turn.catch(() => undefined);
    throw err;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function abortedWhileQueued(): Error {
  const error = new Error("marketplace artifact operation aborted while waiting for the resource slot");
  error.name = "AbortError";
  return error;
}
