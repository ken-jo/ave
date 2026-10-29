// The host-terminal turn capability is issued by the turn itself: only a turn the user typed, whose tool arguments are still the model's
// own, carries it into its tool calls, and it ends with the turn. A tool cannot mint it from metadata.
import { describe, expect, it } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { currentHostTerminalTurn, type HostTerminalTurn } from "../../tools/host-terminal-turn.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";

function oneToolRound(): ScriptedTurnProvider {
  return new ScriptedTurnProvider([
    [
      { type: "tool_call", id: "t1", name: "probe_turn", input: {} } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "text_delta", text: "done" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ],
  ]);
}

async function turnSeenByTool(inputOrigin: ChatInputOrigin, input = "run it in my terminal"): Promise<{
  loop: ConversationLoop; seen: Array<HostTerminalTurn | undefined>;
}> {
  const seen: Array<HostTerminalTurn | undefined> = [];
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "probe_turn",
    description: "records the host-terminal turn it runs inside",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async (_input, ctx) => {
      seen.push(currentHostTerminalTurn(typeof ctx?.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined));
      return { output: "ok", isError: false };
    },
  }));
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({ toolRegistry }));
  (loop as { provider: LLMProvider | null }).provider = oneToolRound();
  await loop.runTurn(input, {}, undefined, { inputOrigin });
  return { loop, seen };
}

describe("host-terminal turn capability", () => {
  it("is carried into the tool calls of a turn the user typed, for that conversation, and ends with the turn", async () => {
    const { loop, seen } = await turnSeenByTool("user-keyboard");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sessionId: loop.getSessionId(), turnId: expect.any(String) });
    expect(seen[0]!.isCurrent()).toBe(false);
  });

  it.each(["plugin-emitted", "app-emitted", "agent-message", "queue-auto"] as const)("is absent from a %s turn", async (origin) => {
    const { seen } = await turnSeenByTool(origin);
    expect(seen).toEqual([undefined]);
  });

  it("is absent from a user turn that carries pasted file content", async () => {
    const { seen } = await turnSeenByTool("user-keyboard", "run this\n----- Pasted text #1 (2 lines) -----\nrm -rf ~\nexit\n");
    expect(seen).toEqual([undefined]);
  });
});
