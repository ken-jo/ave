// What a template run's engine tells the permission layer (permission tree: run-scoped grant, per-stage breaker). The run authority
// opens the scope as it links each stage session and closes it when the run ends; nothing else creates or revokes a run grant.
import type { PermissionManager } from "./permission-manager.js";
import { endRun, endRunSession, registerRunSession, type RunSessionMember } from "./run-grants.js";
import { dropRunApprovals } from "./user-approval-store.js";

export interface RunScopeHooks {
  /** Atomically links a stage session or its sub-agent. A refusal leaves membership and reviewer state unchanged. */
  sessionLinked(runKey: string, sessionId: string, member: Omit<RunSessionMember, "runKey">): void;
  sessionEnded(sessionId: string): void;
  runEnded(runKey: string): void;
}

export function createRunScopeHooks(permissionManager: PermissionManager): RunScopeHooks {
  const endSession = (sessionId: string) => {
    endRunSession(sessionId);
    permissionManager.endRunSessionReview(sessionId);
  };
  return {
    sessionLinked(runKey, sessionId, member) {
      // Each stage session starts its own reviewer count; a repeated link never reopens a paused one.
      if (!registerRunSession(runKey, sessionId, member)) return;
      try {
        permissionManager.beginRunSessionReview(sessionId);
      } catch (error) {
        endSession(sessionId);
        throw error;
      }
    },
    sessionEnded: endSession,
    runEnded(runKey) {
      // Membership goes first: from here no session reads or makes a grant of this run, whatever is still being dropped.
      endRun(runKey);
      dropRunApprovals(runKey);
      permissionManager.endRun(runKey);
    },
  };
}
