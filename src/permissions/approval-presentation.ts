import type {
  BaseWindow, MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions,
  OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue, WebContents,
} from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { AskUserQuestionRequest } from "../main/ask-user-question-gate.js";
import type { TelegramBotApiClient } from "../main/telegram-bot-api-client.js";
import { unattendedApprovalDenial } from "../shared/turn-extension-policy.js";
import type { ApprovalRequest } from "./approval-gate.js";

export { unattendedApprovalDenial as approvalPresentationDenial };

export function presentApproval<T>(present: () => T): T | undefined {
  if (unattendedApprovalDenial()) return undefined;
  return present();
}

export const IPC_APPROVAL_REQUEST = CHANNELS.approval.request;
const IPC_ASK_USER_QUESTION_REQUEST = CHANNELS.askUserQuestion.request;

export function presentRequiredApproval<T>(present: () => T): T {
  const denial = unattendedApprovalDenial();
  if (denial) throw new Error(denial);
  return present();
}

export function presentApprovalCard(target: WebContents, card: ApprovalRequest): void {
  presentApproval(() => target.send(IPC_APPROVAL_REQUEST, card));
}

export function presentQuestionCard(target: WebContents, card: AskUserQuestionRequest): void {
  presentApproval(() => target.send(IPC_ASK_USER_QUESTION_REQUEST, card));
}

export function presentRemoteApprovalCard(
  client: Pick<TelegramBotApiClient, "sendDecisionCard">,
  ...args: Parameters<TelegramBotApiClient["sendDecisionCard"]>
): ReturnType<TelegramBotApiClient["sendDecisionCard"]> | undefined {
  return presentApproval(() => client.sendDecisionCard(...args));
}

type DialogArgs<Options> = [options: Options] | [parent: BaseWindow, options: Options];

// Load the desktop API only on an allowed presentation. The same gate runs in windowless hosts.
export async function pickNativeFiles(...args: DialogArgs<OpenDialogOptions>): Promise<OpenDialogReturnValue> {
  return presentApproval(async () => {
    const { dialog } = await import("electron");
    return args.length === 1 ? dialog.showOpenDialog(args[0]) : dialog.showOpenDialog(args[0], args[1]);
  }) ?? { canceled: true, filePaths: [] };
}

export async function pickNativeSavePath(...args: DialogArgs<SaveDialogOptions>): Promise<SaveDialogReturnValue> {
  return presentApproval(async () => {
    const { dialog } = await import("electron");
    return args.length === 1 ? dialog.showSaveDialog(args[0]) : dialog.showSaveDialog(args[0], args[1]);
  }) ?? { canceled: true, filePath: "" };
}

export async function showNativeMessage(...args: DialogArgs<MessageBoxOptions>): Promise<MessageBoxReturnValue | undefined> {
  return presentApproval(async () => {
    const { dialog } = await import("electron");
    return args.length === 1 ? dialog.showMessageBox(args[0]) : dialog.showMessageBox(args[0], args[1]);
  });
}

export async function showNativeError(title: string, detail: string): Promise<void> {
  await presentApproval(async () => {
    const { dialog } = await import("electron");
    dialog.showErrorBox(title, detail);
  });
}
