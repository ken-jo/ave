// The single owner of one contained-shell invocation's resources. Each resource registers as it is allocated;
// ending the invocation revokes its authority synchronously; disposal waits for the native job to exit, so its
// ports are never handed back while anything the job started can still reach them.

export interface ContainedShellLifecycle {
  /** Aborted at revocation: listeners holding it stop forwarding at once. */
  readonly signal: AbortSignal;
  /** Run once, synchronously, when the invocation ends; runs at once if it already has. */
  onRevoke(revoker: () => void): void;
  /** Release a resource at disposal (last registered, first invoked); runs at once if disposal has begun. */
  defer(disposer: () => void | Promise<void>): void;
  /** End the invocation's authority now. Idempotent and synchronous. With no job started, disposal begins too. */
  revoke(): void;
  /** The native job has started; disposal waits until `exited` settles. */
  jobStarted(exited: Promise<unknown>): void;
  /** Revoke, wait for the job, run every disposer and resolve to every raw failure. Idempotent; never rejects. */
  dispose(): Promise<readonly unknown[]>;
}

export function createContainedShellLifecycle(): ContainedShellLifecycle {
  const controller = new AbortController();
  const revokers: Array<() => void> = [];
  const disposers: Array<() => void | Promise<void>> = [];
  const failures: unknown[] = [];
  const pending: Array<Promise<void>> = [];
  let job: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  let draining = false;
  let disposed: Promise<readonly unknown[]> | undefined;

  const run = (step: () => void | Promise<void>): void => {
    try {
      const result: unknown = step();
      if (result instanceof Promise) pending.push(result.then(() => {}, (error: unknown) => { failures.push(error); }));
    } catch (error) {
      failures.push(error);
    }
  };
  const beginDisposal = (): Promise<void> => disposing ??= (async () => {
    if (job !== undefined) await job;
    draining = true;
    for (const disposer of disposers.splice(0).reverse()) run(disposer);
  })();
  const revoke = (): void => {
    if (controller.signal.aborted) return;
    controller.abort();
    for (const revoker of revokers.splice(0)) run(revoker);
    if (job === undefined) void beginDisposal();
  };
  return {
    signal: controller.signal,
    onRevoke(revoker) {
      if (controller.signal.aborted) run(revoker);
      else revokers.push(revoker);
    },
    defer(disposer) {
      if (draining) run(disposer);
      else disposers.push(disposer);
    },
    revoke,
    jobStarted(exited) {
      if (job !== undefined || disposing !== undefined) throw new Error("Contained shell job started after its invocation ended");
      job = exited.then(() => {}, () => {});
    },
    dispose() {
      revoke();
      disposed ??= (async () => {
        await beginDisposal();
        while (pending.length > 0) await Promise.all(pending.splice(0));
        return [...failures];
      })();
      return disposed;
    },
  };
}
