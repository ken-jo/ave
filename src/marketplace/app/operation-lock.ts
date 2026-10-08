/**
 * The service's operation lock (design §18.6): operations share it; a policy
 * change takes it alone, so the swap of the policy into the gate, the
 * registry and the installers happens while no operation runs, and no
 * operation sees a mixed policy.
 *
 * Shared holders do not wait for one another. A waiting exclusive holder
 * stops new shared holders until it has run. Callers inside an operation must
 * not take the lock again (the service tracks that), or a waiting exclusive
 * holder and the outer operation would wait for each other.
 */
export class OperationLock {
  private readers = 0;
  private writer: Promise<void> | null = null;
  private drained: (() => void) | null = null;

  async shared<T>(fn: () => Promise<T>): Promise<T> {
    while (this.writer) await this.writer;
    this.readers += 1;
    try {
      return await fn();
    } finally {
      this.readers -= 1;
      if (this.readers === 0) this.drained?.();
    }
  }

  async exclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    while (this.writer) await this.writer;
    let release!: () => void;
    this.writer = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      while (this.readers > 0) {
        await new Promise<void>((resolve) => {
          this.drained = resolve;
        });
      }
      return await fn();
    } finally {
      this.drained = null;
      this.writer = null;
      release();
    }
  }
}
