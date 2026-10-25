// Bundled resources are untrusted tool data, never executed or added to trusted prompts; require prior approved load in this conversation.
// Read frozen verified plugin bytes or realpath-contained user files, refuse flat-skill sibling access, and reject generation drift.
import { t } from "../i18n/index.js";
import { createDynamicTool, type Tool } from "./base.js";
import type { SkillStore } from "../main/skill-store.js";
import { SKILL_SELECTOR_ALLOWLIST } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { parseAgentPluginSkillSelector } from "../shared/plugin-skill-selector.js";
const log = createLogger("ave");

export interface SkillReadToolDeps {
  store: SkillStore;
  // Conversation-local approved-load registry is the access boundary.
  overlay: SkillOverlay;
  /** Generation lease for plugin-owned skills; absent ⇒ plugin reads refuse. */
  acquirePluginGeneration?: (
    owner: { pluginId: string; localId: string },
  ) => Promise<{
    generation: import("../plugins/plugin-generation-coordinator.js").ActivePluginGeneration;
    release(): void;
  }>;
}

function errorResult(message: string): { output: string; isError: true } {
  return { output: JSON.stringify({ error: message }), isError: true };
}

export function createSkillReadTool(deps: SkillReadToolDeps): Tool {
  return createDynamicTool({
    name: "skill_read",
    description: t("be_skillRead.toolDescription"),
    source: "builtin",
    // Prior approved loading authorizes the resource read; no file or trusted-prompt mutation occurs.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["skillName", "resourcePath"],
      properties: {
        skillName: {
          type: "string",
          description: t("be_skillRead.skillNameDescription"),
        },
        resourcePath: {
          type: "string",
          description: t("be_skillRead.resourcePathDescription"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const skillName = typeof a.skillName === "string" ? a.skillName.trim() : "";
      const resourcePath = typeof a.resourcePath === "string" ? a.resourcePath.trim() : "";
      if (!skillName || !resourcePath) {
        return errorResult("skillName and resourcePath are required");
      }
      if (!SKILL_SELECTOR_ALLOWLIST.test(skillName)) {
        return errorResult(`invalid skillName: must match ${SKILL_SELECTOR_ALLOWLIST.source}`);
      }
      const sessionId =
        typeof ctx.metadata?.sessionId === "string" && ctx.metadata.sessionId
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!sessionId) {
        return errorResult("skill_read: missing sessionId in tool execution context");
      }

      // Only this conversation's approved-load registry grants access.
      const entry = deps.overlay.list(sessionId).find((candidate) => candidate.name === skillName);
      if (!entry) {
        // Restarts clear the read registry; reload to restore it using content-bound approval.
        return errorResult(
          `skill not read in this conversation session: call skill_load({ skillName: "${skillName}" }) first`,
        );
      }
      // The load-time manifest is the authorized set; display clipping can show fewer entries but can never authorize more.
      if (!entry.resources.some((resource) => resource.path === resourcePath)) {
        return errorResult(`resource not listed for ${skillName}: ${resourcePath}`);
      }

      const selectorMatch = /^plugin:([^:]+):([^:]+)$/.exec(skillName);
      try {
        if (parseAgentPluginSkillSelector(skillName)) {
          if (!entry.agentPluginOwner) return errorResult("skill package identity is missing");
          const resource = deps.store.readAgentPluginResource(skillName, entry.agentPluginOwner, resourcePath);
          if (!resource) return errorResult(`resource not found: ${resourcePath}`);
          return { output: JSON.stringify({ skillName, ...resource }), isError: false };
        }
        if (selectorMatch) {
          if (!deps.acquirePluginGeneration) {
            return errorResult("skill_read: plugin generation access unavailable");
          }
          const lease = await deps.acquirePluginGeneration({
            pluginId: selectorMatch[1],
            localId: selectorMatch[2],
          });
          try {
            // Reject generations that differ from the approved overlay identity.
            const owner = entry.pluginOwner;
            // Missing plugin owner means no approved generation and must fail closed.
            if (
              !owner ||
              lease.generation.generationId !== owner.generationId ||
              lease.generation.pluginVersion !== owner.pluginVersion
            ) {
              return errorResult("skill generation changed since load; call skill_load again");
            }
            const resource = deps.store.readPluginResource(
              lease.generation,
              skillName,
              resourcePath,
            );
            if (!resource) return errorResult(`resource not found: ${resourcePath}`);
            return {
              output: JSON.stringify({ skillName, ...resource }),
              isError: false,
            };
          } finally {
            lease.release();
          }
        }

        // Read the approved identity, never a fresh name lookup that could follow file swaps or ambiguous siblings.
        const resource = await deps.store.readUserResource(
          { filePath: entry.filePath, pluginOwner: entry.pluginOwner },
          resourcePath,
        );
        return {
          output: JSON.stringify({ skillName, ...resource }),
          isError: false,
        };
      } catch (err) {
        const message = errorMessage(err);
        log.warn(`skill_read rejected ${skillName}/${resourcePath}: %s`, message);
        return errorResult(message);
      }
    },
  });
}
