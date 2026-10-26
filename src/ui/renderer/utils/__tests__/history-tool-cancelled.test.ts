/** User-aborted tools remain cancelled after reload and must not mark their group as failed. */
import { describe, expect, it } from "vitest";
import { historyToEntries, type PersistedHistoryMessage } from "../history.js";
import { applyToolStart, applyToolEnd, type ChatEntry, type ToolEntryItem } from "../../../../lib/chat-stream-state.js";

function toolsOf(entries: ChatEntry[]): ToolEntryItem[] {
  const group = entries.find((e) => e.kind === "tool_group");
  if (!group || group.kind !== "tool_group") throw new Error("no tool_group entry");
  return group.tools;
}

const GROUP = "g1";

function started(toolUseId: string): ChatEntry[] {
  return applyToolStart([], { groupId: GROUP, toolUseId, name: "bash", displayOrder: 0 });
}

function failedToolHistory(userContent: string, result: string, overrides: Partial<PersistedHistoryMessage> = {}): PersistedHistoryMessage[] {
  return [
    { index: 0, role: "user", content: userContent },
    { index: 1, role: "assistant", content: "", toolCalls: [{ id: "t1", name: "bash", input: {} }] },
    { index: 2, role: "tool_result", toolUseId: "t1", toolName: "bash", content: result, isError: true, ...overrides },
  ];
}

describe("cancelled tool calls", () => {
  it("marks a stopped call cancelled rather than error (live)", () => {
    const entries = applyToolEnd(started("t1"), {
      groupId: GROUP,
      toolUseId: "t1",
      result: "도구 실행이 취소되었습니다.",
      // The wire flag stays true — the model must know no usable result came back, and tool-result schemas have no third state.
      isError: true,
      cancelled: true,
    });

    expect(toolsOf(entries)[0]?.status).toBe("cancelled");
  });

  it("still marks a genuine failure as error", () => {
    const entries = applyToolEnd(started("t1"), {
      groupId: GROUP,
      toolUseId: "t1",
      result: "command not found",
      isError: true,
    });

    expect(toolsOf(entries)[0]?.status).toBe("error");
  });

  it("keeps a cancelled call out of the group's error roll-up", () => {
    // This is the visible symptom: one stopped call turned the entire group destructive. `hasError` filters on status ===
    // "error", so a distinct status excludes it without that call site needing to change.
    let entries = applyToolStart([], { groupId: GROUP, toolUseId: "t1", name: "bash", displayOrder: 0 });
    entries = applyToolStart(entries, { groupId: GROUP, toolUseId: "t2", name: "read_file", displayOrder: 1 });
    entries = applyToolEnd(entries, { groupId: GROUP, toolUseId: "t1", result: "ok", isError: false });
    entries = applyToolEnd(entries, {
      groupId: GROUP,
      toolUseId: "t2",
      result: "도구 실행이 취소되었습니다.",
      isError: true,
      cancelled: true,
    });

    expect(toolsOf(entries).some((t) => t.status === "error")).toBe(false);
  });

  it("carries the persisted flag onto the replayed tool row", () => {
    // On reload there is no stream event; `toolDisplay.cancelled` is the only witness that the halt was deliberate.
    const messages: PersistedHistoryMessage[] = failedToolHistory("긴 작업 시작", "도구 실행이 취소되었습니다.", { toolDisplay: { cancelled: true } });

    expect(toolsOf(historyToEntries(messages))[0]?.status).toBe("cancelled");
  });

  it("replays a real failure as error after reload", () => {
    const messages: PersistedHistoryMessage[] = failedToolHistory("실패하는 작업", "command not found");

    expect(toolsOf(historyToEntries(messages))[0]?.status).toBe("error");
  });
});
