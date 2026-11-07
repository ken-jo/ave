// A routine turn ends its answer with <summary>…</summary> for the result card. The card keeps it; the conversation the turn ran in
// (a connected chat, or the routine's own) stores and shows the answer without the tag.
import { describe, expect, it } from "vitest";
import { createRoutineConversationLoop } from "../conversation.js";
import type { LLMProvider, StreamEvent } from "../../engine/llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { makeConversationLoopMemoryManager } from "../../engine/__tests__/conversation-loop-test-helpers.js";
import { makeSystemPromptBuilder } from "../../prompts/__tests__/test-helpers.js";
import { RoutineEngine } from "../../routines/routine-engine.js";

class SummaryProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "The build is green.\n\n<summary>build " };
    yield { type: "text_delta", text: "green</summary>" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

describe("routine summary tag", () => {
  it("reaches the result card but not the conversation's stored answer", async () => {
    const memoryManager = makeConversationLoopMemoryManager();
    const loop = createRoutineConversationLoop({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      toolRegistry: new ToolRegistry(),
      memoryManager,
      systemPromptBuilder: makeSystemPromptBuilder(),
      pluginRuntime: { listPluginIds: () => [], isPluginEnabled: () => true, listPluginCards: () => [] },
    } as unknown as Parameters<typeof createRoutineConversationLoop>[0]);
    (loop as unknown as { provider: LLMProvider | null }).provider = new SummaryProvider();
    const engine = new RoutineEngine({ createConversationLoop: () => loop });
    const result = await engine.runRoutine({ id: "build", trigger: "schedule", prePrompt: "check the build" });
    expect(result.summary).toBe("build green");
    const answers = loop.getHistory().getMessages().filter((m) => m.role === "assistant").map((m) => m.content);
    expect(answers).toEqual(["The build is green."]);
    // The transcript written to disk is the same history: no save carries the tag.
    const saved = (memoryManager.sessions.saveSession as unknown as { mock: { calls: Array<[string, unknown[]]> } }).mock.calls;
    expect(saved.length).toBeGreaterThan(0);
    expect(JSON.stringify(saved)).not.toContain("<summary>");
  });
});
