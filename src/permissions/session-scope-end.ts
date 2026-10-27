// A conversation's "This session" choices end with it (owner 2026-10-25, five-choice cards): its session `Bash(<command>)` rules, its session exact approvals and its egress "This session" hosts. Quitting the app ends them too, since all three live only in memory.
// Session rules and approvals are held under the root conversation and shared by its sub-agents; egress session hosts are held under the exact session that granted them. Deleting a root therefore ends all three for the whole tree, and deleting a sub-agent session ends only that session's own egress hosts, leaving its root's rules and approvals in place.
import type { PermissionManager } from "./permission-manager.js";
import { approvalConversationRoot, dropSessionApprovals } from "./user-approval-store.js";
import { releaseEgressSessions } from "./egress-runtime.js";
import { endAgentBrowserObservationSessions } from "../tools/agent-browser-observation.js";

export function endSessionScopedPermissions(sessionId: string, permissionManager: PermissionManager | undefined): void {
  const root = approvalConversationRoot(sessionId);
  endAgentBrowserObservationSessions((held) => held === sessionId
    || (root === sessionId && approvalConversationRoot(held) === root));
  if (root !== sessionId) {
    releaseEgressSessions((held) => held === sessionId);
    return;
  }
  permissionManager?.endSession(root);
  dropSessionApprovals(root);
  releaseEgressSessions((held) => held === root || approvalConversationRoot(held) === root);
}
