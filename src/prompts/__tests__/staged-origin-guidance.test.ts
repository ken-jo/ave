/**
 * Staged-origin guidance, carried in the turn context of the staged turn.
 *
 * Emits a "second-guess this trigger before acting" instruction *only*
 * when the per-turn origin source starts with `overlay:`. Default
 * (user-initiated) turns must NOT see this section.
 *
 * The query loop passes the round's staged origin to `buildTurnContext`, so a
 * later user turn is unaffected and the system prompt never changes for it.
 *
 * ONE source builds the block for every staged origin by resolving the
 * staged-origin table, so these cases also pin that a registered origin gets
 * its own tag and text — a staged origin with a permission gate but no
 * model-facing warning is the failure this guards.
 */
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
    // Defensive: if a future surface ever lands a non-overlay trigger,
    // it should NOT inadvertently inherit the guidance section.
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
    // The body is server-authored: the guidance must name the fence it is
    // talking about, in every locale, so the model can tell body from policy.
    expect(prompt).toContain("<mcp-prompt>");
    expect(prompt).not.toContain("app-message-origin-guidance");
  });

  it("emits nothing for an unregistered source namespace", () => {
    const builder = makeSystemPromptBuilder();
    const prompt = builder.buildTurnContext("", "mcp-prompt-bogus:hr");
    expect(prompt).not.toContain("origin-guidance");
  });
});
