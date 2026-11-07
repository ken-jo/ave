import { describe, expect, it } from "vitest";
import { resolveConversationTitle, truncateCodePoints } from "../conversation-title.js";
import { SUGGESTIONS_SESSION_ID } from "../suggestions-session.js";
import { formatAgentPluginTemplatePrompt } from "../agent-plugin-prompt.js";
import { formatStagedEnvelope, stagedOriginFor } from "../staged-origins.js";
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

  it("names a template prompt turn by its prompt name, never by its provenance envelope", () => {
    const content = formatAgentPluginTemplatePrompt({
      id: "extension:egress-probe:egress-probe", packageName: "egress-probe", version: "1.0.0",
      name: "egress-probe", description: "Probe egress", body: "TOOL: fetch {args}",
    }, "https://example.com");
    const title = resolveConversationTitle({ sessionId: "conversation-1", messages: [{ role: "user", content }] }, t);
    expect(title).toBe("egress-probe");
    expect(title).not.toContain("<plugin-prompt");
  });

  it("unwraps every other staged envelope to its body, and an unclosed header too", () => {
    const mcp = formatStagedEnvelope(stagedOriginFor("mcp-prompt-emitted"), "Review the\n deploy", "mcp-prompt:release-server");
    const app = formatStagedEnvelope(stagedOriginFor("app-emitted"), "Show the chart", "app:charts");
    const overlay = formatStagedEnvelope(stagedOriginFor("plugin-emitted"), "Check the inbox", "overlay:mail");
    const titleOf = (content: string) => resolveConversationTitle({ sessionId: "conversation-1", messages: [{ role: "user", content }] }, t);
    expect(titleOf(mcp)).toBe("Review the deploy");
    expect(titleOf(app)).toBe("Show the chart");
    expect(titleOf(overlay)).toBe("Check the inbox");
    expect(titleOf('<mcp-prompt source="mcp-prompt:release-server">\nCut the release')).toBe("Cut the release");
    expect(titleOf(formatStagedEnvelope(stagedOriginFor("mcp-prompt-emitted"), "", "mcp-prompt:release-server")))
      .toBe(t("trustOriginLabel.mcpPromptEmitted"));
  });

  it("leaves a user message that only looks like markup unchanged", () => {
    expect(resolveConversationTitle({
      sessionId: "conversation-1",
      messages: [{ role: "user", content: '<plugin-prompt source="not a source"> keep me' }],
    }, t)).toBe('<plugin-prompt source="not a source"> keep me');
  });

  it("keeps an explicit title and names the reserved conversation from the current catalog", () => {
    expect(resolveConversationTitle({ sessionId: "conversation-1", title: "긴 대화 이름".repeat(20) }, t))
      .toBe("긴 대화 이름".repeat(20));
    expect(resolveConversationTitle({ sessionId: SUGGESTIONS_SESSION_ID, title: "Stored name" }, t))
      .toBe(t("suggestionsSession.title"));
  });
});

describe("truncateCodePoints", () => {
  it("never splits an emoji at the title boundary", () => {
    const title = resolveConversationTitle({
      sessionId: "conversation-1",
      messages: [{ role: "user", content: `${"a".repeat(79)}😀 tail` }],
    }, t);
    expect(title).toBe(`${"a".repeat(79)}😀`);
    expect(truncateCodePoints("😀😀", 1)).toBe("😀");
    expect(truncateCodePoints("short", 80)).toBe("short");
  });
});
