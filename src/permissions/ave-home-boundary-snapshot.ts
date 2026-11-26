import { AsyncLocalStorage } from "node:async_hooks";

// The session travels with the composition. Filesystem observations stay in the synchronous decision that made them.
export class AveHomeBoundarySnapshot {
  // The session this composition confines a process for. Beneath `worktrees` only that session's own stage workspace is re-opened; with
  // none, nothing is.
  constructor(readonly sessionId?: string) {}

  // Run a synchronous or asynchronous composition step against this snapshot.
  run<T>(fn: () => T): T {
    return inAveHomeBoundarySnapshot(this, fn);
  }
}

const boundarySnapshotScope = new AsyncLocalStorage<AveHomeBoundarySnapshot>();

export function createAveHomeBoundarySnapshot(sessionId?: string): AveHomeBoundarySnapshot {
  return new AveHomeBoundarySnapshot(sessionId);
}

export function currentAveHomeBoundarySnapshot(): AveHomeBoundarySnapshot | undefined {
  return boundarySnapshotScope.getStore();
}

// Run `fn` against `snapshot`, else the enclosing one, else a new one scoped to this call.
export function inAveHomeBoundarySnapshot<T>(snapshot: AveHomeBoundarySnapshot | undefined, fn: () => T): T {
  const current = boundarySnapshotScope.getStore();
  const chosen = snapshot ?? current ?? new AveHomeBoundarySnapshot();
  return chosen === current ? fn() : boundarySnapshotScope.run(chosen, fn);
}
