/** Keep pure schema conversion independent of transport so unit tests need not load the client.
 * Treat external tools as untrusted network operations; register every tool for permission and audit gates, then restrict model exposure separately. */
import { createDynamicTool, type Tool } from "../tools/base.js";
import {
  FAIL_CLOSED_SURFACE,
  parseToolSurfaces,
  type ToolSurface,
} from "../plugins/runtime/tool-visibility.js";
import type { McpToolCallOutput, McpToolSchema } from "./types.js";
import { prepareMcpContentImage } from "./mcp-tool-content.js";
import { createMcpToolApprovalScope, mcpToolApprovalCacheKey, isMcpToolApprovalScope } from "../shared/mcp-tool-approval.js";
import { authorizedApprovalMemoryScope } from "../tools/approval-memory-context.js";
import { errorMessage } from "../shared/error-message.js";

/** MCP Apps spec default when a server declares no `_meta.ui.visibility`: `["model","app"]`; visible to the agent AND callable by the server's own app. */
const SPEC_DEFAULT_VISIBILITY: readonly ToolSurface[] = ["model", "app"];

/** Derive app and model surfaces once: absent declarations use protocol defaults, malformed declarations use the shared minimal governed surface.
 * App visibility never replaces host risk and consent gates. */
function toolSurfaces(schema: McpToolSchema): readonly ToolSurface[] {
  const declared = schema._meta?.ui?.visibility;
  if (declared === undefined) return SPEC_DEFAULT_VISIBILITY;
  return parseToolSurfaces(declared) ?? FAIL_CLOSED_SURFACE;
}

/** Preserve server identity for governance and kill-switch removal; invoke the original tool name behind its registry namespace.
 * Return text, declared UI, and images, with the first image exposed to the model. */
export function mcpToolToTool(
  serverId: string,
  namespacedName: string,
  schema: McpToolSchema,
  callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolCallOutput>,
): Tool {
  const remoteToolName = schema.name;
  const approvalScope = createMcpToolApprovalScope(serverId, remoteToolName);
  const surfaces = toolSurfaces(schema);
  const readOnlyHint = schema.annotations?.readOnlyHint;
  const destructiveHint = schema.annotations?.destructiveHint;
  // Discovery is an untrusted wire boundary even when its static type is known.
  const hasValidHints = (readOnlyHint === undefined || typeof readOnlyHint === "boolean")
    && (destructiveHint === undefined || typeof destructiveHint === "boolean");
  return createDynamicTool({
    name: namespacedName,
    description: schema.description,
    source: "mcp",
    // Host-derived default-strict for foreign MCP peers; see file header.
    category: "network",
    mcpServerId: serverId,
    approvalCacheKey: () => mcpToolApprovalCacheKey(approvalScope),
    approvalMemoryScope: () => approvalScope,
    mcpReadOnlyHint: hasValidHints && readOnlyHint === true,
    mcpRuleIdentity: {
      tool: remoteToolName,
      nonDestructive: hasValidHints && destructiveHint !== true
        && (readOnlyHint === true || destructiveHint === false),
    },
    // MCP Apps `_meta.ui.visibility` ∋ "app"; the spec's gate on this server's OWN app calling this tool (`oncalltool`). Materialized here, once.
    appInvokable: surfaces.includes("app"),
    // …and ∋ "model"; the spec's OTHER half. The tool is registered either way (an app-only tool must run under the same host gate as any
    // other, which requires a registry `Tool`); this bit is what keeps an app-only tool out of the list handed to the LLM. Registered ≠ exposed.
    modelVisible: surfaces.includes("model"),
    jsonSchema: {
      type: "object",
      properties: schema.inputSchema.properties,
      required: schema.inputSchema.required,
    },
    execute: async (rawInput, ctx) => {
      const args = (rawInput ?? {}) as Record<string, unknown>;
      try {
        const authorizedScope = authorizedApprovalMemoryScope(ctx);
        if (authorizedScope !== undefined && (!isMcpToolApprovalScope(authorizedScope) || authorizedScope.serverId !== serverId || authorizedScope.toolName !== remoteToolName)) {
          throw new Error("Tool approval scope does not match the execution target");
        }
        const { text, uiPayload, images } = await callTool(remoteToolName, args);
        const { image, note } = await prepareMcpContentImage(images ?? [], ctx?.abortSignal);
        return {
          output: note ? `${text}\n${note}` : text,
          isError: false,
          ...(uiPayload && { metadata: { uiPayload } }),
          ...(image && { image }),
        };
      } catch (err) {
        return {
          output: errorMessage(err),
          isError: true,
        };
      }
    },
  });
}
