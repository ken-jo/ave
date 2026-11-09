// A physical page has one observation lane, shared by independently created tool adapters.
const readTails = new WeakMap<object, Promise<void>>();

export async function runBrowserReadInLane<T>(guest: object, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const previous = readTails.get(guest) ?? Promise.resolve();
  let onAbort: (() => void) | undefined;
  const execution = previous.then(() => {
    signal?.throwIfAborted();
    // Once dispatched, the action owns cancellation and must finish its cleanup before returning.
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    return work();
  });
  // Observe failures while retaining the queue position of cancelled waiting reads.
  const settled = execution.then(() => {}, () => {});
  readTails.set(guest, settled);
  void settled.then(() => { if (readTails.get(guest) === settled) readTails.delete(guest); });
  if (!signal) return execution;
  try {
    return await Promise.race([
      execution,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
