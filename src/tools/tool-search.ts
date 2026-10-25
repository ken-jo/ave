import { createDynamicTool, type Tool } from "./base.js";
import { TOOL_SEARCH_TOOL_NAME } from "./registry.js";
import { t } from "../i18n/index.js";

// ConversationLoop intercepts this tool; direct execution must fail closed.
export function createToolSearchTool(): Tool {
  return createDynamicTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: t("be_tools.toolSearchDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: t("be_tools.toolSearchQueryDescription"),
        },
      },
    },
    execute: async () => ({
      output: t("be_tools.toolSearchLoopError"),
      isError: true,
    }),
  });
}
