import { vi } from "vitest";
import type { ConversationLoop, TurnResult } from "../../../engine/conversation-loop.js";

const completedTurn: TurnResult = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
};

export function makeLoop() {
  const runTurn = vi.fn(async (..._args: unknown[]): Promise<TurnResult> => completedTurn);
  const loop = { runTurn } as unknown as ConversationLoop;
  return { loop, runTurn };
}

export function turnOptions(
  runTurn: ReturnType<typeof makeLoop>["runTurn"],
): Record<string, unknown> {
  return (runTurn.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
}
