import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import {
  IDLE_PROMPT_HISTORY,
  PROMPT_HISTORY_LIMIT,
  collectPromptHistory,
  stepPromptHistory,
} from "../prompt-history.js";

const user = (text: string, extra: Partial<Extract<ChatEntry, { kind: "user" }>> = {}): ChatEntry => ({
  kind: "user",
  text,
  ...extra,
});
const caretAt = (n: number) => ({ start: n, end: n });

describe("collectPromptHistory", () => {
  it("keeps only prompts the user typed here, oldest first, without markers or repeats", () => {
    const entries: ChatEntry[] = [
      user("first"),
      { kind: "assistant", text: "reply" } as ChatEntry,
      user("from slack", { origin: "chat-bridge" }),
      user("child report", { injectHint: "sub-agent" }),
      user("look [Image #1] here"),
      user("look here"),
      user("   "),
      user("last"),
    ];
    expect(collectPromptHistory(entries)).toEqual(["first", "look here", "last"]);
  });

  it("caps the history at the newest PROMPT_HISTORY_LIMIT prompts", () => {
    const entries = Array.from({ length: PROMPT_HISTORY_LIMIT + 5 }, (_, i) => user(`p${i}`));
    const history = collectPromptHistory(entries);
    expect(history).toHaveLength(PROMPT_HISTORY_LIMIT);
    expect(history[history.length - 1]).toBe(`p${PROMPT_HISTORY_LIMIT + 4}`);
  });
});

describe("stepPromptHistory", () => {
  const history = ["one", "two\nlines", "three"];

  it("walks back from an empty composer and forward to the stashed draft", () => {
    const up1 = stepPromptHistory(history, IDLE_PROMPT_HISTORY, -1, "", caretAt(0));
    expect(up1?.text).toBe("three");
    const up2 = stepPromptHistory(history, up1!.cursor, -1, "three", caretAt(0));
    expect(up2?.text).toBe("two\nlines");
    const down = stepPromptHistory(history, up2!.cursor, 1, "two\nlines", caretAt(10));
    expect(down?.text).toBe("three");
    const back = stepPromptHistory(history, down!.cursor, 1, "three", caretAt(5));
    expect(back).toEqual({ cursor: IDLE_PROMPT_HISTORY, text: "" });
  });

  it("never overwrites typed text that is not a recalled entry", () => {
    expect(stepPromptHistory(history, IDLE_PROMPT_HISTORY, -1, "draft", caretAt(0))).toBeNull();
    const up = stepPromptHistory(history, IDLE_PROMPT_HISTORY, -1, "", caretAt(0));
    // The user edited the recalled text: arrows are caret movement again.
    expect(stepPromptHistory(history, up!.cursor, -1, "three!", caretAt(0))).toBeNull();
    expect(stepPromptHistory(history, up!.cursor, 1, "three!", caretAt(6))).toBeNull();
  });

  it("leaves Up/Down to the caret inside a multi-line recalled entry", () => {
    const cursor = { index: 1, draft: "" };
    // caret on the second line: Up moves the caret, not the history
    expect(stepPromptHistory(history, cursor, -1, "two\nlines", caretAt(6))).toBeNull();
    // caret on the first line: Down moves the caret
    expect(stepPromptHistory(history, cursor, 1, "two\nlines", caretAt(1))).toBeNull();
  });

  it("stops at the oldest entry and ignores Down when not walking or with a selection", () => {
    expect(stepPromptHistory(history, { index: 0, draft: "" }, -1, "one", caretAt(0))).toBeNull();
    expect(stepPromptHistory(history, IDLE_PROMPT_HISTORY, 1, "", caretAt(0))).toBeNull();
    expect(stepPromptHistory(history, IDLE_PROMPT_HISTORY, -1, "", { start: 0, end: 1 })).toBeNull();
  });
});
