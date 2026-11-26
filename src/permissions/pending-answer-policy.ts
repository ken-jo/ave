// Whether a person's answer to an approval card still stands when the permission policy moved while the card was open.
//
// Every change refuses the answer, with one exception: steps that only added or dropped a memory-only allow rule of one conversation
// or one template run (a sibling stage's "Allow for this run", a run that ended). Such a step only moves a call between asked and
// allowed. The pending call is then judged again, and the answer stands unless that denies the call or asks for it under a forced
// card the person was not shown. One rule for every card a person answers, so parallel stages do not void each other's cards.
import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";
import type { ApprovalDecision, ApprovalGate } from "./approval-gate.js";

/** The policy a card was opened under. */
export interface AnswerEpochs { readonly epoch: string; readonly contextEpoch: string }

type EpochSource = Pick<PermissionManager, "getPolicyEpoch" | "getPolicyContextEpoch">;
type Rechecked = Pick<PermissionCheckResult, "decision" | "forceModal">;
/** The forced question a card asked: its floor and reason, and whether "This session" could answer it (no competing floor). */
export interface ForcedQuestion { readonly floor?: string; readonly reason?: string; readonly sessionEligible: boolean; readonly competing?: string }
export interface SameCardPolicyTransition {
  readonly gate: Partial<Pick<ApprovalGate, "allowsPolicyTransition">>;
  readonly decision: ApprovalDecision;
  /** The card's forced question when it opened; a fresh forced ask that asks another question leaves the answer stale. */
  readonly question?: ForcedQuestion;
  /** The fresh check of the pending call after the card's own policy step. */
  onTransition?(): Pick<PermissionCheckResult, "decision" | "forceModal" | "pipelineRequest"> | undefined;
}

export function forcedQuestionOf(result: Pick<PermissionCheckResult, "forceModal" | "pipelineRequest">): ForcedQuestion | undefined {
  if (result.forceModal !== true) return undefined;
  const request = result.pipelineRequest;
  const competing = request?.competingFloor;
  return { floor: request?.floor?.code, reason: request?.floor?.reason, sessionEligible: request?.floorSessionEligible === true,
    ...(competing === undefined ? {} : { competing: `${competing.code}:${competing.reason}` }) };
}

function sameForcedQuestion(opened: ForcedQuestion, now: Pick<PermissionCheckResult, "decision" | "forceModal" | "pipelineRequest">): boolean {
  if (now.decision !== "ask") return true;
  const asked = forcedQuestionOf(now);
  return asked === undefined || asked.floor === opened.floor && asked.reason === opened.reason && asked.sessionEligible === opened.sessionEligible &&
    asked.competing === opened.competing;
}

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
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Rechecked,
  sameCard?: SameCardPolicyTransition): boolean;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Promise<Rechecked>,
  sameCard?: SameCardPolicyTransition): boolean | Promise<boolean>;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Rechecked | Promise<Rechecked>,
  sameCard?: SameCardPolicyTransition): boolean | Promise<boolean> {
  const current = manager.getPolicyEpoch();
  if (current === opened.epoch) return true;
  if (sameCard?.gate.allowsPolicyTransition?.(sameCard.decision, opened.epoch, current)) {
    const now = sameCard.onTransition?.();
    if (now === undefined) return true;
    // A denial is the caller's to report; a forced ask the card did not put stands only on the same forced question.
    if (now.decision === "ask" && now.forceModal === true && !cardForced) return false;
    return sameCard.question === undefined || sameForcedQuestion(sameCard.question, now);
  }
  if (!onlyMemoryRulesChangedSince(manager, opened)) return false;
  const now = recheck();
  if (now instanceof Promise) {
    return now.then(result => onlyMemoryRulesChangedSince(manager, opened) && answerSurvivesRecheck(result, cardForced));
  }
  return answerSurvivesRecheck(now, cardForced);
}
