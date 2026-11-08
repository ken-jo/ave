// A conversation's "This session" choices end with it (owner 2026-10-25, five-choice cards): its session `Bash(<command>)` rules, its session exact approvals and its egress "This session" hosts. Quitting the app ends them too, since all three live only in memory.
// Session choices are independent. A root closes the tree; a child closes only its own choices.
import type { PermissionManager } from "./permission-manager.js";
import { approvalConversationRoot, dropSessionApprovals } from "./user-approval-store.js";
import { releaseEgressSessions } from "./egress-runtime.js";
import { releaseAgentTerminalObservationSessions } from "../tools/agent-terminal-observation.js";
import { endAgentBrowserObservationSessions } from "../tools/agent-browser-observation.js";
import { releaseConversationTerminals } from "../main/terminal/pty-manager.js";

export function endSessionScopedPermissions(sessionId: string, permissionManager: PermissionManager | undefined): void {
  const root = approvalConversationRoot(sessionId);
  releaseConversationTerminals((held) => held === sessionId
    || (root === sessionId && approvalConversationRoot(held) === root));
  endAgentBrowserObservationSessions((held) => held === sessionId
    || (root === sessionId && approvalConversationRoot(held) === root));
  permissionManager?.endSession(sessionId);
  dropSessionApprovals(sessionId);
  if (root !== sessionId) {
    releaseAgentTerminalObservationSessions((held) => held === sessionId);
    releaseEgressSessions((held) => held === sessionId);
    return;
  }
  releaseAgentTerminalObservationSessions((held) => held === root || approvalConversationRoot(held) === root);
  releaseEgressSessions((held) => held === root || approvalConversationRoot(held) === root);
}
