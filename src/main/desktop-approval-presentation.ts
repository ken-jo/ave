import type {
  BaseWindow, MessageBoxOptions, MessageBoxReturnValue, OpenDialogOptions,
  OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue,
} from "electron";
import { APPROVAL_REQUEST_CHANNEL, CHANNELS } from "../contract/app-contract.js";
import { type ApprovalCardPresenters, presentApproval, presentRequiredApproval } from "../permissions/approval-presentation.js";

export const desktopApprovalCardPresenters: ApprovalCardPresenters = {
  presentApprovalCard(target, card) {
    presentRequiredApproval(() => target.send(APPROVAL_REQUEST_CHANNEL, card));
  },
  presentQuestionCard(target, card) {
    presentRequiredApproval(() => target.send(CHANNELS.askUserQuestion.request, card));
  },
};

type DialogArgs<Options> = [options: Options] | [parent: BaseWindow, options: Options];

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
