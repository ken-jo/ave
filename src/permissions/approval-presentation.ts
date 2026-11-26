import type { AskUserQuestionRequest } from "../main/ask-user-question-gate.js";
import type { TelegramBotApiClient } from "../main/telegram-bot-api-client.js";
import { unattendedApprovalDenial } from "../shared/turn-extension-policy.js";
import type { ApprovalRequest } from "./approval-gate.js";

export { unattendedApprovalDenial as approvalPresentationDenial };

export function presentApproval<T>(present: () => T): T | undefined {
  if (unattendedApprovalDenial()) return undefined;
  return present();
}

export class UnattendedApprovalPresentationError extends Error {
  constructor(readonly reasonCode: NonNullable<ReturnType<typeof unattendedApprovalDenial>>) {
    super(reasonCode);
    this.name = "UnattendedApprovalPresentationError";
  }
}

export function presentRequiredApproval<T>(present: () => T): T {
  const denial = unattendedApprovalDenial();
  if (denial) throw new UnattendedApprovalPresentationError(denial);
  return present();
}

type ApprovalCardTarget = { send(channel: string, card: unknown): void };

export interface ApprovalCardPresenters {
  presentApprovalCard(target: ApprovalCardTarget, card: ApprovalRequest): void;
  presentQuestionCard(target: ApprovalCardTarget, card: AskUserQuestionRequest): void;
}

let cardPresentation: { presenters: ApprovalCardPresenters } | undefined;

/** Desktop boot owns renderer delivery. A windowless host has no renderer presenter. */
export function installApprovalCardPresenters(presenters: ApprovalCardPresenters): () => void {
  const registration = { presenters };
  cardPresentation = registration;
  return () => { if (cardPresentation === registration) cardPresentation = undefined; };
}

export function requireApprovalCardPresenters(): ApprovalCardPresenters {
  if (!cardPresentation) throw new Error("Approval cards require a desktop host");
  return cardPresentation.presenters;
}

export function presentRemoteApprovalCard(
  client: Pick<TelegramBotApiClient, "sendDecisionCard">,
  ...args: Parameters<TelegramBotApiClient["sendDecisionCard"]>
): ReturnType<TelegramBotApiClient["sendDecisionCard"]> | undefined {
  return presentApproval(() => client.sendDecisionCard(...args));
}
