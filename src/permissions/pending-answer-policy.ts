// Whether a person's answer to an approval card still stands when the permission policy moved while the card was open.
//
// Every change refuses the answer, with one exception: steps that only added or dropped a memory-only allow rule of one conversation
// or one template run (a sibling stage's "Allow for this run", a run that ended). Such a step only moves a call between asked and
// allowed. The pending call is then judged again, and the answer stands unless that denies the call or asks for it under a forced
// card the person was not shown. One rule for every card a person answers, so parallel stages do not void each other's cards.
import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";

/** The policy a card was opened under. */
export interface AnswerEpochs { readonly epoch: string; readonly contextEpoch: string }

type EpochSource = Pick<PermissionManager, "getPolicyEpoch" | "getPolicyContextEpoch">;
type Rechecked = Pick<PermissionCheckResult, "decision" | "forceModal">;

export function answerEpochsOf(manager: EpochSource): AnswerEpochs {
  return { epoch: manager.getPolicyEpoch(), contextEpoch: manager.getPolicyContextEpoch() };
}

/** True when the policy moved since `opened` and every step was a memory-only allow rule's. */
export function onlyMemoryRulesChangedSince(manager: EpochSource, opened: AnswerEpochs): boolean {
  return manager.getPolicyEpoch() !== opened.epoch && manager.getPolicyContextEpoch() === opened.contextEpoch;
}

/** What the re-check of the pending call says of the answer. `cardForced`: the person answered a forced card. */
export function answerSurvivesRecheck(now: Rechecked, cardForced: boolean): boolean {
  return now.decision !== "deny" && !(now.decision === "ask" && now.forceModal === true && !cardForced);
}

/** The whole rule. `recheck` judges the pending call by the policy as it is now; it runs only across memory-only rule steps. */
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Rechecked): boolean {
  if (manager.getPolicyEpoch() === opened.epoch) return true;
  return onlyMemoryRulesChangedSince(manager, opened) && answerSurvivesRecheck(recheck(), cardForced);
}
