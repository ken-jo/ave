// Parent guidance has separate addressing and suspension semantics from child-to-parent or sibling messaging.
import { createDynamicTool, type Tool } from "./base.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import { PARENT_DIRECTIVE_MAX_CHARS } from "../engine/parent-directive.js";
import { t } from "../i18n/index.js";

interface AgentGuideToolDeps {
  getRunner: () => SubAgentRunner | undefined;
}

function resultError(reason: string, extra?: Record<string, string>): {
  output: string;
  isError: true;
} {
  return {
    output: JSON.stringify({ error: reason, ...(extra ?? {}) }),
    isError: true,
  };
}

export function createAgentGuideTool(deps: AgentGuideToolDeps): Tool {
  return createDynamicTool({
    name: "agent_guide",
    description: "Send a directive to a sub-agent YOU started — change its direction or tell it to stop. A running sub-agent receives it at its next round boundary; a suspended one receives it when you resume it with agent_spawn(resumeId).",
    source: "builtin",
    category: "meta",
    // Host-checked ownership bounds recipients; recipient actions still traverse their own permission gates.
    decisionOverride: "always-allow-with-audit",
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["childSessionId", "message"],
      properties: {
        childSessionId: {
          type: "string",
          description: "childSessionId of a sub-agent this conversation started (see agent_status or agent_list). Agent names are not addresses.",
        },
        message: {
          type: "string",
          maxLength: PARENT_DIRECTIVE_MAX_CHARS,
          description: "The directive, in your own words. It reaches the sub-agent labelled as coming from you.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      // Children cannot have children, even if this tool leaks past registry filtering.
      const depth = typeof ctx.metadata?.spawnDepth === "number"
        ? ctx.metadata.spawnDepth
        : 0;
      if (depth >= 1) {
        return resultError("agent_guide cannot be invoked from a sub-agent");
      }
      const runner = deps.getRunner();
      if (!runner) return resultError("agent_guide runner not configured");
      const originSessionId = typeof ctx.metadata?.sessionId === "string"
        ? ctx.metadata.sessionId
        : "";
      if (!originSessionId) return resultError("agent_guide requires a session id");

      const input = (rawInput ?? {}) as Record<string, unknown>;
      if (!Object.keys(input).every((key) => ["childSessionId", "message"].includes(key))) {
        return resultError("invalid-message");
      }
      const childSessionId = typeof input.childSessionId === "string"
        ? input.childSessionId.trim()
        : "";
      const message = typeof input.message === "string" ? input.message : "";
      if (!childSessionId) return resultError("unknown-recipient");
      if (message.trim().length === 0) return resultError("invalid-message");

      const delivered = await runner.queueParentMessageToChild(
        originSessionId,
        childSessionId,
        message,
      );
      if (!delivered.ok) {
        // Name the child's actual refusal state so permanent failures cannot invite retries.
        return resultError(
          delivered.reason,
          delivered.reason === "child-not-resumable"
            ? { guidance: t("be_parentDirective.notResumableGuidance") }
            : undefined,
        );
      }
      return {
        output: JSON.stringify({
          childSessionId: delivered.childSessionId,
          messageId: delivered.messageId,
          disposition: delivered.disposition,
          ...(delivered.disposition === "mailbox"
            ? { guidance: t("be_parentDirective.queuedForResumeGuidance") }
            : {}),
        }),
        isError: false,
      };
    },
  });
}
