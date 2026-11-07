import { describe, it, expect } from "vitest";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { approvalTriggerMessage, classifyTurnEntries, isTurnStartEntry } from "../utils/classify-turn-entries.js";
import { userEntry } from "../../../__tests__/test-helpers.js";

const assistant = (text: string, extra: Partial<Extract<ChatEntry, { kind: "assistant" }>> = {}): ChatEntry => ({
  kind: "assistant",
  text,
  ...extra,
});
const toolGroup = (): ChatEntry => ({
  kind: "tool_group",
  groupId: "g",
  groupIds: ["g"],
  status: "done",
  tools: [{ toolUseId: "t1", name: "x", displayOrder: 0, status: "done" }],
});

describe("isTurnStartEntry", () => {
  it("is true for user and imported_trigger, false otherwise", () => {
    expect(isTurnStartEntry({ kind: "user", text: "" })).toBe(true);
    expect(
      isTurnStartEntry({
        kind: "imported_trigger",
        sessionId: "s",
        source: "o",
        prompt: "p",
        summary: "sum",
        toolCallCount: 0,
        importedAt: "2026-01-01",
      }),
    ).toBe(true);
    expect(isTurnStartEntry({ kind: "assistant", text: "" })).toBe(false);
    expect(isTurnStartEntry(undefined)).toBe(false);
  });
});

describe("classifyTurnEntries", () => {
  it("marks the last completed assistant as final (non-streaming)", () => {
    const entries: ChatEntry[] = [userEntry("q"), assistant("a")];
    const { lastTurnStartIdx, entryClassMap, finalTurnStartMap } = classifyTurnEntries(entries, false);
    expect(lastTurnStartIdx).toBe(0);
    expect(entryClassMap.get(1)).toBe("final");
    expect(finalTurnStartMap.get(1)).toBe(0);
  });

  it("collapses mid-turn work to intermediate, final answer stays final", () => {
    const entries: ChatEntry[] = [userEntry("q"), toolGroup(), assistant("done")];
    const { entryClassMap, entryTurnStartMap } = classifyTurnEntries(entries, false);
    expect(entryClassMap.get(1)).toBe("intermediate"); // tool_group has subsequent assistant
    expect(entryClassMap.get(2)).toBe("final");
    expect(entryTurnStartMap.get(1)).toBe(0);
    expect(entryTurnStartMap.get(2)).toBe(0);
  });

  it("keeps the active streaming assistant as intermediate (no TurnActionBar)", () => {
    const entries: ChatEntry[] = [userEntry("q"), assistant("partial")];
    const { entryClassMap, finalTurnStartMap } = classifyTurnEntries(entries, true);
    expect(entryClassMap.get(1)).toBe("intermediate");
    expect(finalTurnStartMap.has(1)).toBe(false);
  });

  it("assigns each entry to its owning turn-start across multiple turns", () => {
    const entries: ChatEntry[] = [userEntry("q1"), assistant("a1"), userEntry("q2"), assistant("a2")];
    const { lastTurnStartIdx, entryTurnStartMap, entryClassMap } = classifyTurnEntries(entries, false);
    expect(lastTurnStartIdx).toBe(2);
    expect(entryTurnStartMap.get(1)).toBe(0);
    expect(entryTurnStartMap.get(3)).toBe(2);
    expect(entryClassMap.get(1)).toBe("final");
    expect(entryClassMap.get(3)).toBe("final");
  });
});

describe("approvalTriggerMessage", () => {
  const imported: ChatEntry = { kind: "imported_trigger", sessionId: "s", source: "plugin", prompt: "p", summary: "sum",
    toolCallCount: 0, importedAt: "2026-01-01" };

  it("names the message that started the request's turn, not guidance that arrived after the request", () => {
    expect(approvalTriggerMessage([
      { kind: "user", text: "restored first" },
      assistant("done"),
      { kind: "user", text: "RUNSB:\n Remove-Item", createdAt: 100 },
      { kind: "user", text: "late guidance", injectHint: "queue", createdAt: 300 },
      { kind: "user", text: "late report", injectHint: "sub-agent", createdAt: 300 },
    ], 200)).toBe("RUNSB: Remove-Item");
  });

  it("names guidance that reached the turn before the request", () => {
    expect(approvalTriggerMessage([
      { kind: "user", text: "first", createdAt: 100 },
      { kind: "user", text: "also delete the logs", injectHint: "queue", createdAt: 150 },
    ], 200)).toBe("also delete the logs");
  });

  it("names no message when an imported prompt or a sub-agent report started the turn", () => {
    expect(approvalTriggerMessage([{ kind: "user", text: "B", createdAt: 100 }, assistant("a"), imported], 200)).toBeUndefined();
    expect(approvalTriggerMessage([{ kind: "user", text: "B", createdAt: 100 }, assistant("a"),
      { kind: "user", text: "report", injectHint: "sub-agent", createdAt: 150 }], 200)).toBeUndefined();
    expect(approvalTriggerMessage([assistant("hi")], 200)).toBeUndefined();
  });

  it("passes a resume row to the interrupted turn's own message", () => {
    expect(approvalTriggerMessage([
      { kind: "user", text: "RUNSB: Remove-Item -Recurse ./scratch", createdAt: 100 },
      assistant("partial", { interrupted: true }),
      { kind: "user", text: "Continue", resumesInterruptedTurn: true, createdAt: 150 },
    ], 200)).toBe("RUNSB: Remove-Item -Recurse ./scratch");
  });

  it("names a host-submitted turn whose row the renderer stamped after the request", () => {
    expect(approvalTriggerMessage([
      { kind: "user", text: "B", createdAt: 100 },
      assistant("a"),
      { kind: "user", text: "remote C", origin: "remote-control", createdAt: 300 },
    ], 200)).toBe("remote C");
  });

  it("does not name an interrupt send that drained after the request", () => {
    expect(approvalTriggerMessage([
      { kind: "user", text: "B", createdAt: 100 },
      assistant("a"),
      { kind: "user", text: "send now", injectHint: "interrupt", createdAt: 300 },
    ], 200)).toBe("B");
  });

  it("cuts a long message by code points", () => {
    expect(approvalTriggerMessage([{ kind: "user", text: `${"a".repeat(79)}😀 tail` }], 200)).toBe(`${"a".repeat(79)}😀`);
  });
});
