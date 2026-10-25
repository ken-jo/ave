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
