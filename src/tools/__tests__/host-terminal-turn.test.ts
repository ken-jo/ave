// The host-terminal turn capability: readable only inside the turn that issued it, for its own conversation, masked for nested runs.
import { describe, expect, it } from "vitest";
import { currentHostTerminalTurn, noteToolResultsReturnedToModel, runWithHostTerminalTurn } from "../host-terminal-turn.js";
import { buildHostTerminalRuleApproval } from "../../permissions/rules/shell-rule-approval.js";

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

  it("records, for the rest of the turn only, that tool results have reached the model", async () => {
    noteToolResultsReturnedToModel();
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-1" }, async () => {
      const turn = currentHostTerminalTurn("pane")!;
      expect(turn.externalContentSeen()).toBe(false);
      // A nested, masked run (a sub-agent) cannot clear or set the user's turn fact.
      await runWithHostTerminalTurn(undefined, async () => { noteToolResultsReturnedToModel(); });
      expect(turn.externalContentSeen()).toBe(false);
      noteToolResultsReturnedToModel();
      expect(turn.externalContentSeen()).toBe(true);
      expect(currentHostTerminalTurn("pane")!.externalContentSeen()).toBe(true);
    });
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-2" }, async () => {
      expect(currentHostTerminalTurn("pane")!.externalContentSeen()).toBe(false);
    });
  });

  it("builds a host card with no lasting allow after external content, and the exact rule otherwise", () => {
    const binding = { tabId: "terminal:0000c0de-1", terminalSessionId: "host", sessionId: "pane", shell: "zsh" as const, physicalCwd: process.cwd(), command: "printf ready" };
    const clean = buildHostTerminalRuleApproval(binding, { allow: true, deny: true });
    expect(clean).toMatchObject({ exactRule: expect.stringContaining("HostTerminal("), persistentAllowed: true, hostTerminal: { shell: "zsh", cwd: process.cwd() } });
    expect(clean.hostTerminal).not.toHaveProperty("afterExternalContent");
    const after = buildHostTerminalRuleApproval({ ...binding, afterExternalContent: true }, { allow: true, deny: true });
    expect(after).toMatchObject({ exactRule: null, persistentAllowed: false, sessionAllowed: false, hostTerminal: { afterExternalContent: true } });
    expect(after.denyAllowed).toBe(true);
  });
});
