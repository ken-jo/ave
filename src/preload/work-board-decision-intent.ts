import { ipcRenderer } from "electron";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { WORK_BOARD_DECISION_ATTRIBUTE, workBoardDecisionKey, type WorkBoardDecisionChannel } from "../shared/work-board-decision-intent.js";
import { captureUserKeyboardIntent, consumeUserKeyboardIntent } from "./gesture-intent.js";

let clicked: { event: Event; key: string } | undefined;

// Snapshot the actual control before renderer click handlers run. A synthetic event cannot replace the snapshot or mint a receipt.
globalThis.window?.addEventListener("click", event => {
  clicked = undefined;
  if (!event.isTrusted) return;
  const button = event.composedPath().find(node => node instanceof HTMLButtonElement);
  const key = button instanceof HTMLButtonElement && !button.disabled ? button.getAttribute(WORK_BOARD_DECISION_ATTRIBUTE) : null;
  clicked = key ? { event, key } : undefined;
}, true);

export async function invokeWorkBoardDecision(channel: WorkBoardDecisionChannel, itemId: number, input: unknown): Promise<unknown> {
  const key = workBoardDecisionKey(channel, itemId, input);
  const gesture = clicked;
  if (gesture && gesture.event.eventPhase !== Event.NONE && gesture.key === key) {
    clicked = undefined;
    const intent = captureUserKeyboardIntent();
    if (consumeUserKeyboardIntent(intent) && await ipcRenderer.invoke(WORK_BOARD.captureDecisionIntent, intent.token, key) === true) {
      return ipcRenderer.invoke(channel, itemId, input, intent.token);
    }
  }
  return ipcRenderer.invoke(channel, itemId, input);
}
