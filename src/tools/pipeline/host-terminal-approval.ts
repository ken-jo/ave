import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { HOST_TERMINAL_SANDBOX_CAPABILITY } from "../../permissions/sandbox-capability.js";
import type { ApprovalMemory } from "../../shared/permissions-events.js";
import type { Tool } from "../base.js";
import { currentHostTerminalTurn } from "../host-terminal-turn.js";
import { isCanonicalTerminalRunTool, terminalCommandScopeOf } from "../terminal-run.js";

/** Native card facts come from the finalized terminal target, never the displayed command's claims. */
export function hostTerminalApprovalFacts(
  tool: Tool,
  memory: ApprovalMemory | undefined,
  command: unknown,
): Pick<ApprovalRequestInput, "hostTerminal" | "durableApprovalRecordAllowed" | "sandboxCapability"> {
  if (!isCanonicalTerminalRunTool(tool)) return {};
  const scope = terminalCommandScopeOf(memory);
  if (scope.lane !== "manual") return {};
  if (typeof command !== "string") throw new Error("Host terminal approval is missing its command");
  return {
    durableApprovalRecordAllowed: false,
    sandboxCapability: HOST_TERMINAL_SANDBOX_CAPABILITY,
    hostTerminal: {
      tabId: scope.tabId,
      terminalSessionId: scope.terminalSessionId,
      sessionId: scope.sessionId,
      shell: scope.shell,
      physicalCwd: scope.physicalCwd,
      command,
      ...(currentHostTerminalTurn(scope.sessionId)?.externalContentSeen() === true
        ? { afterExternalContent: true as const } : {}),
    },
  };
}
