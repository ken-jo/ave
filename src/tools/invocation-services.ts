import { turnExtensionPolicyContext } from "../shared/turn-extension-policy.js";
import { raceWithAbort } from "../shared/abortable-deadline.js";
import type { Tool } from "./base.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolCategory, ToolSource } from "./types.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { PermissionDirectoryLifecycle } from "../permissions/permission-slash.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { HookDispatchResult, ScriptHookManager } from "../hooks/script-hook-manager.js";
import type { HookTrustOrigin, ScriptHookType } from "../hooks/script-hook-types.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { ToolPermissionContext } from "./executor-contract.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { AuditWriter } from "./pipeline/audit-writer.js";
import type { RateLimiter } from "./pipeline/rate-limiter.js";
import { resolveEnforcedCategory as resolveEnforcedCategoryImpl } from "./pipeline/risk-classification.js";
import { tryUserApprovalMemorySkip as tryUserApprovalMemorySkipImpl } from "./pipeline/approval-memory-skip.js";
import {
  PluginOperationGrantCoordinator,
} from "../permissions/plugin-operation-grant.js";
import type { PluginRuntimeGenerationAccess } from "../plugins/plugin-host-generation.js";
import type { GovernedRiskFloor } from "./plugin-operation-governance.js";
import type { PluginOperationInvocationContext } from "./plugin-operation-governance.js";

export type PluginOperationIdentityProvider = (
  tool: Tool,
  sessionId: string | undefined,
) => PluginOperationInvocationContext | undefined;

export interface InvocationRunnerServices {
  readonly toolRegistry: ToolRegistry;
  readonly hookRunner: HookRunner;
  readonly permissionManager?: PermissionManager;
  readonly approvalGate?: ApprovalGate;
  readonly auditLogger: AuditLogger;
  readonly requirePermissionAuditChain: boolean;
  readonly rateLimiter: RateLimiter;
  readonly bashAstValidator?: BashAstValidator;
  readonly scriptHookManager?: ScriptHookManager;
  readonly hostClassifiesRiskProvider: () => boolean;
  readonly sandboxFsContainedProvider: (tool: Tool) => boolean;
  readonly workspaceRootLifecycleProvider: () => PermissionDirectoryLifecycle | undefined;
  readonly auditWriter: AuditWriter;
  readonly tryUserApprovalMemorySkip: typeof tryUserApprovalMemorySkipImpl;
  readonly pluginOperationGrants: PluginOperationGrantCoordinator;
  readonly pluginGenerationAccessProvider: () => PluginRuntimeGenerationAccess | undefined;
  readonly pluginOperationIdentityProvider: PluginOperationIdentityProvider;
}

export function resolveEnforcedCategory(
  services: InvocationRunnerServices,
  tool: Tool,
  declaredCategory: ToolCategory,
  finalInput: Record<string, unknown>,
  correlationId: string,
  operationFloor?: GovernedRiskFloor,
): ToolCategory {
  return resolveEnforcedCategoryImpl({
    tool,
    declaredCategory,
    finalInput,
    correlationId,
    hostClassifiesRisk: services.hostClassifiesRiskProvider(),
    sandboxFsContained: services.sandboxFsContainedProvider(tool),
    auditLogger: services.auditLogger,
    operationFloor,
  });
}

export async function runScriptHook(
  scriptHookManager: ScriptHookManager | undefined,
  hookType: ScriptHookType,
  toolName: string,
  source: ToolSource,
  category: ToolCategory,
  input: Record<string, unknown>,
  sessionId: string | undefined,
  context: ToolPermissionContext,
  mcpServerId?: string,
  pluginId?: string,
  toolOutput?: string,
  isError?: boolean,
  generationOwned = false,
  abortSignal?: AbortSignal,
): Promise<HookDispatchResult> {
  const inherited = turnExtensionPolicyContext.getStore();
  const callerSignals = [...new Set([abortSignal, inherited?.abortSignal].filter((signal): signal is AbortSignal => signal !== undefined))];
  const callerSignal = callerSignals.length > 1 ? AbortSignal.any(callerSignals) : callerSignals[0];
  const cancelled = (): HookDispatchResult => ({ decision: "deny", reason: "Hook execution cancelled", results: [] });
  if (callerSignal?.aborted) return cancelled();
  if (!scriptHookManager) {
    if (generationOwned) {
      throw new Error(
        `[plugin-hooks] script Hook manager is not wired for generation-owned tool '${toolName}'`,
      );
    }
    return { decision: "allow", reason: "script hooks not wired", results: [] };
  }
  const payload = {
    toolName,
    source,
    category,
    input,
    sessionId: sessionId ?? "unknown",
    trustOrigin: context.trustOrigin as HookTrustOrigin,
    ...(mcpServerId !== undefined ? { mcpServerId } : {}),
    ...(pluginId !== undefined ? { pluginId } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  if (callerSignal?.aborted) onAbort();
  const operation = turnExtensionPolicyContext.run({
    ...inherited, allowExternalHooks: inherited?.allowExternalHooks !== false,
    headless: context.headless, ownerUnattended: context.ownerUnattended, approvalSurface: context.approvalSurface,
    remoteControllerAuthority: context.remoteControllerAuthority,
    abortSignal: controller.signal,
    floor: context.floor ?? (context.otherPrincipal ? { code: "other-principal", reason: "This principal requires local approval for the action." } : inherited?.floor),
  }, async () => {
    controller.signal.throwIfAborted();
    const options = { abortSignal: controller.signal };
    if (hookType === "pre") return scriptHookManager.runPreToolUse(payload, options);
    if (hookType === "post") return scriptHookManager.runPostToolUse(payload, options);
    return scriptHookManager.runPermissionRequest(payload, options);
  });
  try {
    return await raceWithAbort(operation, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return cancelled();
    throw error;
  } finally {
    callerSignal?.removeEventListener("abort", onAbort);
  }
}
