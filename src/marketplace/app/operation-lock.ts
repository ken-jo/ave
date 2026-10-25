/** Policy changes take exclusive access; operations share the lock.
 * Waiting writers block new readers, and nested operations must not reacquire it. */
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
