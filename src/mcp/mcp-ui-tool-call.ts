/** Both card-call paths require app visibility and execute through host risk, approval and audit gates.
 * Untrusted card gestures confer no user authority and cannot enter the trusted panel dispatch path. */
import type { Tool } from "../tools/base.js";
import type { PluginToolInvocationDelegate } from "../plugins/runtime/index.js";
import { resolvePluginOperation } from "../tools/plugin-operation-governance.js";

export interface McpAppToolInvocation {
  appSessionId: string;
  /** One-shot authority stays inside main and is never exposed to cards. */
  operationGrantToken?: string;
  expectedGenerationId?: string;
}

export interface McpOperationGrantTarget {
  pluginId: string;
  toolName: string;
}

function operationGrantTarget(
  tool: Tool | undefined,
  args: Record<string, unknown>,
): McpOperationGrantTarget | undefined {
  if (!tool?.pluginId || !tool.operationPolicy) return undefined;
  const resolved = resolvePluginOperation(tool.operationPolicy, args, "mcp-app");
  return resolved.rule.kind === "write"
    ? { pluginId: tool.pluginId, toolName: tool.name }
    : undefined;
}

interface PluginToolCallRuntime {
  resolveToolOwner(method: string): string | undefined;
  /** callFromApp checks visibility and executes through the host gate without user-action claims. */
  callFromApp(
    method: string,
    payload?: unknown,
    options?: {
      appSessionId?: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown>;
}

export interface LoopbackToolCallDeps {
  runtime: PluginToolCallRuntime;
  findTool(name: string): Tool | undefined;
}

export interface ExternalToolCallDeps {
  namespacedToolName(serverId: string, toolName: string): string;
  findTool(name: string): Tool | undefined;
  /** Null until boot wires the gated executor. */
  getInvoker(): PluginToolInvocationDelegate | null;
}

/** Runtime ownership maps plugin methods; callFromApp owns visibility and execution gates. */
export function createLoopbackToolCallSource(deps: LoopbackToolCallDeps): {
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  resolveOperationGrantTarget(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): McpOperationGrantTarget | undefined;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocation: McpAppToolInvocation,
  ): Promise<unknown>;
} {
  return {
    // Resolve method ownership globally, then compare it with the card server id.
    resolveToolOwner: (_serverId, toolName) => deps.runtime.resolveToolOwner(toolName),
    resolveOperationGrantTarget: (_serverId, toolName, args) =>
      operationGrantTarget(deps.findTool(toolName), args),
    // Use app dispatch, never panel dispatch; this path cannot claim a user gesture.
    callTool: (_serverId, toolName, args, invocation) =>
      deps.runtime.callFromApp(toolName, args, invocation),
  };
}

/** External tools execute the governed registry entry already bound to their server. */
export function createExternalToolCallSource(deps: ExternalToolCallDeps): {
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  resolveOperationGrantTarget(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): McpOperationGrantTarget | undefined;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocation: McpAppToolInvocation,
  ): Promise<unknown>;
} {
  // Apps use server-local names; resolve once to the governed registry name.
  const lookup = (serverId: string, toolName: string): Tool | undefined =>
    deps.findTool(deps.namespacedToolName(serverId, toolName));

  return {
    // Registry mcpServerId proves ownership; namespacing alone can pass through unapproved names.
    resolveToolOwner: (serverId, toolName) => lookup(serverId, toolName)?.mcpServerId,

    resolveOperationGrantTarget: (serverId, toolName, args) => {
      const tool = lookup(serverId, toolName);
      if (!tool || tool.mcpServerId !== serverId) return undefined;
      return operationGrantTarget(tool, args);
    },

    callTool: async (serverId, toolName, args, invocation) => {
      const tool = lookup(serverId, toolName);
      // Refuse unknown registry entries even if the IPC owner check was bypassed.
      if (!tool) throw new Error(`Tool not found: ${toolName}`);
      if (tool.mcpServerId !== serverId) {
        throw new Error(
          `Tool '${toolName}' owner changed during MCP App call: expected '${serverId}', got '${tool.mcpServerId ?? "unknown"}'`,
        );
      }

      // Require appInvokable exactly true; undefined entries never grant app access.
      if (tool.appInvokable !== true) {
        throw new Error(
          `Tool '${toolName}' is not app-callable: its _meta.ui.visibility does not include "app"`,
        );
      }

      const invoke = deps.getInvoker();
      if (!invoke) throw new Error("Tool executor is not wired; MCP App tool call denied");

      // Execute with app origin and no user gesture so the ordinary risk, approval and audit gates apply.
      return invoke(tool.name, args, {
        origin: "mcp-app",
        userAction: false,
        ...(tool.pluginId ? { ownerPluginId: tool.pluginId } : {}),
        appInvocation: {
          surface: "mcp-app",
          sessionId: invocation.appSessionId,
          ...(invocation.operationGrantToken
            ? { operationGrantToken: invocation.operationGrantToken }
            : {}),
        },
        expectedMcpServerId: serverId,
      });
    },
  };
}
