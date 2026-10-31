import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import type { Tool } from "../base.js";
import { authorizeToolInvocation, type AuthorizationStageContext } from "../invocation-authorization.js";
import type { InvocationRunnerServices } from "../invocation-services.js";
import { userPermissionContext } from "./tool-context-fixture.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "ave-authorization-pipeline-")); });
afterEach(async () => { await cleanupTmpDir(directory); });

function fixture(options: {
  category?: Tool["category"];
  source?: Tool["source"];
  prefix?: string;
  headless?: boolean;
  otherPrincipal?: boolean;
  mcpReadOnlyHint?: boolean;
  mode?: "strict" | "default" | "auto" | "allow";
  manualRerun?: boolean;
} = {}) {
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode(options.mode ?? "allow");
  const requestAndWait = vi.fn(async (request: { id: string }): Promise<ApprovalDecision> => ({ requestId: request.id, choice: "deny-once" }));
  const memorySkip = vi.fn(async () => null);
  const allowsPolicyTransition = vi.fn(() => false);
  const tool: Tool = {
    name: "inspect_resource", description: "Inspect a resource", version: "1.0.0",
    category: options.category ?? "read", source: options.source ?? "builtin",
    mcpReadOnlyHint: options.mcpReadOnlyHint,
    execute: vi.fn(), toJsonSchema: () => ({}), isReadOnly: () => true,
  };
  const context: AuthorizationStageContext = {
    services: {
      permissionManager: manager,
      approvalGate: { requestAndWait, allowsPolicyTransition },
      tryUserApprovalMemorySkip: memorySkip,
    } as unknown as InvocationRunnerServices,
    tool, toolUse: { id: "inspect", name: tool.name, input: {} },
    source: tool.source, trust: "high", invocationCategory: tool.category,
    approvalReasonPrefix: options.prefix, overlayTriggerOrigin: undefined,
    hostShellRequiresExplicitApproval: options.category === "shell",
    hostShellExecutionPlan: undefined, hostShellExecutionPlanAudit: undefined,
    hostShellPathPolicyRelaxations: undefined, hostShellExecutionPermitBinding: undefined,
    hostShellApprovalDecision: undefined, finalInput: {},
    invocationAllowedScope: { directories: [directory] }, sensitivePathPattern: null,
    invocationPermissionContext: userPermissionContext({ headless: options.headless, manualRerun: options.manualRerun, otherPrincipal: options.otherPrincipal }),
    evaluationContext: {} as AuthorizationStageContext["evaluationContext"], callbacks: undefined,
    meta: { groupId: "pipeline", toolUseId: "inspect", displayOrder: 0 }, approvalPurpose: undefined, auditInput: {}, abortSignal: undefined,
    rationaleResumeContext: undefined, rationaleBatchContext: undefined,
    targetFilePath: undefined, canonicalTargets: [], approvalCacheKey: undefined,
    executionCwd: directory, auditCurrentToolCall: vi.fn(), auditCurrentPermissionAsk: vi.fn(),
    withHostShellExecutionPlan: (result) => result,
    abortDeps: vi.fn(), returnRationaleResumeBlock: vi.fn(), sessionId: "pipeline", startTime: Date.now(),
    permissionResult: undefined, resolvedPluginOperation: undefined, pluginOperationPrincipal: undefined,
  };
  return { manager, context, requestAndWait, memorySkip, allowsPolicyTransition };
}

