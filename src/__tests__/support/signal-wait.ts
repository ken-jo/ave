/** The bound on a signal wait: under the 45 s test timeout, so a stuck wait fails naming what it waited for. */
export const SIGNAL_WAIT_MS = 30_000;

/** Arms `expire` once the signal-wait bound passes. The timer never keeps the process alive by itself. Returns what clears it. */
export function boundWait(expire: () => void): () => void {
  const timeout = setTimeout(expire, SIGNAL_WAIT_MS);
  timeout.unref();
  return () => clearTimeout(timeout);
}

/** Settles as `work` does; once the bound passes first, rejects naming `what`. */
export function within<T>(work: Promise<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const clear = boundWait(() => reject(new Error(`timed out waiting for ${what}`)));
    work.then(value => { clear(); resolve(value); }, (error: unknown) => { clear(); reject(error); });
  });
}

/** Runs `assertion` now and again after each signal until it stops throwing. Runs never overlap; a signal during one queues one more.
 * `bound` arms the limit (the signal-wait bound unless the caller passes its own); when it expires the wait unsubscribes and rejects with
 * the assertion's last failure. */
export function untilAsserted(
  subscribe: (wake: () => void) => () => void,
  assertion: () => void | Promise<void>,
  bound: (expire: () => void) => () => void = boundWait,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let running = false;
    let again = false;
    let done = false;
    let last: unknown = new Error("the assertion wait ended before its assertion ran");
    function finish(failure?: unknown): void {
      if (done) return;
      done = true;
      stop();
      clear();
      if (failure === undefined) resolve();
      else reject(failure);
    }
    async function check(): Promise<void> {
      if (done) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      do {
        again = false;
        try {
          await assertion();
          finish();
        } catch (error) {
          last = error;
        }
      } while (!done && again);
      running = false;
    }
    const stop = subscribe(() => { void check(); });
    const clear = bound(() => finish(last));
    void check();
  });
}
