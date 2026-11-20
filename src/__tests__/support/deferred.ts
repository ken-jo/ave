/** Keep the promise helper free of main-process imports so renderer VMs do not inherit logger exit hooks. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolve once the callbacks already queued (promise jobs and I/O completions) have run, so a test can observe their effects. */
export function afterQueuedCallbacks(): Promise<void> {
  return new Promise((resolve) => { setImmediate(resolve); });
}
