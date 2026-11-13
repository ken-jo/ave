import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ActivePluginGeneration, PluginGenerationLease } from "../../plugins/plugin-generation-coordinator.js";
import type { HostPluginGenerationState, PluginRuntimeGenerationAccess } from "../../plugins/plugin-host-generation.js";
import { readPluginInstanceIntegrity } from "../../plugins/runtime-integrity-evidence.js";
import {
  PluginOperationGrantCoordinator,
  pluginOperationExecutionDomain,
} from "../../permissions/plugin-operation-grant.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ConversationLoop } from "../conversation-loop.js";
import { makeConversationLoopDeps } from "./conversation-loop-test-helpers.js";

function admittedHostGeneration(pluginId: string, generationId: string) {
  const pluginRoot = join(tmpdir(), pluginId);
  const activeGeneration: ActivePluginGeneration<HostPluginGenerationState> = {
    pluginId, generationId, pluginVersion: "1.0.0",
    artifactGenerationId: "a".repeat(64), manifestSha256: "b".repeat(64), receiptSha256: "c".repeat(64),
    contributions: [],
    state: {
      payloadRoot: pluginRoot,
      runtime: {
        activationId: generationId, installId: null, pluginRoot,
        manifest: { id: pluginId, version: "1.0.0", description: "Governed operation fixture", entry: "entry.mjs", tools: [] },
        instance: { handlers: {} }, methods: new Map(), arm: "child", confinement: "unconfined",
      },
      hooks: [], mcpServers: [],
    },
  };
  const release = vi.fn();
  const generationAccess: PluginRuntimeGenerationAccess = {
    getActive: vi.fn(() => ({ pluginId, generationId, manifest: activeGeneration.state.runtime.manifest })),
    isExactAdmitted: vi.fn(() => true),
    acquire: vi.fn(async () => ({ generation: activeGeneration, release })),
    acquireExact: vi.fn(async () => ({ generation: activeGeneration, release })),
    runWithLease: async <T>(_lease: PluginGenerationLease<HostPluginGenerationState>, operation: () => Promise<T>): Promise<T> => operation(),
  };
  return { activeGeneration, generationAccess, release };
}

