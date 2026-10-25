import { vi } from "vitest";

import type { PromptMemorySource } from "../../memory/memory-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";

export function makePromptMemorySource(
  overrides: Partial<PromptMemorySource> = {},
): PromptMemorySource {
  return {
    getAgentsMd: vi.fn(() => ""),
    getAgentsCustomMd: vi.fn(() => ""),
    getProjectAgentsMd: vi.fn((projectRoot: string) => ({ projectRoot, layers: [], totalBytes: 0, watchedPaths: [] })),
    getPromptUserPreferences: vi.fn(() => ""),
    getPromptMemoryIndex: vi.fn(() => ""),
    getPromptLongTermMemoryOverview: vi.fn(() => ""),
    selectRelevantMemories: vi.fn(() => ({ entries: [], context: "", usedTokens: 0 })),
    ...overrides,
  };
}

export function makeSystemPromptBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: makePromptMemorySource(),
    toolRegistry: new ToolRegistry(),
  });
}
