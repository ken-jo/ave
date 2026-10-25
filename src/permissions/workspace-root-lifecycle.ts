// Keep the workspace-root lock, host-owned lifecycle holder and revocation predicate together so add/remove uses one coordinated sweep.
import type { PermissionDirectoryLifecycle } from "./permission-slash.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { projectRootEquals } from "../shared/project-identity.js";

let workspaceLifecycleTail: Promise<void> | null = null;

// Serialize the persisted root mutation and every live/persistent side effect for the workspace registry. Settings file locking alone is not enough: a slow detach could otherwise overtake a later re-add and leave the registry and the live tombstones in opposite states. This queue is intentionally global instead of keyed by an exact root. Parent removal and independently registered child addition overlap semantically even though their canonical strings differ; serializing all rare registry edits closes that snapshot race without affecting normal conversation/tool turns.
export async function withWorkspaceRootLifecycleLock<T>(
  _root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = workspaceLifecycleTail ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  workspaceLifecycleTail = tail;

  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (workspaceLifecycleTail === tail) workspaceLifecycleTail = null;
  }
}

// Resolve the single workspace lifecycle at approval time because IPC builds it after consumers. If unavailable, refuse durable grants; never fall back to settings-only persistence that skips revocation sweeps.
let workspaceRootLifecycle: PermissionDirectoryLifecycle | undefined;

// Publish the host-owned lifecycle. Called once, from the workspace IPC domain registrar. Passing `undefined` clears it (test teardown).
export function setWorkspaceRootLifecycle(
  lifecycle: PermissionDirectoryLifecycle | undefined,
): void {
  workspaceRootLifecycle = lifecycle;
}

// Resolve the lifecycle at use time. `undefined` means "not wired yet" and MUST be treated as fail-closed by the caller.
export function getWorkspaceRootLifecycle(): PermissionDirectoryLifecycle | undefined {
  return workspaceRootLifecycle;
}

function isPathAtOrBelow(root: string, candidate: string): boolean {
  try {
    const canonicalRoot = caseFoldForMatch(canonicalizePathForMatch(root));
    const canonicalCandidate = caseFoldForMatch(canonicalizePathForMatch(candidate));
    if (!canonicalRoot || !canonicalCandidate) return false;
    return canonicalCandidate === canonicalRoot
      || canonicalCandidate.startsWith(`${canonicalRoot}/`);
  } catch {
    return projectRootEquals(root, candidate);
  }
}

// Every scope owner revokes the removed root and descendants, except independently preserved descendant roots. Canonical/case-folded comparison must agree across owners; unrelated preserve roots cannot save removed scope.
export function createWorkspaceRootRevocationFilter(
  removedRoot: string,
  preserveRoots: readonly string[] = [],
): (directory: string) => boolean {
  const preserved = preserveRoots.filter(
    (preserveRoot) =>
      !projectRootEquals(removedRoot, preserveRoot)
      && isPathAtOrBelow(removedRoot, preserveRoot),
  );
  return (directory: string): boolean =>
    isPathAtOrBelow(removedRoot, directory)
    && !preserved.some((preserveRoot) => isPathAtOrBelow(preserveRoot, directory));
}
