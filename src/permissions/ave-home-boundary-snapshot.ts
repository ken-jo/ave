import { AsyncLocalStorage } from "node:async_hooks";

// One composition's admitted boundary: the first projection inside it pins the profile-child homes, every later one reuses that
// result or its refusal. Each shell invocation or extension spawn takes a new one, so nothing is reused across commands or spawns.
export class AveHomeBoundarySnapshot {
  taken?: { readonly key: string; readonly children: ReadonlyMap<string, readonly string[]> } | { readonly key: string; readonly error: unknown };

  // Run a synchronous or asynchronous composition step against this snapshot.
  run<T>(fn: () => T): T {
    return inAveHomeBoundarySnapshot(this, fn);
  }
}

const boundarySnapshotScope = new AsyncLocalStorage<AveHomeBoundarySnapshot>();

export function createAveHomeBoundarySnapshot(): AveHomeBoundarySnapshot {
  return new AveHomeBoundarySnapshot();
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
