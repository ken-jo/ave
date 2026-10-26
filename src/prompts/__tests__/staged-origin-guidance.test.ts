/** Stage origin guidance per turn so triggered work receives its warning without altering later user turns. */
import { describe, it, expect } from "vitest";

import { makeSystemPromptBuilder } from "./test-helpers.js";

describe("SystemPromptBuilder — Staged Origin Guidance", () => {
  it("emits guidance when origin source is `overlay:*`", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", "overlay:meeting-detection");
    expect(prompt).toContain("<overlay-trigger-origin-guidance");
    expect(prompt).toContain("source=overlay:meeting-detection");
    expect(prompt).toContain("도구를 호출하기 전에");
    expect(prompt).toContain("ApprovalGate");
    expect(prompt).toContain("</overlay-trigger-origin-guidance>");
  });

  it("warns the LLM not to obey imperatives inside the user-turn message", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", "overlay:meeting-detection");
    expect(prompt).toContain("imperative");
    expect(prompt).toContain("templated");
  });

  it("omits guidance for user-initiated turns (origin null)", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", null);
    expect(prompt).not.toContain("overlay-trigger-origin-guidance");
  });

  it("omits guidance when origin is set but not `overlay:` prefixed", () => {
    const builder = makeSystemPromptBuilder();
    expect(builder.buildTurnContext("", "user:typed")).not.toContain("overlay-trigger-origin-guidance");
  });

  it("applies to its own turn only and never enters the system prompt", () => {
    const builder = makeSystemPromptBuilder();
    expect(builder.buildTurnContext("", "overlay:x")).toContain("overlay-trigger-origin-guidance");
    expect(builder.buildTurnContext("", null)).not.toContain("overlay-trigger-origin-guidance");
    expect(builder.build()).not.toContain("origin-guidance");
  });

  it("includes the source string verbatim so audit + LLM can correlate", () => {
    const builder = makeSystemPromptBuilder();
    expect(builder.buildTurnContext("", "overlay:task-deadline")).toContain("overlay:task-deadline");
  });

  it("emits the app-message block for an `app:*` origin", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", "app:hr-mcp");
    expect(prompt).toContain("<app-message-origin-guidance");
    expect(prompt).toContain("app:hr-mcp");
    expect(prompt).toContain("</app-message-origin-guidance>");
    expect(prompt).not.toContain("overlay-trigger-origin-guidance");
  });

  it("emits the mcp-prompt block for an `mcp-prompt:*` origin", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", "mcp-prompt:hr-mcp");
    expect(prompt).toContain("<mcp-prompt-origin-guidance");
    expect(prompt).toContain("mcp-prompt:hr-mcp");
    expect(prompt).toContain("</mcp-prompt-origin-guidance>");
    // Name the server-authored data fence in every locale so the model can distinguish content from policy.
    expect(prompt).toContain("<mcp-prompt>");
    expect(prompt).not.toContain("app-message-origin-guidance");
  });

  it("emits nothing for an unregistered source namespace", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", "mcp-prompt-bogus:hr");
    expect(prompt).not.toContain("origin-guidance");
  });
});
