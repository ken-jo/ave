import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";
import { answerEpochsOf, permissionQuestionOf, personAnswerStands, samePermissionQuestion } from "./pending-answer-policy.js";

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
    question: permissionQuestionOf(input.settled),
    source: input.human ? "person" : input.reviewed ? "ask:user-owned-surface-review" : `allow:${input.settled.reasonCode}`,
  };
  const authority: HostTerminalWriteAuthority = {
    refusal() {
      const now = input.check();
      if (now.decision === "deny") return now.reason;
      const backend = input.backendIdentity();
      const source = input.human ? "person" : `${now.decision}:${now.reasonCode}`;
      if (backend !== sealed.backend || !samePermissionQuestion(permissionQuestionOf(now), sealed.question) || source !== sealed.source) {
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
