// A turn records the memories it actually sent once, anchored on its user message, however many rounds it runs.
import { describe, expect, it, vi } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import { makePromptMemorySource } from "../../prompts/__tests__/test-helpers.js";
import type { MemoryUseEvent } from "../../memory/memory-usage-log.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider } from "./support/conversation-loop-fixtures.js";
import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

function toolThenAnswer(): StreamEvent[][] {
  return [
    [
      { type: "tool_call", id: "tu-1", name: "read_thing", input: {} },
      { type: "message_complete", stopReason: "tool_use" },
    ],
    [
      { type: "text_delta", text: "answered" },
      { type: "message_complete", stopReason: "end_turn" },
    ],
  ];
}

function makeLoop(scripts: StreamEvent[][]) {
  const events: MemoryUseEvent[] = [];
  const selectRelevantMemories = vi.fn(() => ({
    entries: [
      { filename: "a.md", title: "Package manager", content: "# Package manager\nUse bun.", id: "mem-a" },
      { filename: "legacy.md", title: "Legacy", content: "# Legacy\nold" },
    ],
    context: "remembered notes",
    usedTokens: 0,
  }));
  const builder = new SystemPromptBuilder({
    memoryManager: makePromptMemorySource({ selectRelevantMemories }),
    toolRegistry: new ToolRegistry(),
    memoryUsageLog: { record: (event) => { events.push(event); } },
  });
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "read_thing",
    description: "Read a thing",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    isReadOnly: () => true,
    execute: async () => ({ output: "thing", isError: false }),
  }));
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    systemPromptBuilder: builder,
    toolRegistry,
    disableSessionPersistence: true,
  }));
  (loop as unknown as { provider: LLMProvider | null }).provider = new ScriptedTurnProvider(scripts);
  return { loop, events, selectRelevantMemories };
}

describe("ConversationLoop memory use", () => {
  it("records injected memory ids once per turn, anchored on the turn's user message", async () => {
    const { loop, events, selectRelevantMemories } = makeLoop([
      ...toolThenAnswer(),
      [
        { type: "text_delta", text: "second" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);

    await loop.runTurn("which package manager", undefined, undefined, { ...userKeyboardTurn() });
    // A tool round and an answer round ran; the sent context is recorded once for the turn.
    expect(selectRelevantMemories).toHaveBeenCalled();
    const userRows = loop.history.getMessages().filter((row) => row.role === "user" && typeof row.content === "string");
    expect(events).toEqual([{
      memoryIds: ["mem-a"],
      via: "injected",
      sessionId: loop.sessionId,
      store: "main",
      anchorMessageId: userRows[0]!.meta!.messageId,
    }]);

    await loop.runTurn("and the version", undefined, undefined, { ...userKeyboardTurn() });
    const userRowsAfter = loop.history.getMessages().filter((row) => row.role === "user" && typeof row.content === "string");
    expect(events).toHaveLength(2);
    expect(events[1]!.anchorMessageId).toBe(userRowsAfter.at(-1)!.meta!.messageId);
    expect(events[1]!.anchorMessageId).not.toBe(events[0]!.anchorMessageId);
  });
});
