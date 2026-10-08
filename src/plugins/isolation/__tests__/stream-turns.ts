/**
 * Waiting on in-memory pipes without waiting on a clock, shared by the suites
 * that drive the protocol over paired `PassThrough`s.
 */

/** Let the notification hops and queued replies on in-memory pipes drain. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Whether `promise` has settled, without waiting for it to. */
export function observe<T>(promise: Promise<T>): () => boolean {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}
