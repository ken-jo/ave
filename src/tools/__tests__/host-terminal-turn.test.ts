// The host-terminal turn capability: readable only inside the turn that issued it, for its own conversation, masked for nested runs.
import { describe, expect, it } from "vitest";
import { currentHostTerminalTurn, runWithHostTerminalTurn } from "../host-terminal-turn.js";

describe("host-terminal turn capability", () => {
  it("is read only inside its turn and for its own conversation, and ends with the turn", async () => {
    const ended: string[] = [];
    const seen = await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-1" }, async () => {
      expect(currentHostTerminalTurn("other")).toBeUndefined();
      expect(currentHostTerminalTurn(undefined)).toBeUndefined();
      const turn = currentHostTerminalTurn("pane")!;
      turn.onEnd(() => ended.push("listener"));
      const off = turn.onEnd(() => ended.push("unsubscribed"));
      off();
      return turn;
    });
    expect(seen).toMatchObject({ sessionId: "pane", turnId: "turn-1" });
    expect(seen.isCurrent()).toBe(false);
    expect(ended).toEqual(["listener"]);
    // A listener added after the end runs at once; outside any turn nothing is current.
    seen.onEnd(() => ended.push("late"));
    expect(ended).toEqual(["listener", "late"]);
    expect(currentHostTerminalTurn("pane")).toBeUndefined();
  });

  it("is masked for a sub-agent run nested inside the user's turn, which stays current afterwards", async () => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-1" }, async () => {
      await runWithHostTerminalTurn(undefined, async () => {
        expect(currentHostTerminalTurn("pane")).toBeUndefined();
      });
      expect(currentHostTerminalTurn("pane")?.isCurrent()).toBe(true);
    });
  });

  it("ends the turn and runs its end listeners when the turn throws", async () => {
    let seen: ReturnType<typeof currentHostTerminalTurn>;
    let ended = false;
    await expect(runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-1" }, async () => {
      seen = currentHostTerminalTurn("pane");
      seen!.onEnd(() => { ended = true; });
      throw new Error("turn failed");
    })).rejects.toThrow("turn failed");
    expect(seen!.isCurrent()).toBe(false);
    expect(ended).toBe(true);
  });
});
