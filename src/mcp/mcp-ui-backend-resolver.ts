/** Resolve card reads and calls through one server-bound backend, preferring an owned loopback. */
import type { McpUiResourceRead } from "./types.js";

export interface McpUiBackend {
  /** Card policy comes from resource-owned metadata. */
  readUiResource(uri: string): Promise<McpUiResourceRead>;
  /** The caller compares registry-derived ownership to the bound card server id. */
  resolveToolOwner(toolName: string): string | undefined;
  /** Governed write identity comes from the registry, never the card. */
  resolveOperationGrantTarget(
    toolName: string,
    args: Record<string, unknown>,
  ): {
    pluginId: string;
    toolName: string;
    expectedGenerationId?: string;
  } | undefined;
  /** Require app visibility and run risk, approval and audit through the executor; never invoke raw handlers. */
  callTool(
    toolName: string,
    args: Record<string, unknown>,
    invocation: {
      appSessionId: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown>;
}

export interface ExternalUiSource {
  readUiResource(serverId: string, uri: string): Promise<McpUiResourceRead>;
  resolveToolOwner(serverId: string, toolName: string): string | undefined;
  resolveOperationGrantTarget(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): {
    pluginId: string;
    toolName: string;
    expectedGenerationId?: string;
  } | undefined;
  callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
    invocation: {
      appSessionId: string;
      operationGrantToken?: string;
      expectedGenerationId?: string;
    },
  ): Promise<unknown>;
}

export interface LoopbackUiSource extends ExternalUiSource {
  has(serverId: string): boolean;
  assertCardGeneration(serverId: string, generationId: string): void;
}

/** Bind server identity structurally; callers supply only resource or tool names. */
export function resolveMcpUiBackend(
  serverId: string,
  sources: { loopback: LoopbackUiSource; mcpManager: ExternalUiSource },
  generationId?: string,
): McpUiBackend {
  const loopback = sources.loopback.has(serverId);
  if (loopback && !generationId) {
    throw new Error(`[plugin-loopback] card is missing its immutable generation id for '${serverId}'`);
  }
  const source: ExternalUiSource = loopback ? sources.loopback : sources.mcpManager;
  if (loopback) sources.loopback.assertCardGeneration(serverId, generationId!);
  return {
    readUiResource: (uri) => source.readUiResource(serverId, uri),
    resolveToolOwner: (toolName) => source.resolveToolOwner(serverId, toolName),
    resolveOperationGrantTarget: (toolName, args) => {
      const target = source.resolveOperationGrantTarget(serverId, toolName, args);
      return target && loopback
        ? { ...target, expectedGenerationId: generationId! }
        : target;
    },
    callTool: (toolName, args, invocation) =>
      source.callTool(
        serverId,
        toolName,
        args,
        loopback
          ? { ...invocation, expectedGenerationId: generationId! }
          : invocation,
      ),
  };
}
