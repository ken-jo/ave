import { createDynamicTool, type Tool } from "./base.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import { isResumableSubAgentTaskState } from "../engine/subagent-runner.js";
import { t } from "../i18n/index.js";

export interface AgentListToolDeps {
  store: AgentProfileStore;
  /** Same accessor agent_spawn uses; absent on surfaces without a runner. */
  getRunner?: () => SubAgentRunner | undefined;
}

export function createAgentListTool(deps: AgentListToolDeps): Tool {
  return createDynamicTool({
    name: "agent_list",
    description: t("be_agentList.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async (_rawInput, ctx) => {
      const agents = (await deps.store.list()).map((agent) => ({
        name: agent.name,
        description: agent.description,
        sourceTools: agent.sourceTools,
        triggers: agent.triggers,
        model: agent.model,
        mode: agent.mode,
      }));

      // Include this conversation's persisted children so continuation preserves their context.
      const originSessionId = typeof ctx.metadata?.sessionId === "string"
        ? ctx.metadata.sessionId
        : "";
      const runner = deps.getRunner?.();
      const persisted = originSessionId && runner
        ? runner.listPersistedSpawnsForOrigin(originSessionId)
        : [];
      const existingSubAgents = persisted.map((entry) => ({
        title: entry.title,
        resumeId: entry.childSessionId,
        taskState: entry.taskState ?? "unrecorded",
        // Advertise resume only for INPUT_REQUIRED children with remaining resume budget; other listed states cannot resume.
        resumable: isResumableSubAgentTaskState(entry.taskState)
          && !runner?.isResumeExhausted(entry.childSessionId),
      }));

      return {
        output: JSON.stringify({
          agents,
          ...(existingSubAgents.length > 0
            ? {
                existingSubAgents,
                existingSubAgentsGuidance: t("be_agentList.existingGuidance"),
              }
            : {}),
        }),
        isError: false,
      };
    },
  });
}
