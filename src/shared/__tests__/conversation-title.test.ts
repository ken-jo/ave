import { describe, expect, it } from "vitest";
import { resolveConversationTitle } from "../conversation-title.js";
import { SUGGESTIONS_SESSION_ID } from "../suggestions-session.js";
import { t } from "../../i18n/runtime.js";

describe("resolveConversationTitle", () => {
  it("names an untitled conversation from its user message using the list rule", () => {
    expect(resolveConversationTitle({
      sessionId: "conversation-1",
      messages: [{ role: "user", content: "그래 두개\n 진행해보자" }],
    }, t)).toBe("그래 두개 진행해보자");
  });

  it("preserves the list's most recent user title while ignoring host resume instructions", () => {
    const title = "최근 질문 ".repeat(30);
    expect(resolveConversationTitle({
      sessionId: "conversation-1",
      messages: [
        { role: "user", content: "첫 질문" },
        { role: "user", content: title },
        { role: "assistant", content: "답변" },
        { role: "user", content: "Host resume instruction", meta: { resumesInterruptedTurn: true } },
      ],
    }, t)).toBe(title.trim().slice(0, 80));
  });

  it("keeps an explicit title and names the reserved conversation from the current catalog", () => {
    expect(resolveConversationTitle({ sessionId: "conversation-1", title: "긴 대화 이름".repeat(20) }, t))
      .toBe("긴 대화 이름".repeat(20));
    expect(resolveConversationTitle({ sessionId: SUGGESTIONS_SESSION_ID, title: "Stored name" }, t))
      .toBe(t("suggestionsSession.title"));
  });
});
