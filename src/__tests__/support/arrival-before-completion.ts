/** Observe an operation immediately while waiting for an independently signaled intermediate event. */
export function arrivalBeforeCompletion<T>(arrival: Promise<T>, completion: Promise<unknown>): Promise<T> {
  const waiting = Promise.race([
    arrival,
    completion.then(() => { throw new Error("Operation completed before the expected arrival"); }),
  ]);
  // A test may drive a gate before awaiting this result. Keep failures observed until that await propagates them.
  void waiting.catch(() => undefined);
  return waiting;
}
