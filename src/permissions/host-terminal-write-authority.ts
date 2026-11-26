import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";
import { answerEpochsOf, personAnswerStands } from "./pending-answer-policy.js";

export const HOST_TERMINAL_PERMISSION_CHANGED = "Host terminal permission changed before typing.";

export interface HostTerminalWriteAuthority {
  refusal(): string | undefined;
}

export function issueHostTerminalWriteAuthority(input: {
  manager: PermissionManager;
  human: boolean;
  cardForced: boolean;
  settled: PermissionCheckResult;
  reviewed: boolean;
  decidedBackend: string;
  check: () => PermissionCheckResult;
  backendIdentity: () => string | undefined;
}): HostTerminalWriteAuthority {
  const opened = answerEpochsOf(input.manager);
  const sealed = {
    backend: input.decidedBackend,
    forcedReason: input.settled.pipelineRequest?.floor?.code,
    source: input.human ? "person" : input.reviewed ? "ask:user-owned-surface-review" : `allow:${input.settled.reasonCode}`,
  };
  const authority: HostTerminalWriteAuthority = {
    refusal() {
      const now = input.check();
      if (now.decision === "deny") return now.reason;
      const backend = input.backendIdentity();
      const forcedReason = now.pipelineRequest?.floor?.code;
      const source = input.human ? "person" : `${now.decision}:${now.reasonCode}`;
      if (backend !== sealed.backend || forcedReason !== sealed.forcedReason || source !== sealed.source) {
        return HOST_TERMINAL_PERMISSION_CHANGED;
      }
      return personAnswerStands(input.manager, opened, input.cardForced, () => now)
        ? undefined : HOST_TERMINAL_PERMISSION_CHANGED;
    },
  };
  const refusal = authority.refusal();
  if (refusal !== undefined) throw new Error(refusal);
  return authority;
}
