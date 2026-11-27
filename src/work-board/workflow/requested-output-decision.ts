import { WORK_BOARD } from "../../shared/ipc-channels.js";
import { workBoardDecisionKey } from "../../shared/work-board-decision-intent.js";
import type { StageGateDecideInput } from "../../shared/work-board-types.js";

const receiptBrand: unique symbol = Symbol("requested-output-decision");
export interface RequestedOutputDecision { readonly [receiptBrand]: true }

const receipts = new WeakMap<RequestedOutputDecision, string>();

/** Issued by the board IPC after it spends a native keyboard receipt on this decision. */
export function mintRequestedOutputDecision(itemId: number, input: StageGateDecideInput): RequestedOutputDecision {
  const receipt = Object.freeze({ [receiptBrand]: true as const });
  receipts.set(receipt, workBoardDecisionKey(WORK_BOARD.decideStage, itemId, input));
  return receipt;
}

export function spendRequestedOutputDecision(receipt: RequestedOutputDecision | undefined, itemId: number, input: StageGateDecideInput): boolean {
  if (receipt === undefined) return false;
  const key = receipts.get(receipt);
  receipts.delete(receipt);
  return key === workBoardDecisionKey(WORK_BOARD.decideStage, itemId, input);
}
