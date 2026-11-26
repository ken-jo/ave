// Whether a person's answer to an approval card still stands when the permission policy moved while the card was open.
//
// Every change refuses the answer, with one exception: steps that only added or dropped a memory-only allow rule of one conversation
// or one template run (a sibling stage's "Allow for this run", a run that ended). Such a step only moves a call between asked and
// allowed. The pending call is then judged again, and the answer stands unless that denies the call or asks for it under a forced
// card the person was not shown. One rule for every card a person answers, so parallel stages do not void each other's cards.
//
// A card that can lead to shell or terminal authority is opened as a `PendingAnswerCard`. Its answer is always judged against a fresh
// check bound at card open, and it stands only while that check asks the card's own question. An allow the person asks such a card
// to remember is held by the gate until the answer stands and is written by `saveStandingAnswerRule`; a deny is saved when asked.
//
// A standing Allow is handed on as a `StandingAnswer`, which only `personAnswerStands` makes. Whatever acts on a person's answer (a
// folder grant, a shell permit, terminal typing, a remembered effect grant, a remembered allow) takes that object and spends it,
// once per kind of use.
// The kinds an action needs are named when its card is opened; the answer can be spent on no other kind.
import { decidePermission } from "./decision-pipeline.js";
import type { PermissionCheckResult, PermissionManager } from "./permission-manager.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequestInput } from "./approval-gate.js";

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
  /** Path details the card shows beside the reason. */
  readonly protectedEntry?: string;
  readonly secretPattern?: string;
}

export function permissionQuestionOf(result: Pick<PermissionCheckResult, "forceModal" | "reasonCode" | "pipelineRequest">): PermissionQuestion {
  const request = result.pipelineRequest;
  const floor = request?.floor;
  const competing = request?.competingFloor;
  const facts = request?.pathFacts;
  return Object.freeze({
    ...(floor === undefined ? {} : { floor: floor.code, floorReason: floor.reason }),
    // Derived from the request, which a person's allow keeps; the result's own reason text is replaced by the approval.
    ...(floor === undefined && result.forceModal === true && request !== undefined ? { ask: `${result.reasonCode ?? ""}: ${decidePermission(request).reason}` } : {}),
    shellAnalysisLimited: request?.shellAnalysisLimited === true,
    sessionEligible: request?.floorSessionEligible === true,
    ...(competing === undefined ? {} : { competingFloor: `${competing.code}: ${competing.reason}` }),
    ...(facts?.protectedEntry === undefined ? {} : { protectedEntry: facts.protectedEntry }),
    ...(facts?.secretPattern === undefined ? {} : { secretPattern: facts.secretPattern }),
  });
}

