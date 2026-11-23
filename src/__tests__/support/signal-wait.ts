/** Runs `assertion` now and again after each signal until it stops throwing. Runs never overlap; a signal during one queues one more. */
export function untilAsserted(subscribe: (wake: () => void) => () => void, assertion: () => void | Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let running = false;
    let again = false;
    let passed = false;
    async function check(): Promise<void> {
      if (passed) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      do {
        again = false;
        try {
          await assertion();
          passed = true;
        } catch {
          // Not yet: the next signal runs it again.
        }
      } while (!passed && again);
      running = false;
      if (passed) {
        stop();
        resolve();
      }
    }
    const stop = subscribe(() => { void check(); });
    void check();
  });
}
