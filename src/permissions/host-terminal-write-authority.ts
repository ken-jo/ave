import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";
import { answerEpochsOf, permissionQuestionOf, personAnswerStands, samePermissionQuestion, spendStandingAnswer, type StandingAnswer } from "./pending-answer-policy.js";

export const HOST_TERMINAL_PERMISSION_CHANGED = "Host terminal permission changed before typing.";

export interface HostTerminalWriteAuthority {
  refusal(): string | undefined;
}

export function issueHostTerminalWriteAuthority(input: {
  manager: PermissionManager;
  /** The person's standing answer to `action`, spent here; without one the authority is the policy's. */
  answer: StandingAnswer | undefined;
  action: string;
  settled: PermissionCheckResult;
  reviewed: boolean;
  decidedBackend: string;
  check: () => PermissionCheckResult;
  backendIdentity: () => string | undefined;
}): HostTerminalWriteAuthority {
  const human = input.answer !== undefined;
  if (human && spendStandingAnswer(input.answer, "terminal-write", input.action) === undefined) throw new Error(HOST_TERMINAL_PERMISSION_CHANGED);
  const cardForced = human && input.settled.forceModal === true;
  const opened = answerEpochsOf(input.manager);
  const sealed = {
    backend: input.decidedBackend,
    question: permissionQuestionOf(input.settled),
    source: human ? "person" : input.reviewed ? "ask:user-owned-surface-review" : `allow:${input.settled.reasonCode}`,
  };
  const authority: HostTerminalWriteAuthority = {
    refusal() {
      const now = input.check();
      if (now.decision === "deny") return now.reason;
      const backend = input.backendIdentity();
      const source = human ? "person" : `${now.decision}:${now.reasonCode}`;
      if (backend !== sealed.backend || !samePermissionQuestion(permissionQuestionOf(now), sealed.question) || source !== sealed.source) {
        return HOST_TERMINAL_PERMISSION_CHANGED;
      }
      return personAnswerStands(input.manager, opened, cardForced, () => now)
        ? undefined : HOST_TERMINAL_PERMISSION_CHANGED;
    },
  };
  const refusal = authority.refusal();
  if (refusal !== undefined) throw new Error(refusal);
  return authority;
}
