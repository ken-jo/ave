import { canonicalStringify } from "./canonical-json.js";
import type { ApprovalMemory, ApprovalMemoryScope } from "./permissions-events.js";

type McpToolApprovalScope = Extract<ApprovalMemoryScope, { kind: "mcp-tool" }>;

/** This scope is host-issued; reject malformed or widened structural lookalikes. */
export function isMcpToolApprovalScope(value: unknown): value is McpToolApprovalScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return Reflect.ownKeys(scope).length === 3 && Object.hasOwn(scope, "kind") &&
    Object.hasOwn(scope, "serverId") && Object.hasOwn(scope, "toolName") &&
    scope.kind === "mcp-tool" && typeof scope.serverId === "string" && scope.serverId.trim().length > 0 &&
    typeof scope.toolName === "string" && scope.toolName.trim().length > 0;
}

export function createMcpToolApprovalScope(serverId: string, toolName: string): McpToolApprovalScope {
  const scope = { kind: "mcp-tool" as const, serverId, toolName };
  if (!isMcpToolApprovalScope(scope)) throw new Error("Invalid tool approval scope");
  return Object.freeze(scope);
}

export function mcpToolApprovalCacheKey(scope: McpToolApprovalScope): string {
  return JSON.stringify([scope.serverId, scope.toolName]);
}

/** Bind the scope to the live server, registered tool, and both host-derived memory identities. */
export function matchesMcpToolApprovalMemory(input: {
  source: string;
  toolName: string;
  mcpServerId?: string;
  approvalCacheKey?: string;
  approvalMemory?: ApprovalMemory;
}): boolean {
  const memory = input.approvalMemory;
  if (input.source !== "mcp" || memory?.kind !== "key" || !isMcpToolApprovalScope(memory.scope)) return false;
  const scope = memory.scope;
  return scope.serverId === input.mcpServerId && input.toolName.length > 0 &&
    input.approvalCacheKey === input.toolName + ":" + mcpToolApprovalCacheKey(scope) &&
    memory.key === input.toolName + ":" + canonicalStringify({ scope, executionPlan: null });
}
