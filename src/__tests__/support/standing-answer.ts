import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import { openPendingAnswerCard, personAnswerStands, toolUseAction, type StandingAnswer } from "../../permissions/pending-answer-policy.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";

const unchangedPolicy = { getPolicyEpoch: () => "fixture", getPolicyContextEpoch: () => "fixture" };
let sequence = 0;

/** The owner's standing answer for `decision`, obtained as the pipeline obtains one: a card is opened for the action on `opened`
 * and the answer is judged against the same question. Undefined when the answer does not stand. */
export function judgedAnswer(action: string, decision: ApprovalDecision,
  opened: PermissionCheckResult = { decision: "ask", reason: "fixture" }): StandingAnswer | undefined {
  const card = openPendingAnswerCard(unchangedPolicy, opened, () => opened, "stale-refused", { gate: {}, requestId: decision.requestId, action });
  personAnswerStands(card, decision);
  return card.verdict?.kind === "stands" ? card.verdict.proof : undefined;
}

/** A person's standing Allow for `action`. */
export function standingAnswer(action: string, decision: ApprovalDecision = { requestId: `standing-answer-${++sequence}`, choice: "allow-once" },
  opened?: PermissionCheckResult): StandingAnswer {
  const answer = judgedAnswer(action, decision, opened);
  if (answer === undefined) throw new Error("Fixture answer did not stand");
  return answer;
}

/** A person's standing Allow for one tool call. */
export function toolUseAnswer(toolUseId: string, decision?: ApprovalDecision): StandingAnswer {
  return standingAnswer(toolUseAction(toolUseId), decision);
}
