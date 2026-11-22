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

  // A listener failure is reported and isolated; it never fails the write that already happened.
  emit(change: T): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }
}
