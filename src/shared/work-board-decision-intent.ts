import { WORK_BOARD } from "./ipc-channels.js";

const DECISION_CHANNELS = [
  WORK_BOARD.decidePlan, WORK_BOARD.decideStage, WORK_BOARD.decideJoin, WORK_BOARD.retryStage,
  WORK_BOARD.openJoin, WORK_BOARD.templateConfirm, WORK_BOARD.run, WORK_BOARD.add,
] as const;
export type WorkBoardDecisionChannel = typeof DECISION_CHANNELS[number];

export const WORK_BOARD_DECISION_ATTRIBUTE = "data-work-board-decision";

export function workBoardDecisionKey(channel: WorkBoardDecisionChannel, subject: unknown, input: unknown): string {
  return JSON.stringify([channel, subject, input], (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
      : value);
}

export function workBoardDecisionChannel(key: unknown): WorkBoardDecisionChannel | undefined {
  // The largest action carries the title and detail of a new item, including JSON escaping.
  if (typeof key !== "string" || key.length > 120_000) return undefined;
  return DECISION_CHANNELS.find(channel => key.startsWith(`["${channel}",`));
}

export function workBoardDecisionProps(channel: WorkBoardDecisionChannel, subject: unknown, input: unknown) {
  return { [WORK_BOARD_DECISION_ATTRIBUTE]: workBoardDecisionKey(channel, subject, input) };
}
