import { vi } from "vitest";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import { ConversationLoop, type ConversationLoopDeps } from "../../conversation-loop.js";
import type { LLMProvider } from "../../llm/types.js";

export function makeSubagentLoopDeps(
  toolRegistry: ToolRegistry,
  overrides: Partial<ConversationLoopDeps> = {},
): ConversationLoopDeps {
  return {
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: () => undefined,
      setOriginSource: () => undefined,
      setActiveSessionId: () => undefined,
      // Child runs require a separate prompt builder rather than sharing parent state.
      createIsolated: () => ({
        build: () => "system",
        setToolScope: () => undefined,
        setOriginSource: () => undefined,
        setActiveSessionId: () => undefined,
      }),
    },
    toolRegistry,
    memoryManager: {
      saveSession: () => Promise.resolve(),
      listSessions: () => [],
    },
    ...overrides,
  } as unknown as ConversationLoopDeps;
}

export function patchLoopProvider(provider: LLMProvider) {
  const hasProviderSpy = vi
    .spyOn(ConversationLoop.prototype as unknown as { hasProvider: () => boolean }, "hasProvider")
    .mockReturnValue(true);
  const refreshProviderSpy = vi
    .spyOn(ConversationLoop.prototype as unknown as { refreshProvider: () => Promise<void> }, "refreshProvider")
    .mockImplementation(async function (this: ConversationLoop) {
      (this as { provider: LLMProvider | null }).provider = provider;
    });
  return { hasProviderSpy, refreshProviderSpy };
}
