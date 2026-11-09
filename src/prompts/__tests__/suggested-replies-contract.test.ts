import { describe, it, expect } from "vitest";
import { SUGGESTED_REPLIES_OPEN, SUGGESTED_REPLIES_CLOSE } from "../../engine/suggested-replies.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";
import { makePromptMemorySource } from "./test-helpers.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";

function buildMinimalPrompt(): string {
  const builder = new SystemPromptBuilder({
    memoryManager: makePromptMemorySource(),
    toolRegistry: new ToolRegistry(),
    getPluginCards: () => [],
  });
  return builder.build();
}

describe("system prompt — suggested replies contract", () => {
  it("includes the Suggested Replies instruction section", () => {
    const prompt = buildMinimalPrompt();
    expect(prompt).toContain("## Suggested Replies");
  });

  it("includes the exact open/close tags so parser/filter stays in sync", () => {
    const prompt = buildMinimalPrompt();
    expect(prompt).toContain(SUGGESTED_REPLIES_OPEN);
    expect(prompt).toContain(SUGGESTED_REPLIES_CLOSE);
  });

  it("instructs the model to omit the block when no follow-up is natural", () => {
    const prompt = buildMinimalPrompt();
    // Preserve explicit permission to omit suggestions rather than padding every turn.
    expect(prompt).toMatch(/생략한다/);
  });

  it("asks for exactly one candidate and keeps the #980 command-prefix policy explicit", () => {
    // Request one suggestion because the composer discards all other candidates.
    const prompt = buildMinimalPrompt();
    expect(prompt).toContain("정확히 1개");
    expect(prompt).not.toContain("최대 5개");
    expect(prompt).toContain("완결 답변");
    expect(prompt).toContain("/clear 포함");
    expect(prompt).toContain("단일 토큰 command 도 금지");
  });

  it.each([["en", en], ["ko", ko]] as const)("describes the %s reply line without a copyable placeholder", (_locale, catalog) => {
    const instruction = catalog["be_systemPromptBuilder.suggestedRepliesInstruction"];
    expect(instruction).toContain(SUGGESTED_REPLIES_OPEN);
    expect(instruction).toContain(SUGGESTED_REPLIES_CLOSE);
    expect(instruction).toContain("'- '");
    expect(instruction).not.toContain("{text}");
    expect(instruction).not.toMatch(/<suggested_replies>\s*\n- /);
  });
});
