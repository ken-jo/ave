// A "this store changed" signal, carrying what changed when the store says (`T`). Stores emit after a successful write; listeners re-read
// the store themselves.
export class ChangeSignal<T = void> {
  private readonly listeners = new Set<(change: T) => void>();

  // The owning store reports listener failures through its own logger.
  constructor(private readonly onListenerError: (err: unknown) => void) {}

  subscribe(listener: (change: T) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Delivery is synchronous. Listener results are ignored except for reporting rejections.
  emit(change: T): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(change);
        if (result !== undefined) void Promise.resolve(result).catch(error => this.reportListenerError(error));
      } catch (err) {
        void this.reportListenerError(err);
      }
    }
  }

  private async reportListenerError(error: unknown): Promise<void> {
    try {
      await this.onListenerError(error);
    } catch {
      // Reporting must not interrupt delivery or fail a committed write.
    }
  }
}
