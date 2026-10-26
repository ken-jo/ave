import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import type { ConversationLoopDeps } from "../../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../../llm/types.js";

export class ScriptedTurnProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

export function makeBasicConversationLoopDeps(
  overrides: Record<string, unknown> = {},
): ConversationLoopDeps {
  return {
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    ...overrides,
  } as unknown as ConversationLoopDeps;
}
