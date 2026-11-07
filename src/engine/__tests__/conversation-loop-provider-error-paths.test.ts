import { describe, expect, it } from "vitest";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class ThrowingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  constructor(private readonly err: Error) {}
  // eslint-disable-next-line require-yield
  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    throw this.err;
  }
}

function buildLoop(provider: LLMProvider | null): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings({ model: "gpt-5.4-mini" }),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    toolRegistry,
    memoryManager: { sessions: { saveSession: () => {}, listSessions: () => [] } },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("ConversationLoop.generateText provider throw", () => {
  it("propagates a streamTurn rejection to the caller", async () => {
    const loop = buildLoop(new ThrowingProvider(new Error("boom-generate")));
    await expect(loop.generateText("prompt")).rejects.toThrow("boom-generate");
  });
});
