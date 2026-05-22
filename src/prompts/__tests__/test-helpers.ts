import { ToolRegistry } from "../../tools/registry.js";
import { SystemPromptBuilder } from "../system-prompt-builder.js";

export function makeSystemPromptBuilder(): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "",
      getAveMd: () => "",
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
  });
}