/** One line per question for the audit: what the card asked and what the call now asks. */
export function describePermissionQuestion(question: PermissionQuestion): string {
  return JSON.stringify([question.floor ?? null, question.floorReason ?? null, question.ask ?? null, question.shellAnalysisLimited,
    question.sessionEligible, question.competingFloor ?? null, question.protectedEntry ?? null, question.secretPattern ?? null]);
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

/** The one rule for a question against what the call asks now: an allow or an ordinary ask asks no more than the card did, and a
 * forced ask only when it is the card's own forced question. */
function asksNoMoreThan(question: PermissionQuestion, forced: boolean, now: Questioned): boolean {
  return !(now.decision === "ask" && now.forceModal === true && !(forced && samePermissionQuestion(question, permissionQuestionOf(now))));
}

/** A card not yet asked: `now` still asks, and asks no more than `pending`, the question about to be put. No answer is judged. */
export function pendingQuestionStillAsked(pending: Questioned, now: Questioned): boolean {
  return now.decision === "ask" && asksNoMoreThan(permissionQuestionOf(pending), pending.forceModal === true, now);
}

/** What a stale Allow leads to: a new card (`stale-reasked`) or a refusal of this call (`stale-refused`). */
export type StaleAnswerOutcome = "stale-reasked" | "stale-refused";

/** The owner's verdict on an answered card. `fresh` is the check it judged by; a caller acts on it, never on a check of its own.
 * A moved policy refuses an Allow before any check runs, and so does a check with no result, an answer to another card and a
 * second answer to this one. A Deny stays the person's (`declined`) unless the policy now denies the call itself. */
export type PendingAnswerVerdict =
  | { readonly kind: "declined" | "policy-changed" }
  | { readonly kind: "denied"; readonly fresh: PermissionCheckResult }
  | { readonly kind: "stands"; readonly fresh: PermissionCheckResult; readonly proof: StandingAnswer }
  | { readonly kind: "stale"; readonly fresh: PermissionCheckResult; readonly from: PermissionQuestion; readonly to: PermissionQuestion };

export interface PendingAnswerCard {
  readonly epochs: AnswerEpochs;
  readonly question: PermissionQuestion;
  readonly forced: boolean;
  /** Set by `personAnswerStands`. */
  readonly verdict?: PendingAnswerVerdict;
}

/** What a standing answer may be spent on. A card names the kinds its action needs at open; each is taken once per answer. */
export type StandingAnswerUse = "directory-grant" | "shell-permit" | "shell-policy" | "terminal-write" | "effect" | "rule-save";

/** What a standing answer is bound to: the card's request, the answer it got, the action it was asked for and the question it put. */
export interface StandingAnswerFacts {
  readonly requestId: string;
  readonly decision: ApprovalDecision;
  readonly action: string;
  readonly question: PermissionQuestion;
  readonly forced: boolean;
  readonly fresh: PermissionCheckResult;
}

const standingAnswers = new WeakMap<StandingAnswer, { readonly facts: StandingAnswerFacts; readonly uses: ReadonlySet<StandingAnswerUse>; readonly spent: Set<StandingAnswerUse> }>();
let issueStandingAnswer: (facts: StandingAnswerFacts, uses: ReadonlySet<StandingAnswerUse>) => StandingAnswer;

/** Proof that a person's Allow stood. Only this module makes one, and only its entry in the registry above makes one valid. */
class StandingAnswer {
  declare private readonly standing: true;
  private constructor() { Object.freeze(this); }
  static {
    issueStandingAnswer = (facts, uses) => {
      const proof = new StandingAnswer();
      standingAnswers.set(proof, { facts: Object.freeze(facts), uses, spent: new Set() });
      return proof;
    };
  }
}
export type { StandingAnswer };

/** The action a tool call's cards are asked for. */
export function toolUseAction(toolUseId: string): string {
  return `tool-use:${toolUseId}`;
}

/** The answer when it is a standing answer to `action`; nothing is spent. */
export function standingAnswerFor(answer: unknown, action: string): StandingAnswer | undefined {
  const proof = answer as StandingAnswer;
  return typeof answer === "object" && answer !== null && standingAnswers.get(proof)?.facts.action === action ? proof : undefined;
}

/** Spend the answer on one use for `action`. Undefined when it is no standing answer to that action, its card did not name that
 * use at open, or it was already spent on it. */
export function spendStandingAnswer(answer: StandingAnswer | undefined, use: StandingAnswerUse, action: string): StandingAnswerFacts | undefined {
  const proof = standingAnswerFor(answer, action);
  const entry = proof && standingAnswers.get(proof);
  if (!entry?.uses.has(use) || entry.spent.has(use)) return undefined;
  entry.spent.add(use);
  return entry.facts;
}

/** What a card is bound to at open: the gate that asks it, the request it is asked under, the action it is asked for and the
 * kinds of use that action needs. */
export interface PendingAnswerBinding {
  readonly gate: Partial<Pick<ApprovalGate, "allowsPolicyTransition" | "recordStaleAnswer" | "commitStagedAllowSaves">>;
  readonly requestId: string;
  readonly action: string;
  readonly uses: readonly StandingAnswerUse[];
  readonly epochs?: AnswerEpochs;
}

interface BoundCard extends Omit<PendingAnswerBinding, "uses"> {
  readonly uses: ReadonlySet<StandingAnswerUse>;
  readonly manager: EpochSource;
  readonly check: () => PermissionCheckResult;
  readonly onStale: StaleAnswerOutcome;
  judged: boolean;
}

const boundCards = new WeakMap<PendingAnswerCard, BoundCard>();
const boundRequests = new WeakMap<ApprovalRequestInput, BoundCard>();

/** Open a card on `opened`, the decision it shows. `check` is the call's current permission check; the owner alone runs it. */
export function openPendingAnswerCard(manager: EpochSource, opened: Questioned, check: () => PermissionCheckResult, onStale: StaleAnswerOutcome,
  binding: PendingAnswerBinding): PendingAnswerCard {
  const card: PendingAnswerCard = { epochs: binding.epochs ?? answerEpochsOf(manager), question: permissionQuestionOf(opened), forced: opened.forceModal === true };
  boundCards.set(card, { manager, check, onStale, gate: binding.gate, requestId: binding.requestId, action: binding.action,
    uses: new Set(binding.uses), judged: false });
  return card;
}

/** Bind the hold to the request actually passed to the gate. Opening an unasked card leaves no mark on its request ID. */
export function bindPendingAnswerRequest(request: ApprovalRequestInput, card: PendingAnswerCard | undefined): ApprovalRequestInput {
  if (card === undefined) return request;
  const bound = boundCards.get(card);
  if (bound === undefined || bound.requestId !== request.id) throw new Error("Approval request does not match its pending answer card");
  boundRequests.set(request, bound);
  return request;
}

export function pendingAnswerDefersAllowSaves(request: ApprovalRequestInput, gate: PendingAnswerBinding["gate"]): boolean {
  const bound = boundRequests.get(request);
  if (bound === undefined) return false;
  if (bound.gate !== gate || bound.requestId !== request.id) throw new Error("Approval request does not match its pending answer binding");
  return bound.uses.has("rule-save");
}

/** Write the allow the person asked a card to remember, once its answer stands. `saved`: the policy now holds it. `refusal`: the
 * write failed or the policy moved with it; the answer is void and the call is refused. */
export async function saveStandingAnswerRule(card: PendingAnswerCard, decision: ApprovalDecision): Promise<{ readonly saved: boolean; readonly refusal?: string }> {
  const bound = boundCards.get(card);
  const verdict = card.verdict;
  if (bound === undefined || verdict?.kind !== "stands") return { saved: false };
  const result = await bound.gate.commitStagedAllowSaves?.(decision, verdict.proof, bound.action) ?? { saved: false };
  if (result.refusal !== undefined) standingAnswers.delete(verdict.proof);
  return result;
}

function judgeCard(card: PendingAnswerCard, bound: BoundCard, decision: ApprovalDecision): PendingAnswerVerdict {
  const allows = decision.choice.startsWith("allow");
  const refused: PendingAnswerVerdict = { kind: allows ? "policy-changed" : "declined" };
  // One answer per card, and only the answer to this card's own request.
  if (bound.judged || decision.requestId !== bound.requestId) return refused;
  bound.judged = true;
  const { manager } = bound;
  const current = manager.getPolicyEpoch();
  const opened = card.epochs;
  const policyStands = current === opened.epoch ||
    bound.gate.allowsPolicyTransition?.(decision, opened.epoch, current) === true ||
    onlyMemoryRulesChangedSince(manager, opened);
  if (!policyStands) return refused;
  let fresh: PermissionCheckResult;
  try {
    fresh = bound.check();
  } catch {
    return refused;
  }
  if (fresh.decision === "deny") return { kind: "denied", fresh };
  if (!allows) return { kind: "declined" };
  if (!asksNoMoreThan(card.question, card.forced, fresh)) return { kind: "stale", fresh, from: card.question, to: permissionQuestionOf(fresh) };
  return { kind: "stands", fresh,
    proof: issueStandingAnswer({ requestId: bound.requestId, decision, action: bound.action, question: card.question, forced: card.forced, fresh }, bound.uses) };
}

/** The whole rule. With a `PendingAnswerCard`, the card's bound check judges the answer on every path, the verdict is left on the
 * card and a standing Allow carries the one `StandingAnswer`. The epoch form judges a card that leads to no shell, terminal, folder
 * or effect authority; `recheck` judges the pending call by the policy as it is now and runs only across memory-only rule steps. */
export function personAnswerStands(card: PendingAnswerCard, decision: ApprovalDecision): boolean;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Rechecked): boolean;
export function personAnswerStands(manager: EpochSource, opened: AnswerEpochs, cardForced: boolean, recheck: () => Promise<Rechecked>): boolean | Promise<boolean>;
export function personAnswerStands(cardOrManager: PendingAnswerCard | EpochSource, decisionOrOpened: ApprovalDecision | AnswerEpochs, cardForced?: boolean,
  recheck?: () => Rechecked | Promise<Rechecked>): boolean | Promise<boolean> {
  if ("question" in cardOrManager) {
    const bound = boundCards.get(cardOrManager);
    if (!bound) throw new Error("Pending answer card was not opened by openPendingAnswerCard");
    const decision = decisionOrOpened as ApprovalDecision;
    const verdict = judgeCard(cardOrManager, bound, decision);
    (cardOrManager as { verdict?: PendingAnswerVerdict }).verdict = verdict;
    if (verdict.kind === "stale") bound.gate.recordStaleAnswer?.(decision, bound.onStale, verdict.from, verdict.to);
    return verdict.kind === "stands";
  }
  const manager = cardOrManager;
  const opened = decisionOrOpened as AnswerEpochs;
  if (manager.getPolicyEpoch() === opened.epoch) return true;
  if (!onlyMemoryRulesChangedSince(manager, opened)) return false;
  if (!recheck) return false;
  const now = recheck();
  if (now instanceof Promise) {
    return now.then(result => onlyMemoryRulesChangedSince(manager, opened) && answerSurvivesRecheck(result, cardForced === true));
  }
  return answerSurvivesRecheck(now, cardForced === true);
}
