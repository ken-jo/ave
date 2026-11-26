import { WORK_BOARD } from "./ipc-channels.js";

const DECISION_CHANNELS = [WORK_BOARD.decidePlan, WORK_BOARD.decideStage, WORK_BOARD.decideJoin, WORK_BOARD.retryStage, WORK_BOARD.openJoin] as const;
export type WorkBoardDecisionChannel = typeof DECISION_CHANNELS[number];

export const WORK_BOARD_DECISION_ATTRIBUTE = "data-work-board-decision";

export function workBoardDecisionKey(channel: WorkBoardDecisionChannel, itemId: unknown, input: unknown): string {
  const binding = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const { runId, planHash, stageId, attempt, resultHash, outputHash, joinId, conflictHash, decision } = binding;
  return JSON.stringify([channel, itemId, runId, planHash, stageId, attempt, resultHash, outputHash, joinId, conflictHash, decision]);
}

export function isWorkBoardDecisionKey(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  return DECISION_CHANNELS.some(channel => value.startsWith(`["${channel}",`));
}

export function workBoardDecisionProps(channel: WorkBoardDecisionChannel, itemId: number, input: unknown) {
  return { [WORK_BOARD_DECISION_ATTRIBUTE]: workBoardDecisionKey(channel, itemId, input) };
}
