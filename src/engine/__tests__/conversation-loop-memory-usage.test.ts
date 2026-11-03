// A turn records the memories in context it assembled for send once, anchored on its user message, however many rounds it runs.
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

function makeLoop(scripts: StreamEvent[][], options: { persistSession?: boolean; onToolRun?: () => void } = {}) {
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
    execute: async () => {
      options.onToolRun?.();
      return { output: "thing", isError: false };
    },
  }));
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    systemPromptBuilder: builder,
    toolRegistry,
    disableSessionPersistence: options.persistSession !== true,
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
    // A tool round and an answer round ran; the context assembled for send is recorded once for the turn.
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

  it("records once when a guidance round reattaches the turn context", async () => {
    const rounds: number[] = [];
    // The tool queues guidance, so the next round's last row is a user message and the turn context is rebuilt with the turn's record.
    let queueGuidance = (): void => {};
    const { loop, events, selectRelevantMemories } = makeLoop(toolThenAnswer(), {
      onToolRun: () => queueGuidance(),
    });
    queueGuidance = () => { expect(loop.queueGuidance("use the lockfile too")).toBe("queued"); };
    selectRelevantMemories.mockImplementation(() => {
      rounds.push(rounds.length);
      return {
        entries: [{ filename: "a.md", title: "Package manager", content: "# Package manager\nUse bun.", id: "mem-a" }],
        context: "remembered notes",
        usedTokens: 0,
      };
    });

    await loop.runTurn("which package manager", undefined, undefined, { ...userKeyboardTurn() });

    const guidanceRow = loop.history.getMessages().find((row) =>
      row.role === "user" && typeof row.content === "string" && row.content.includes("use the lockfile too"));
    expect(guidanceRow).toBeDefined();
    // Both the opening round and the guidance round assembled turn context.
    expect(rounds.length).toBeGreaterThanOrEqual(2);
    expect(events).toHaveLength(1);
    expect(events[0]!.memoryIds).toEqual(["mem-a"]);
  });

  it("never records from the guidance preflight's token estimate", async () => {
    let queueGuidance = (): void => {};
    const { loop, events, selectRelevantMemories } = makeLoop(toolThenAnswer(), {
      persistSession: true,
      onToolRun: () => queueGuidance(),
    });
    queueGuidance = () => { expect(loop.queueGuidance("use the lockfile too")).toBe("queued"); };
    // A fresh id per selection, so a record from the estimate cannot hide behind the turn's dedupe.
    let selections = 0;
    selectRelevantMemories.mockImplementation(() => {
      selections += 1;
      return {
        entries: [{ filename: `m${selections}.md`, title: "Note", content: "# Note\nbody", id: `mem-${selections}` }],
        context: "remembered notes",
        usedTokens: 0,
      };
    });
    const estimateIds: string[] = [];
    vi.spyOn(loop, "runPreflightGuard").mockImplementation(async (ctx) => {
      // The guidance preflight measures with a turn-context build; run it as the real guard would.
      const before = selections;
      ctx.estimateCurrent?.();
      if (selections > before) estimateIds.push(`mem-${selections}`);
      return false;
    });

    await loop.runTurn("which package manager", undefined, undefined, { ...userKeyboardTurn() });

    expect(estimateIds.length).toBeGreaterThan(0);
    const recordedIds = events.flatMap((event) => event.memoryIds);
    // The assembled rounds still record their selections.
    expect(recordedIds.length).toBeGreaterThan(0);
    for (const id of estimateIds) expect(recordedIds).not.toContain(id);
  });
});
