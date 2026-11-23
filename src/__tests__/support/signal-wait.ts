/** Runs `assertion` now and again after each signal until it stops throwing. Runs never overlap; a signal during one queues one more.
 * `bound` arms the caller's limit; when it expires the wait rejects with the assertion's last failure. */
export function untilAsserted(
  subscribe: (wake: () => void) => () => void,
  assertion: () => void | Promise<void>,
  bound?: (expire: () => void) => () => void,
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
      clear?.();
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
    const clear = bound?.(() => finish(last));
    void check();
  });
}
