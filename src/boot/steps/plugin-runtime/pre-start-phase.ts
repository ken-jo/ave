export type PluginRuntimeStartupState =
  | "accepting_pre_start_operations"
  | "starting"
  | "started";

/** Seal admission synchronously when start is called; failed startup stays sealed and shares its rejection. */
export class PluginRuntimePreStartPhase {
  private state: PluginRuntimeStartupState = "accepting_pre_start_operations";
  private tail: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;

  getState(): PluginRuntimeStartupState {
    return this.state;
  }

  admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "accepting_pre_start_operations") {
      return Promise.reject(
        new Error("plugin runtime no longer accepts pre-start operations"),
      );
    }

    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  start(startPlugins: () => Promise<void>): Promise<void> {
    if (this.startPromise) return this.startPromise;

    // Seal before awaiting so even an unawaited start call closes durable-operation admission.
    this.state = "starting";
    this.startPromise = (async () => {
      await this.tail;
      await startPlugins();
      this.state = "started";
    })();
    return this.startPromise;
  }
}
