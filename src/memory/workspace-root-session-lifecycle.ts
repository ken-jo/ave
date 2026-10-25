export interface WorkspaceSessionMetadataStore {
  allowProjectRoot?: (root: string) => unknown;
  detachSessionsFromProject?: (root: string) => unknown;
}

function lifecycleError(code: string): Error & { code: string } {
  return Object.assign(new Error("workspace session metadata lifecycle failed"), { code });
}

// Detach every durable namespace before shrinking permissions; failed cleanup must retain all installed root guards.
export async function detachWorkspaceRootSessions(
  root: string,
  candidates: readonly WorkspaceSessionMetadataStore[],
): Promise<number> {
  const managers = [...new Set(candidates)];
  if (managers.length === 0) throw lifecycleError("MEMORY_MANAGER_UNAVAILABLE");

  // Start every namespace before awaiting results so one failure cannot prevent other tombstones from being installed.
  const settled = await Promise.allSettled(managers.map(async (manager) => {
    if (typeof manager.detachSessionsFromProject !== "function") {
      throw lifecycleError("MEMORY_DETACH_UNAVAILABLE");
    }
    const detached = await manager.detachSessionsFromProject(root);
    if (typeof detached !== "number" || !Number.isSafeInteger(detached) || detached < 0) {
      throw lifecycleError("MEMORY_DETACH_INVALID_RESULT");
    }
    return detached;
  }));
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw rejected.reason;

  let detachedTotal = 0;
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    detachedTotal += result.value;
    if (!Number.isSafeInteger(detachedTotal)) {
      throw lifecycleError("MEMORY_DETACH_INVALID_RESULT");
    }
  }
  return detachedTotal;
}
