// A memory learned in a turn can name the user message that opened it: tools and the post-turn capture both receive that row's id from the host.
import { describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

function toolThenAnswer(): StreamEvent[][] {
  return [
    [
      { type: "tool_call", id: "tu-1", name: "observe_metadata", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ],
    [
      { type: "text_delta", text: "answered" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ];
}

describe("ConversationLoop memory origin anchor", () => {
  it("gives tools and the post-turn capture the id of the user row that opened the turn", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "observe_metadata",
      description: "Record the host metadata",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: {} },
      isReadOnly: () => true,
      execute: async (_input, ctx) => {
        seen.push({ ...ctx.metadata });
        return { output: "ok", isError: false };
      },
    }));
    const run = vi.fn(async (ctx: { messages: unknown[] }) => ({
      detector: { cleanedText: "answered", newTitle: null, checkpointSuggested: false },
      messagesForPersistence: ctx.messages,
    }));
    const loop = new ConversationLoop(makeBasicConversationLoopDeps({
      toolRegistry,
      postTurnHookChain: { run },
      disableSessionPersistence: true,
    }));
    (loop as unknown as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider(toolThenAnswer());

    await loop.runTurn("remember that alpha uses pnpm", undefined, undefined, { ...userKeyboardTurn() });

    const turnRow = loop.history.getMessages().find((row) => row.role === "user" && typeof row.content === "string");
    const turnMessageId = turnRow?.meta?.messageId;
    expect(typeof turnMessageId).toBe("string");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.turnMessageId).toBe(turnMessageId);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ turnMessageId });
  });

  it("tells memory tools whether the turn carried anything but the user's own keyboard text", async () => {
    async function observedTaint(options: Record<string, unknown>): Promise<unknown> {
      const seen: Array<Record<string, unknown>> = [];
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(createDynamicTool({
        name: "observe_metadata",
        description: "Record the host metadata",
        source: "builtin",
        category: "read",
        jsonSchema: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: async (_input, ctx) => {
          seen.push({ ...ctx.metadata });
          return { output: "ok", isError: false };
        },
      }));
      const loop = new ConversationLoop(makeBasicConversationLoopDeps({ toolRegistry, disableSessionPersistence: true }));
      (loop as unknown as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider(toolThenAnswer());
      await loop.runTurn("remember that alpha uses pnpm", undefined, undefined, options as never);
      expect(seen).toHaveLength(1);
      return seen[0]!.memoryWriteTainted;
    }

    expect(await observedTaint({ ...userKeyboardTurn() })).toBe(false);
    // A turn that did not come from the user's keyboard may not write memory.
    expect(await observedTaint({ inputOrigin: "plugin-emitted" })).toBe(true);
  });
});