describe("ConversationLoop plugin operation governance", () => {
  it("wires Host model identity and shared authority into its canonical executor", async () => {
    const pluginId = "governed-plugin";
    const generationId = "generation-1";
    const execute = vi.fn(async () => ({
      output: "fresh",
      isError: false,
    }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "governed_read",
      description: "read governed state",
      source: "plugin",
      category: "write",
      pluginId,
      pluginGeneration: { pluginId, generationId },
      operationPolicy: {
        discriminant: "operation",
        operations: {
          status: {
            kind: "read",
            minimumRisk: "read",
          },
        },
      },
      jsonSchema: { type: "object" },
      execute,
    }));
    const permissionManager =
      new PermissionManager("/tmp/nonexistent-conversation-operation-governance.json");
    permissionManager.checkDetailed = () => ({
      decision: "allow",
      reason: "test",
    });
    const { generationAccess, release } = admittedHostGeneration(pluginId, generationId);
    const grants = new PluginOperationGrantCoordinator();
    const auditLogger = {
      log: vi.fn(),
      logShadow: vi.fn(),
      appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({
        ...entry,
        prevHash: "test-prev-hash",
      })),
      isPermissionAuditChainReady: vi.fn(() => false),
      isShadowChannelWritable: vi.fn(() => true),
      getPermissionShadowLogFile: vi.fn(() => "/tmp/shadow"),
    };
    const loop = new ConversationLoop(makeConversationLoopDeps({
      toolRegistry: registry,
      permissionManager,
      scriptHookManager: new ScriptHookManager(),
      auditLogger: auditLogger as never,
      pluginRuntime: {
        listPluginIds: () => [pluginId],
        isPluginEnabled: () => true,
        getGenerationAccess: () => generationAccess,
      },
      pluginOperationGrants: grants,
      pluginOperationIdentityProvider: (_tool, sessionId) => ({
        ownerVersion: "1.0.0",
        generationId,
        appSessionId: sessionId ?? "model-session",
        accountScopeHash: "account-scope-hash",
        accountHash: "account-hash",
        appGrantRequired: false,
      }),
    }));
    const executor = (
      loop as unknown as { toolExecutor: ToolExecutor }
    ).toolExecutor;

    const [result] = await executor.executeAll(
      [{
        id: "model-governed-read",
        name: "governed_read",
        input: { operation: "status" },
      }],
      {
        sessionId: "model-session",
        permissionContext: {
          trustOrigin: "llm-tool-arg",
          allowedPluginIds: new Set([pluginId]),
        },
      },
    );

    expect(result.is_error).toBeFalsy();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generationAccess.acquireExact).toHaveBeenCalledWith(pluginId, generationId);
    expect(release).toHaveBeenCalledTimes(1);
    const operationPrincipal = {
      ownerPluginId: pluginId,
      ownerVersion: "1.0.0",
      generationId,
      appSessionId: "model-session",
      accountScopeHash: "account-scope-hash",
      accountHash: "account-hash",
    };
    const domain = pluginOperationExecutionDomain(
      operationPrincipal,
      "governed_read",
      "status",
      registry.listAll(),
    );
    expect(grants.latestRequiredRead(
      operationPrincipal,
      "governed_read",
      ["status"],
      60_000,
      domain,
    )).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps a leased runtime without host integrity evidence ineligible for re-adjudication", async () => {
    const pluginId = "unverified-plugin";
    const generationId = "generation-unverified";
    const { activeGeneration, generationAccess, release } = admittedHostGeneration(pluginId, generationId);
    expect(readPluginInstanceIntegrity(activeGeneration.state.runtime.instance)).toBeUndefined();
    const execute = vi.fn(async () => ({ output: "unexpected execution", isError: false }));
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "publish_document", description: "Publish a document", source: "plugin", category: "write", pluginId,
      pluginGeneration: { pluginId, generationId }, pathFields: ["path"],
      jsonSchema: { type: "object", properties: { path: { type: "string" }, operation: { type: "string" } } }, execute,
    }));
    const permissionManager = new PermissionManager(join(tmpdir(), `${pluginId}-${randomUUID()}.json`));
    permissionManager.setMode("strict");
    const cards: ApprovalRequest[] = [];
    const surface = { isDestroyed: () => false, send: vi.fn() };
    const approvalGate = new ApprovalGate(() => surface as never);
    surface.send.mockImplementation((channel: string, request: ApprovalRequest) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      cards.push(request);
      approvalGate.disposeAll();
    });
    try {
      const loop = new ConversationLoop(makeConversationLoopDeps({
        toolRegistry: registry, permissionManager, approvalGate, scriptHookManager: new ScriptHookManager(),
        pluginRuntime: {
          listPluginIds: () => [pluginId], isPluginEnabled: () => true,
          getGenerationAccess: () => generationAccess,
        },
      }));
      const executor = (loop as unknown as { toolExecutor: ToolExecutor }).toolExecutor;
      const [result] = await executor.executeAll([
        { id: "unverified-publish", name: "publish_document", input: { operation: "publish" } },
      ], {
        sessionId: "unverified-session", executionCwd: tmpdir(),
        permissionContext: { trustOrigin: "llm-tool-arg", headless: false, allowedPluginIds: new Set([pluginId]) },
      });
      expect(result.is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ ruleVerdict: { level: "high", reason: "write path not declared" } });
      expect(cards[0]).not.toHaveProperty("readjudication");
      expect(generationAccess.acquireExact).toHaveBeenCalledWith(pluginId, generationId);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      approvalGate.disposeAll();
    }
  });
});
