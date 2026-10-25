/** Restore the persisted interrupted flag after reload; there is no live abort event to reconstruct it. */
import { describe, expect, it } from "vitest";
import { historyToEntries, type PersistedHistoryMessage } from "../history.js";
import { finalizeStreamingAssistant, type ChatEntry } from "../../../../lib/chat-stream-state.js";

function assistantOf(entries: ChatEntry[]): Extract<ChatEntry, { kind: "assistant" }> {
  const found = entries.find((e) => e.kind === "assistant");
  if (!found || found.kind !== "assistant") throw new Error("no assistant entry");
  return found;
}

describe("interrupted marker through reload", () => {
  it("carries the persisted flag onto the replayed assistant entry", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "긴 작업 시작" },
      { index: 1, role: "assistant", content: "작업 중이었습니다", interrupted: true },
    ];

    expect(assistantOf(historyToEntries(messages)).interrupted).toBe(true);
  });

  it("leaves an uninterrupted turn unmarked", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "짧은 질문" },
      { index: 1, role: "assistant", content: "답변입니다" },
    ];

    expect(assistantOf(historyToEntries(messages)).interrupted).toBeUndefined();
  });

  it("keeps a live-marked entry marked when finalize runs without the option", () => {
    // An abort is a fact about the turn, not about the render: a later re-finalize (the live path finalizes after the abort
    // stamp) must not quietly clear the badge.
    const entries: ChatEntry[] = [
      { kind: "assistant", text: "부분 응답", streaming: true, interrupted: true },
    ];

    const next = finalizeStreamingAssistant(entries, "부분 응답");

    expect(assistantOf(next).interrupted).toBe(true);
    expect(assistantOf(next).streaming).toBe(false);
  });
});
