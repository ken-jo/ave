import { randomUUID } from "node:crypto";
import { ipcRenderer } from "electron";
import { WORK_BOARD } from "../shared/ipc-channels.js";
import { WORK_BOARD_DECISION_ATTRIBUTE, workBoardDecisionKey, type WorkBoardDecisionChannel } from "../shared/work-board-decision-intent.js";

let clicked: { event: Event; key: string } | undefined;

function snapshotDecision(event: Event, control: Element | undefined): void {
  const key = event.isTrusted ? control?.getAttribute(WORK_BOARD_DECISION_ATTRIBUTE) : null;
  clicked = key ? { event, key } : undefined;
}

globalThis.window?.addEventListener("click", event => {
  const button = event.composedPath().find(node => node instanceof HTMLButtonElement);
  snapshotDecision(event, button instanceof HTMLButtonElement && !button.disabled ? button : undefined);
}, true);

// The launch form also submits from Enter in a text field.
globalThis.window?.addEventListener("submit", event => {
  snapshotDecision(event, event.target instanceof HTMLFormElement ? event.target : undefined);
}, true);

export async function invokeWorkBoardDecision(channel: WorkBoardDecisionChannel, subject: unknown, input: unknown): Promise<unknown> {
  const key = workBoardDecisionKey(channel, subject, input);
  const gesture = clicked;
  if (gesture && gesture.event.eventPhase !== Event.NONE && gesture.key === key) {
    clicked = undefined;
    const token = randomUUID();
    if (await ipcRenderer.invoke(WORK_BOARD.captureDecisionIntent, token, key) === true) {
      return ipcRenderer.invoke(channel, subject, input, token);
    }
  }
  return ipcRenderer.invoke(channel, subject, input);
}
