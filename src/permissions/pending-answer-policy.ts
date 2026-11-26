// Whether a person's answer to an approval card still stands when the permission policy moved while the card was open.
//
// Every change refuses the answer, with one exception: steps that only added or dropped a memory-only allow rule of one conversation
// or one template run (a sibling stage's "Allow for this run", a run that ended). Such a step only moves a call between asked and
// allowed. The pending call is then judged again, and the answer stands unless that denies the call or asks for it under a forced
// card the person was not shown. One rule for every card a person answers, so parallel stages do not void each other's cards.
//
// A card that can lead to shell or terminal authority is opened as a `PendingAnswerCard`. Its answer is always judged against a fresh
// check bound at card open, and it stands only while that check asks the card's own question. The card's own rule save (a native
// same-card receipt) is honored only for such a card.
import { decidePermission } from "./decision-pipeline.js";
import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";
import type { ApprovalDecision, ApprovalGate } from "./approval-gate.js";

/** The policy a card was opened under. */
export interface AnswerEpochs { readonly epoch: string; readonly contextEpoch: string }

type EpochSource = Pick<PermissionManager, "getPolicyEpoch" | "getPolicyContextEpoch">;
type Rechecked = Pick<PermissionCheckResult, "decision" | "forceModal">;
type Questioned = Pick<PermissionCheckResult, "decision" | "forceModal" | "reasonCode" | "pipelineRequest">;

/** The question a card puts to the person. Card open, the answer check and the terminal write seal all use `permissionQuestionOf`. */
export interface PermissionQuestion {
  readonly floor?: string;
  readonly floorReason?: string;
  /** The reason of a forced ask with no floor (manual rerun, browser exfiltration). */
  readonly ask?: string;
  readonly shellAnalysisLimited: boolean;
  /** "This session" may answer the floor: sandbox-unavailable with no other floor behind it. */
  readonly sessionEligible: boolean;
  /** The floor the sandbox-unavailable floor stands in front of. */
  readonly competingFloor?: string;
}

export function permissionQuestionOf(result: Pick<PermissionCheckResult, "forceModal" | "reasonCode" | "pipelineRequest">): PermissionQuestion {
  const request = result.pipelineRequest;
  const floor = request?.floor;
  const competing = request?.competingFloor;
  return Object.freeze({
    ...(floor === undefined ? {} : { floor: floor.code, floorReason: floor.reason }),
    // Derived from the request, which a person's allow keeps; the result's own reason text is replaced by the approval.
    ...(floor === undefined && result.forceModal === true && request !== undefined ? { ask: `${result.reasonCode ?? ""}: ${decidePermission(request).reason}` } : {}),
    shellAnalysisLimited: request?.shellAnalysisLimited === true,
    sessionEligible: request?.floorSessionEligible === true,
    ...(competing === undefined ? {} : { competingFloor: `${competing.code}: ${competing.reason}` }),
  });
}

/** One line per question for the audit: what the card asked and what the call now asks. */
export function describePermissionQuestion(question: PermissionQuestion): string {
  return JSON.stringify([question.floor ?? null, question.floorReason ?? null, question.ask ?? null, question.shellAnalysisLimited,
    question.sessionEligible, question.competingFloor ?? null]);
}

