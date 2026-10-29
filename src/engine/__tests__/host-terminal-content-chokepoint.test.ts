// Every tool result that reaches the model in a user turn passes one point, ConversationHistory's append, which marks the turn so its host
// terminal commands need a fresh card. These tests pin that point and fail when a new path builds a tool result row outside it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationHistory } from "../conversation-history.js";
import { currentHostTerminalTurn, runWithHostTerminalTurn } from "../../tools/host-terminal-turn.js";

const ENGINE = resolve(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return name.endsWith(".ts") ? [path] : [];
  });
}

/** Files that build `role: "tool_result"` rows from rows already in a history (wire projection, compaction stubs), never new content. */
const TRANSFORMS_OF_EXISTING_ROWS = new Set(["wire-serialize.ts", "auto-compact.ts"]);

describe("host terminal external-content chokepoint", () => {
  it("marks the user turn when a tool result enters the history by either append path, and not for other rows", async () => {
    for (const append of ["append", "appendToolResult"] as const) {
      await runWithHostTerminalTurn({ sessionId: "pane", turnId: "turn-1" }, async () => {
        const history = new ConversationHistory();
        const turn = currentHostTerminalTurn("pane")!;
        history.append({ role: "user", content: "run it" });
        history.append({ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "fetch_page", input: {} }] });
        expect(turn.externalContentSeen()).toBe(false);
        history[append]({ role: "tool_result", toolUseId: "t1", toolName: "fetch_page", content: "page text" });
        expect(turn.externalContentSeen(), append).toBe(true);
      });
    }
  });

  it("has exactly one insertion point in ConversationHistory, and it marks tool results", () => {
    const source = readFileSync(join(ENGINE, "conversation-history.ts"), "utf8");
    const insertions = [...source.matchAll(/this\.messages\.(splice\([^,]+,\s*0|push|unshift)\(?/gu)];
    expect(insertions).toHaveLength(1);
    const appendAt = source.slice(source.indexOf("private appendAt("), source.indexOf("private appendObserver"));
    expect(appendAt).toContain('if (stored.role === "tool_result") noteToolResultsReturnedToModel();');
    expect(appendAt).toContain("this.messages.splice(index, 0, stored)");
  });

  it("builds every new tool result row of the query loop inside a history append", () => {
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
    // The scan sees the loop's own rows (invalid arguments, intercepted denials, tool_search, request_plugin, executed results).
    expect(rows).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});
