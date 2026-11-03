// A payload-free "this store changed" signal. Stores emit after a successful write; listeners re-read the store themselves.
export class ChangeSignal {
  private readonly listeners = new Set<() => void>();

  // The owning store reports listener failures through its own logger.
  constructor(private readonly onListenerError: (err: unknown) => void) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // A listener failure is reported and isolated; it never fails the write that already happened.
  emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        this.onListenerError(err);
      }
    }
  }
}
