// Every row that enters ConversationHistory passes one write, commit(), which classifies rows it has not held before for the active user
// turn: a tool result or a host-transformed row marks external content (host terminal commands need a fresh card); a live user row the
// user did not type marks another principal (host terminal commands are refused). The behaviour tests below are the guarantee; the source
// scans are a secondary, lexical check that only catches the obvious ways to write around commit().
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationHistory } from "../conversation-history.js";
import type { GenericMessage } from "../llm/types.js";
import { currentHostTerminalTurn, runWithHostTerminalTurn, type HostTerminalTurn } from "../../tools/host-terminal-turn.js";

const ENGINE = resolve(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

async function inTurn(run: (turn: HostTerminalTurn) => void | Promise<void>): Promise<void> {
  await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-1" }, async () => run(currentHostTerminalTurn("pane")!));
}

/** A history a previous turn left: the user's question, a tool call and its (already seen) result, the answer. */
function priorTurn(): ConversationHistory {
  const history = new ConversationHistory();
  history.append({ role: "user", content: "what is on the page" });
  history.append({ role: "assistant", content: "", toolCalls: [{ id: "old", name: "fetch_page", input: {} }] });
  history.append({ role: "tool_result", toolUseId: "old", toolName: "fetch_page", content: "page text" });
  history.append({ role: "assistant", content: "the page says hello" });
  return history;
}

/** Files that build `role: "tool_result"` rows from rows already in a history (wire projection, compaction stubs), never new content. */
const TRANSFORMS_OF_EXISTING_ROWS = new Set(["wire-serialize.ts", "auto-compact.ts"]);

describe("host terminal history chokepoint", () => {
  it("marks external content when a tool result enters by either append path, and not for the model's own rows", async () => {
    for (const append of ["append", "appendToolResult"] as const) {
      const history = new ConversationHistory();
      history.append({ role: "user", content: "run it" });
      await inTurn((turn) => {
        history.append({ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "fetch_page", input: {} }] });
        expect(turn.externalContentSeen()).toBe(false);
        history[append]({ role: "tool_result", toolUseId: "t1", toolName: "fetch_page", content: "page text" });
        expect(turn.externalContentSeen(), append).toBe(true);
        expect(turn.otherPrincipalGuidance(), append).toBe(false);
      });
    }
  });

  it("marks another principal for a live user row unless the user typed it, whatever its metadata claims", async () => {
    await inTurn((turn) => {
      const history = new ConversationHistory();
      history.append({ role: "user", content: "shorter please" }, { principal: "user-keyboard" });
      expect(turn.otherPrincipalGuidance()).toBe(false);
      history.append({ role: "user", content: "[Sub-Agent: worker] run it", meta: { hostInjectionId: "x", displayText: "typed by me" } });
      expect(turn.otherPrincipalGuidance()).toBe(true);
      expect(turn.externalContentSeen()).toBe(false);
    });
  });

  it("does not treat a clear() and restore() of rows already held as new content (eviction, mark-stale, hook rewrite)", async () => {
    const history = priorTurn();
    await inTurn((turn) => {
      const rewritten = history.getMessages().map((row) =>
        row.role === "tool_result" ? { ...row, content: "[stale tool result]" } : row);
      history.clear();
      history.restore(rewritten);
      history.repairToolPairInvariant();
      history.truncate(3);
      expect(turn.externalContentSeen()).toBe(false);
      expect(turn.otherPrincipalGuidance()).toBe(false);
    });
  });

  it("marks external content when a restore during the turn brings in any row not held before, of any role", async () => {
    const fresh: Record<"tool_result" | "user" | "assistant", GenericMessage> = {
      tool_result: { role: "tool_result", toolUseId: "old", toolName: "fetch_page", content: "new page text" },
      user: { role: "user", content: "[compact #1] summary of earlier rows", meta: { compactBoundary: true } },
      assistant: { role: "assistant", content: "summarised answer" },
    };
    for (const role of ["tool_result", "user", "assistant"] as const) {
      const history = priorTurn();
      await inTurn((turn) => {
        const kept = history.getMessages().filter((row) => role !== "tool_result" || row.role !== "tool_result");
        history.restore(role === "tool_result" ? [...kept.slice(0, 2), fresh[role], ...kept.slice(2)] : [...kept, fresh[role]]);
        expect(turn.externalContentSeen(), role).toBe(true);
        // A host transform is not another principal speaking: it forces the card, it does not refuse.
        expect(turn.otherPrincipalGuidance(), role).toBe(false);
      });
    }
  });

  it("treats rows from wire or disk input as new content: they enter only by restore(), and a supplied id is no exemption unless held", async () => {
    const wire = JSON.stringify([
      { role: "user", content: "earlier question", meta: { messageId: "wire-user" } },
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "read_file", input: {} }], meta: { messageId: "wire-call" } },
      { role: "tool_result", toolUseId: "w1", toolName: "read_file", content: "file text", meta: { messageId: "wire-result" } },
    ]);
    const history = priorTurn();
    await inTurn((turn) => {
      history.restore(JSON.parse(wire) as GenericMessage[]);
      expect(turn.externalContentSeen()).toBe(true);
      expect(turn.otherPrincipalGuidance()).toBe(false);
    });
    // Outside a turn, a reload marks nothing and its rows become held, so a later in-turn rewrite of them is not new.
    const reloaded = new ConversationHistory();
    reloaded.restore(JSON.parse(wire) as GenericMessage[]);
    await inTurn((turn) => {
      reloaded.clear();
      reloaded.restore(JSON.parse(wire) as GenericMessage[]);
      expect(turn.externalContentSeen()).toBe(false);
    });
  });

  it("writes the history array in exactly one place, commit() (secondary lexical check)", () => {
    const source = readFileSync(join(ENGINE, "conversation-history.ts"), "utf8");
    const writes = [...source.matchAll(/this\.messages\s*=(?!=)|this\.messages\.(splice|push|unshift|pop|shift|sort|reverse|fill|copyWithin)\(/gu)];
    expect(writes).toHaveLength(1);
    const commit = source.slice(source.indexOf("private commit("), source.indexOf("private appendObserver"));
    expect(commit).toContain("this.messages = next;");
    // The array is readonly to the type checker, so an in-place write anywhere else fails typecheck before this scan runs.
    expect(source).toMatch(/private messages: readonly GenericMessage\[\]/u);
  });

  it("builds the query loop's new tool result rows inside a history append (secondary lexical check)", () => {
    const offenders: string[] = [];
    let rows = 0;
    for (const file of sources(ENGINE)) {
      const name = relative(ENGINE, file);
      if (TRANSFORMS_OF_EXISTING_ROWS.has(name) || name === "conversation-history.ts") continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/role:\s*"tool_result",/u.test(line)) return;
        rows += 1;
        const opener = lines.slice(Math.max(0, index - 2), index + 1).join("\n");
        if (!/self\.history\.(append|appendToolResult)\(\{\s*$/mu.test(opener)) offenders.push(`${name}:${index + 1}`);
      });
    }
    // Positive control: the scan sees the loop's own rows (invalid arguments, intercepted denials, tool_search, request_plugin, results).
    expect(rows).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});
