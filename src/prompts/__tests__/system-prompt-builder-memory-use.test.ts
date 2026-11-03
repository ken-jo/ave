// Injected memories are recorded by id only, once per turn, and only for builders bound to the user's memory store.
import { describe, expect, it, vi } from "vitest";

import type { NoteEntry } from "../../memory/memory-manager.js";
import type { MemoryUseEvent } from "../../memory/memory-usage-log.js";
import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder, type TurnMemoryUse } from "../system-prompt-builder.js";
import { makePromptMemorySource } from "./test-helpers.js";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";

function note(title: string, id?: string): NoteEntry {
  return { filename: `${title}.md`, title, content: `# ${title}\nremembered body for ${title}`, ...(id ? { id } : {}) };
}

function makeBuilder(entries: NoteEntry[], context = "selected notes") {
  const events: MemoryUseEvent[] = [];
  const memoryUsageLog = { record: vi.fn((event: MemoryUseEvent) => { events.push(event); }) };
  const builder = new SystemPromptBuilder({
    memoryManager: makePromptMemorySource({
      selectRelevantMemories: vi.fn(() => ({ entries, context, usedTokens: 0 })),
    }),
    toolRegistry: new ToolRegistry(),
    memoryUsageLog,
  });
  return { builder, events, memoryUsageLog };
}

function turnUse(overrides: Partial<TurnMemoryUse> = {}): TurnMemoryUse {
  return { sessionId: SESSION, anchorMessageId: "msg-user-1", recorded: new Set<string>(), ...overrides };
}

describe("SystemPromptBuilder memory use", () => {
  it("records each injected managed memory id once, with session and anchor, and never its text", () => {
    const { builder, events } = makeBuilder([note("Package manager", "mem-a"), note("Legacy note"), note("Reply language", "mem-b")]);

    const text = builder.buildTurnContext("bun", null, turnUse());

    expect(text).toContain("<ave-user-memory>");
    expect(events).toEqual([
      { memoryIds: ["mem-a", "mem-b"], via: "injected", sessionId: SESSION, store: "main", anchorMessageId: "msg-user-1" },
    ]);
    expect(JSON.stringify(events)).not.toContain("remembered body");
    expect(JSON.stringify(events)).not.toContain("bun");
  });

  it("does not record again for a later round of the same turn", () => {
    const { builder, events } = makeBuilder([note("Package manager", "mem-a")]);
    const use = turnUse();

    builder.buildTurnContext("bun", null, use);
    builder.buildTurnContext("bun", null, use);

    expect(events).toHaveLength(1);
    expect([...use.recorded]).toEqual(["mem-a"]);
  });

  it("does not record estimation-only builds that carry no turn use", () => {
    const { builder, memoryUsageLog } = makeBuilder([note("Package manager", "mem-a")]);
    builder.buildTurnContext("bun", null);
    expect(memoryUsageLog.record).not.toHaveBeenCalled();
  });

  it("does not record when nothing was injected", () => {
    const { builder, memoryUsageLog } = makeBuilder([note("Package manager", "mem-a")], "");
    builder.buildTurnContext("bun", null, turnUse());
    const legacyOnly = makeBuilder([note("Legacy note")]);
    legacyOnly.builder.buildTurnContext("bun", null, turnUse());
    expect(memoryUsageLog.record).not.toHaveBeenCalled();
    expect(legacyOnly.memoryUsageLog.record).not.toHaveBeenCalled();
  });

  it("omits the anchor when the turn has none and marks namespaced child sessions as the sub-agent store", () => {
    const { builder, events } = makeBuilder([note("Package manager", "mem-a")]);
    const child = "sub-1a2b3c4d-0f8fad5b-d9cb-469f-a165-70867728950e";
    builder.buildTurnContext("bun", null, { sessionId: child, recorded: new Set() });
    expect(events).toEqual([{ memoryIds: ["mem-a"], via: "injected", sessionId: child, store: "subagent" }]);
  });

  it("drops the recorder for isolated child builders, whose memory store is not the user's", () => {
    const { builder, memoryUsageLog } = makeBuilder([note("Package manager", "mem-a")]);
    const child = builder.createIsolated({
      memoryManager: makePromptMemorySource({
        selectRelevantMemories: vi.fn(() => ({ entries: [note("Child note", "child-mem")], context: "child notes", usedTokens: 0 })),
      }),
      toolRegistry: new ToolRegistry(),
    });

    expect(child.buildTurnContext("bun", null, turnUse())).toContain("child notes");
    expect(memoryUsageLog.record).not.toHaveBeenCalled();
    expect(child.memoryUsageRecorder).toBeUndefined();
    expect(builder.memoryUsageRecorder).toBe(memoryUsageLog);
  });
});
