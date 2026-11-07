import { describe, expect, it } from "vitest";
import type { ConversationLoop } from "../../../engine/conversation-loop.js";
import { sessionHeldByOtherLoop } from "../conversation-wiring.js";

function loopOn(sessionId: string): ConversationLoop {
  return { getSessionId: () => sessionId } as unknown as ConversationLoop;
}

describe("sessionHeldByOtherLoop", () => {
  it("sees every other loop, never itself, and reads both lazily", () => {
    const primary = loopOn("session-primary");
    const groups = new Map<string, ConversationLoop>();
    const loops = () => [primary, ...groups.values()];

    const primaryHeld = sessionHeldByOtherLoop(loops, () => primary);
    // Resolve tiles at call time so newly opened tiles are included.
    expect(primaryHeld("session-tile")).toBe(false);
    const tile = loopOn("session-tile");
    groups.set("group-2", tile);
    expect(primaryHeld("session-tile")).toBe(true);
    expect(primaryHeld("session-primary")).toBe(false);

    const tileHeld = sessionHeldByOtherLoop(loops, () => tile);
    expect(tileHeld("session-primary")).toBe(true);
    expect(tileHeld("session-tile")).toBe(false);
    expect(tileHeld("session-archived")).toBe(false);

    groups.delete("group-2");
    expect(primaryHeld("session-tile")).toBe(false);
  });
});

describe("two loops loading one conversation at once", () => {
  it("lets only the first load win: the target is held from the check, not only once its identity is swapped", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const { ConversationLoop } = await import("../../../engine/conversation-loop.js");
    const { MemoryManager } = await import("../../../memory/memory-manager.js");
    const { ToolRegistry } = await import("../../../tools/registry.js");
    const { makeSubagentLoopDeps } = await import("../../../engine/__tests__/support/subagent-loop-fixtures.js");
    const { cleanupTmpDir } = await import("../../../__tests__/support/tmp-dir-teardown.js");
    const root = mkdtempSync(join(tmpdir(), "ave-held-race-"));
    const memory = new MemoryManager({ aveDir: root });
    memory.load();
    try {
      const chat = randomUUID();
      await memory.sessions.saveSession(chat, [{ role: "user", content: "hello" }]);
      const loops: InstanceType<typeof ConversationLoop>[] = [];
      const make = () => {
        let self!: InstanceType<typeof ConversationLoop>;
        self = new ConversationLoop(makeSubagentLoopDeps(new ToolRegistry(), {
          memoryManager: memory,
          sessionHeldElsewhere: sessionHeldByOtherLoop(() => loops, () => self),
        }));
        loops.push(self);
        return self;
      };
      const tile = make();
      const routine = make();
      // Both start before either finishes: the second must see the first one's pending load.
      const results = await Promise.all([routine.loadSession(chat), tile.loadSession(chat)]);
      expect(results).toEqual([true, false]);
      expect(loops.filter((loop) => loop.getSessionId() === chat)).toEqual([routine]);
      // A finished or refused load leaves no reservation behind.
      expect(routine.getSessionLoadTarget()).toBeNull();
      expect(tile.getSessionLoadTarget()).toBeNull();
    } finally {
      memory.sessions.closeSearchIndex();
      await cleanupTmpDir(root);
    }
  });
});
