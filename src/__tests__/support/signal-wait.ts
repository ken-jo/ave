/** The bound on a signal wait: under the 45 s test timeout, so a stuck wait fails naming what it waited for. */
export const SIGNAL_WAIT_MS = 30_000;

/** Ends a bounded wait early. Without a reason the bound passed; with one, the wait's owner ended it and the reason says how. */
export type Expire = (reason?: string) => void;
/** Arms a wait's limit and returns what clears it. */
export type Bound = (expire: Expire) => () => void;

/** Arms `expire` once the signal-wait bound passes. The timer never keeps the process alive by itself. Returns what clears it. */
export const boundWait: Bound = expire => {
  const timeout = setTimeout(() => expire(), SIGNAL_WAIT_MS);
  timeout.unref();
  return () => clearTimeout(timeout);
};

const ended = (what: string, reason?: string) => reason === undefined ? `timed out waiting for ${what}` : `${reason} while waiting for ${what}`;

/** Settles as `work` does; once the bound passes first (the signal-wait bound unless the caller passes its own), rejects naming `what`. */
export function within<T>(work: Promise<T>, what: string, bound: Bound = boundWait): Promise<T> {
  return new Promise((resolve, reject) => {
    const clear = bound(reason => reject(new Error(ended(what, reason))));
    work.then(value => { clear(); resolve(value); }, (error: unknown) => { clear(); reject(error); });
  });
}

/** Runs `assertion` now and again after each signal until it stops throwing. Runs never overlap; a signal during one queues one more.
 * `bound` arms the limit (the signal-wait bound unless the caller passes its own); when it expires the wait unsubscribes and rejects naming
 * `what`, how the wait ended, and the assertion's last failure (also its `cause`). */
export function untilAsserted(
  subscribe: (wake: () => void) => () => void,
  assertion: () => void | Promise<void>,
  what: string,
  bound: Bound = boundWait,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let running = false;
    let again = false;
    let done = false;
    /** Boxed, so an assertion that throws `undefined` still counts as a failure. */
    let last: { error: unknown } | undefined;
    function finish(): void {
      done = true;
      stop();
      clear();
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
          if (!done) {
            finish();
            resolve();
          }
        } catch (error) {
          last = { error };
        }
      } while (!done && again);
      running = false;
    }
    const stop = subscribe(() => { void check(); });
    // A caller's bound may expire while it is being armed.
    let clear: () => void = () => undefined;
    const clearBound = bound(reason => {
      if (done) return;
      finish();
      const failure = last === undefined ? "the assertion had not finished once"
        : `last failure: ${last.error instanceof Error ? last.error.message : String(last.error)}`;
      reject(new Error(`${ended(what, reason)}; ${failure}`, last === undefined ? undefined : { cause: last.error }));
    });
    clear = clearBound;
    if (done) clear();
    else void check();
  });
}
