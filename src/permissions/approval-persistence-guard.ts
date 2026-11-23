import {
  isRemoteControllerBoundToSession,
  refreshRemoteControllerBoundToSession,
  type RemoteControllerAuthority,
} from "../shared/chat-origin.js";

/** Host-owned authority for a pending approval or its approved invocation. */
export interface ApprovalPersistenceGuard {
  refresh(): Promise<boolean>;
  isCurrent(): boolean;
}

export class ApprovalPersistenceError extends Error {
  constructor() {
    super("Approval authority is unavailable");
    this.name = "ApprovalPersistenceError";
  }
}

export function invocationApprovalPersistenceGuard(
  authority: RemoteControllerAuthority | undefined,
  sessionId: string | undefined,
  signal?: AbortSignal,
): ApprovalPersistenceGuard | undefined {
  if (!authority && !signal) return undefined;
  const isCurrent = () => signal?.aborted !== true && isRemoteControllerBoundToSession(authority, sessionId);
  return {
    isCurrent,
    refresh: async () => isCurrent() && (
      authority === undefined || await refreshRemoteControllerBoundToSession(authority, sessionId)
    ),
  };
}

export async function refreshApprovalPersistence(guard: ApprovalPersistenceGuard | undefined): Promise<void> {
  if (guard && (!await guard.refresh() || !guard.isCurrent())) throw new ApprovalPersistenceError();
}

export function assertApprovalPersistenceCurrent(guard: ApprovalPersistenceGuard | undefined): void {
  if (guard && !guard.isCurrent()) throw new ApprovalPersistenceError();
}
