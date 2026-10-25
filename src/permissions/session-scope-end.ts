// A conversation's "This session" choices end with it (owner 2026-10-25, D1/D3): its session `Bash(<command>)` rules, its session exact approvals and its egress "This session" hosts. Quitting the app ends them too, since all three live only in memory.
import type { PermissionManager } from "./permission-manager.js";
import { dropSessionApprovals } from "./user-approval-store.js";
import { releaseEgressSession } from "./egress-runtime.js";

export function endSessionScopedPermissions(sessionId: string, permissionManager: PermissionManager | undefined): void {
  permissionManager?.endSession(sessionId);
  dropSessionApprovals(sessionId);
  releaseEgressSession(sessionId);
}
