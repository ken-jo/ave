import { describe, expect, it } from "vitest";
import { approvalTriggerMessage, resolveConversationTitle } from "../conversation-title.js";
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

describe("approvalTriggerMessage", () => {
  it("names the last message the user sent before the request, not one sent after it", () => {
    expect(approvalTriggerMessage([
      { kind: "user", text: "restored first", },
      { kind: "assistant", text: "done" },
      { kind: "user", text: "RUNSB:\n Remove-Item", createdAt: 100 },
      { kind: "user", text: "sub-agent report", injectHint: "sub-agent", createdAt: 150 },
      { kind: "user", text: "sent later", createdAt: 300 },
    ], 200)).toBe("RUNSB: Remove-Item");
  });

  it("is undefined when the transcript holds no user message for the request", () => {
    expect(approvalTriggerMessage([{ kind: "assistant", text: "hi" }], 200)).toBeUndefined();
    expect(approvalTriggerMessage([{ kind: "user", text: "later", createdAt: 300 }], 200)).toBeUndefined();
  });
});