describe("invocation permission pipeline orchestration", () => {
  it.each(["strict", "default", "auto", "allow"] as const)("keeps another principal's read once-only in %s", async (mode) => {
    const { context, manager, requestAndWait, memorySkip } = fixture({ mode, prefix: "Another principal:" });
    const review = vi.spyOn(manager, "dispatchReviewer");
    const result = await authorizeToolInvocation(context);
    expect(result).toMatchObject({ is_error: true });
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(requestAndWait.mock.calls[0]?.[0]).toMatchObject({
      allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false,
    });
    expect(memorySkip).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("denies another principal's headless read without reviewing", async () => {
    const { context, manager, requestAndWait } = fixture({ mode: "auto", prefix: "Another principal:", headless: true });
    const review = vi.spyOn(manager, "dispatchReviewer");
    const result = await authorizeToolInvocation(context);
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("do not retry") });
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
  });

  it("routes an actual other-principal action through the floor before allow rules", async () => {
    const { context, manager, requestAndWait } = fixture({ otherPrincipal: true });
    manager.setRules([{ pattern: "inspect_resource", action: "allow" }]);
    await authorizeToolInvocation(context);
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(requestAndWait.mock.calls[0]?.[0]).toMatchObject({ forceExplicit: true });
  });

  it("allows read-only protocol metadata in strict mode", async () => {
    const { context, requestAndWait } = fixture({ mode: "strict", source: "mcp", mcpReadOnlyHint: true });
    const result = await authorizeToolInvocation(context);
    expect(result).toMatchObject({ outcome: "authorized", permissionResult: { decision: "allow", reasonCode: "read-only-tool" } });
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("uses the central allow result for an ordinary host shell", async () => {
    const { context, requestAndWait } = fixture({ category: "shell", mode: "allow" });
    const result = await authorizeToolInvocation(context);
    expect(result).toMatchObject({ outcome: "authorized", permissionResult: { decision: "allow" } });
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("rejects a card answer after permission policy changes", async () => {
    const { context, manager, requestAndWait, allowsPolicyTransition } = fixture({ category: "write", mode: "strict" });
    context.finalInput = Object.freeze({ path: join(directory, "resource.txt"), content: "unchanged input" });
    requestAndWait.mockImplementation(async (request) => {
      manager.setRules([{ pattern: context.toolUse.name, action: "deny" }]);
      return { requestId: request.id, choice: "allow-once" };
    });
    const result = await authorizeToolInvocation(context);
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining("Permission policy changed") });
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(allowsPolicyTransition).toHaveBeenCalledOnce();
    expect(context.tool.execute).not.toHaveBeenCalled();
    expect(context.finalInput).toEqual({ path: join(directory, "resource.txt"), content: "unchanged input" });
  });

  it("carries an exact directory authorization without a second policy check or card", async () => {
    const { context, manager, requestAndWait, memorySkip } = fixture({ category: "write", mode: "strict" });
    const permission = { decision: "allow" as const, reason: "user approved the exact outside write", };
    context.directoryAuthorization = { permission, humanApproved: true };
    const check = vi.spyOn(manager, "checkDetailed");
    const result = await authorizeToolInvocation(context);
    expect(result).toMatchObject({ outcome: "authorized", humanApproved: true, permissionResult: permission });
    expect(check).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(memorySkip).not.toHaveBeenCalled();
    expect(context.finalInput).toEqual({});
  });

  it("refuses to use directory authorization for a sealed rationale resume", async () => {
    const { context, requestAndWait } = fixture({ category: "write", mode: "strict" });
    context.directoryAuthorization = { permission: { decision: "allow", reason: "approved exact write", }, humanApproved: true };
    context.rationaleResumeContext = {} as NonNullable<typeof context.rationaleResumeContext>;
    const blocked = { tool_use_id: "inspect", content: "resume blocked", is_error: true, durationMs: 0 };
    const refuseResume = vi.fn(async () => blocked);
    context.returnRationaleResumeBlock = refuseResume;
    expect(await authorizeToolInvocation(context)).toBe(blocked);
    expect(refuseResume).toHaveBeenCalledOnce();
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("asks a fresh card on manual rerun without approval memory", async () => {
    const { context, requestAndWait, memorySkip } = fixture({ manualRerun: true });
    await authorizeToolInvocation(context);
    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(memorySkip).not.toHaveBeenCalled();
  });
});
