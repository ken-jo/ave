import { createDynamicTool, type Tool } from "./base.js";
import { t } from "../i18n/index.js";

// ConversationLoop intercepts this tool; direct execution must fail closed.
export function createRequestPluginTool(): Tool {
  return createDynamicTool({
    name: "request_plugin",
    description: t("be_tools.requestPluginDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["pluginId"],
      properties: {
        pluginId: {
          type: "string",
          description: t("be_tools.requestPluginIdDescription"),
        },
      },
    },
    execute: async () => ({
      output: t("be_tools.requestPluginLoopError"),
      isError: true,
    }),
  });
}