export function samePermissionQuestion(a: PermissionQuestion, b: PermissionQuestion): boolean {
  return describePermissionQuestion(a) === describePermissionQuestion(b);
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

/** What a stale Allow leads to: a new card (`stale-reasked`) or a refusal of this call (`stale-refused`). */
export type StaleAnswerOutcome = "stale-reasked" | "stale-refused";

/** The owner's verdict on an answered card. `fresh` is the check it judged by; a caller acts on it, never on a check of its own.
 * A moved policy refuses an Allow before any check runs, and so does a check with no result. A Deny stays the person's
 * (`declined`) unless the policy now denies the call itself. */
export type PendingAnswerVerdict =
  | { readonly kind: "declined" | "policy-changed" }
  | { readonly kind: "stands" | "denied"; readonly fresh: PermissionCheckResult }
  | { readonly kind: "stale"; readonly fresh: PermissionCheckResult; readonly from: PermissionQuestion; readonly to: PermissionQuestion };

export interface PendingAnswerCard {
  readonly epochs: AnswerEpochs;
  readonly question: PermissionQuestion;
  readonly forced: boolean;
  /** Set by `personAnswerStands`. */
  readonly verdict?: PendingAnswerVerdict;
}

const cardChecks = new WeakMap<PendingAnswerCard, { readonly check: () => PermissionCheckResult; readonly onStale: StaleAnswerOutcome }>();

/** Open a card on `opened`, the decision it shows. `check` is the call's current permission check; the owner alone runs it. */
export function openPendingAnswerCard(manager: EpochSource, opened: Questioned, check: () => PermissionCheckResult, onStale: StaleAnswerOutcome): PendingAnswerCard {
  const card: PendingAnswerCard = { epochs: answerEpochsOf(manager), question: permissionQuestionOf(opened), forced: opened.forceModal === true };
  cardChecks.set(card, Object.freeze({ check, onStale }));
  return card;
}

/** The answer to a card. The gate is consulted for the card's own policy step and told of a stale Allow. */
export interface CardAnswer {
  readonly gate: Partial<Pick<ApprovalGate, "allowsPolicyTransition" | "recordStaleAnswer">>;
  readonly decision: ApprovalDecision;
}

function judgeCard(manager: EpochSource, card: PendingAnswerCard, answer: CardAnswer): PendingAnswerVerdict {
  const bound = cardChecks.get(card);
  if (!bound) throw new Error("Pending answer card was not opened by openPendingAnswerCard");
  const allows = answer.decision.choice.startsWith("allow");
  const current = manager.getPolicyEpoch();
  const opened = card.epochs;
  const policyStands = current === opened.epoch ||
    answer.gate.allowsPolicyTransition?.(answer.decision, opened.epoch, current) === true ||
    onlyMemoryRulesChangedSince(manager, opened);
  if (!policyStands) return { kind: allows ? "policy-changed" : "declined" };
  let fresh: PermissionCheckResult;
  try {
    fresh = bound.check();
  } catch {
    return { kind: allows ? "policy-changed" : "declined" };
  }
  if (fresh.decision === "deny") return { kind: "denied", fresh };
  if (!allows) return { kind: "declined" };
  const asked = permissionQuestionOf(fresh);
  // An allow, or an ordinary ask, asks no more than the card did. A forced ask stands only on the card's own forced question.
  if (fresh.decision === "ask" && fresh.forceModal === true && (!card.forced || !samePermissionQuestion(card.question, asked))) {
    return { kind: "stale", fresh, from: card.question, to: asked };
  }
  return { kind: "stands", fresh };
}

/** The whole rule. `recheck` judges the pending call by the policy as it is now; it runs only across memory-only rule steps.
 * With a `PendingAnswerCard`, the card's bound check judges the answer on every path and the verdict is left on the card. */
export function personAnswerStands(manager: EpochSource, card: PendingAnswerCard, answer: CardAnswer): boolean;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Rechecked): boolean;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Promise<Rechecked>): boolean | Promise<boolean>;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs | PendingAnswerCard, cardForcedOrAnswer: boolean | CardAnswer,
  recheck?: () => Rechecked | Promise<Rechecked>): boolean | Promise<boolean> {
  if ("question" in opened) {
    const answer = cardForcedOrAnswer as CardAnswer;
    const verdict = judgeCard(manager, opened, answer);
    (opened as { verdict?: PendingAnswerVerdict }).verdict = verdict;
    if (verdict.kind === "stale") {
      answer.gate.recordStaleAnswer?.(answer.decision, cardChecks.get(opened)?.onStale ?? "stale-refused", verdict.from, verdict.to);
    }
    return verdict.kind === "stands";
  }
  const cardForced = cardForcedOrAnswer as boolean;
  if (manager.getPolicyEpoch() === opened.epoch) return true;
  if (!onlyMemoryRulesChangedSince(manager, opened)) return false;
  if (!recheck) return false;
  const now = recheck();
  if (now instanceof Promise) {
    return now.then(result => onlyMemoryRulesChangedSince(manager, opened) && answerSurvivesRecheck(result, cardForced));
  }
  return answerSurvivesRecheck(now, cardForced);
}
