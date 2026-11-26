// What a template run's engine tells the permission layer (permission tree: run-scoped grant, per-stage breaker). The run authority
// opens the scope as it links each stage session and closes it when the run ends; nothing else creates or revokes a run grant.
import type { PermissionManager } from "./permission-manager.js";
import { endRun, endRunSession, registerRunSession } from "./run-grants.js";
import { dropRunApprovals } from "./user-approval-store.js";

interface RunScopeHooks {
  /** A stage child linked. `lane` is the run authority's verdict for the run: only an attended run takes "Allow for this run". Throws when the link is refused. */
  sessionLinked(runKey: string, sessionId: string, member: { stageId: string; stageName: string; lane: "attended" | "unattended" }): void;
  sessionEnded(sessionId: string): void;
  runEnded(runKey: string): void;
}

export function createRunScopeHooks(permissionManager: PermissionManager): RunScopeHooks {
  return {
    sessionLinked(runKey, sessionId, member) {
      // Each stage session starts its own reviewer count; a repeated link never reopens a paused one.
      if (registerRunSession(runKey, sessionId, member)) permissionManager.beginRunSessionReview(sessionId);
    },
    sessionEnded(sessionId) {
      endRunSession(sessionId);
      permissionManager.endRunSessionReview(sessionId);
    },
    runEnded(runKey) {
      // Membership goes first: from here no session reads or makes a grant of this run, whatever is still being dropped.
      endRun(runKey);
      dropRunApprovals(runKey);
      permissionManager.endRun(runKey);
    },
  };
}
