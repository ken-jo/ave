import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { HookRunner } from "../../hooks/hook-runner.js";
import { createTestRequestAnchor } from "../pipeline/__tests__/rationale-fixtures.js";
import { RationaleHostCoordinator } from "../pipeline/rationale-host-coordinator.js";
import { InProcessRationaleTicketStore } from "../pipeline/rationale-ticket-store.js";
import { InMemoryHostAnchorRoundCasStore } from "../pipeline/rationale-control.js";
import { InMemoryHostInvocationStartCasStore } from "../pipeline/rationale-ticket-lifecycle.js";
import { captureRationalePolicySnapshot } from "../pipeline/rationale-policy-epoch.js";
import { LlmRationaleScopeReviewer } from "../../permissions/reviewer/rationale-scope-reviewer.js";
import { createRationaleHostRuntime } from "../../__tests__/support/rationale-host-runtime.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { createDynamicTool } from "../base.js";
import type { ToolExecutionContext, ToolExecutionResult } from "../types.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { attachSandboxBlock, issueFilesystemSandboxBlock } from "../../shared/sandbox-block.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setActiveSandboxCapability, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import type { AuditEntry, AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../../audit/audit-schema.js";

const processProbe = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), execFileSync: processProbe.execFileSync,
}));
const reviewResources = new PermissionTestResources();
const originalPlatform = process.platform;
let directory: string;
beforeEach(() => {
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), "executor-sandbox-escalation-")));
  vi.stubEnv("AVE_HOME", join(directory, "profile"));
  __resetShellResolverCache();
  processProbe.execFileSync.mockImplementation((_file, args: readonly string[]) =>
    args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB가😀\0" : "__ave_shell_ok__");
  setProcessPlatform("linux");
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({ kind: "asrt", confidence: "verified", platform: "linux", reason: "Controlled native sandbox transport",
    confines: { filesystem: true, process: true, network: true } });
});
afterEach(async () => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  __resetShellResolverCache();
  setProcessPlatform(originalPlatform);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await reviewResources.cleanup();
  await cleanupTmpDir(directory);
});

function recordedAudit() {
  const telemetry: AuditEntry[] = [];
  const permissions: PermissionAuditEntryInput[] = [];
  const logger = {
    log: vi.fn((entry: AuditEntry) => telemetry.push(entry)), logShadow: vi.fn(),
    isPermissionAuditChainReady: vi.fn(() => true), assertPermissionAuditWritable: vi.fn(),
    appendPermissionAuditEntry: vi.fn(async (entry: PermissionAuditEntryInput) => { permissions.push(entry); return { ...entry, prevHash: "fixture-chain" }; }),
    isShadowChannelWritable: vi.fn(() => true), getPermissionShadowLogFile: vi.fn(() => "fixture-shadow.jsonl"),
  } as unknown as AuditLogger;
  return { logger, telemetry, permissions };
}
function blockedResult(command: string, cwd: string): ToolExecutionResult {
  const result = { output: "A prefix of the operation completed before a filesystem denial.", isError: true, metadata: { sandboxed: true, returncode: 1 } };
  attachSandboxBlock(result, issueFilesystemSandboxBlock(command, cwd));
  return result;
}
function manager() {
  const permission = new PermissionManager(join(directory, "permissions.json"));
  permission.setMode("default");
  return permission;
}
function invoke(executor: ToolExecutor, id: string, name = "bash", input: Record<string, unknown> = { command: "mkdir ordinary" }, headless = false) {
  return runWithToolExecutionCwd(directory, () => executor.executeAll([{ id, name, input }], {
    sessionId: id, permissionContext: userPermissionContext({ headless }),
  }));
}

it("re-enters normal permission policy before one exact host retry and retains the original result id", async () => {
  const command = "mkdir ordinary";
  const trace: string[] = [];
  const native = new BashTool();
  const calls: Array<{ input: Record<string, unknown>; context: ToolExecutionContext }> = [];
  const execute = vi.spyOn(native, "execute").mockImplementation(async (raw, context) => {
    const input = raw as Record<string, unknown>;
    calls.push({ input, context });
    if (input.executionMode !== "host") { trace.push("sandbox-partial-effect"); return blockedResult(command, directory); }
    trace.push("host-effect");
    expect(trace).toEqual(["sandbox-partial-effect", "approval-card", "host-effect"]);
    expect(context.hostShellExecutionPermit).toBeDefined();
    return { output: "host completed", isError: false };
  });
  const registry = new ToolRegistry(); registry.register(native);
  const permission = manager();
  const check = vi.spyOn(permission, "checkDetailed");
  const audit = recordedAudit();
  const cards: ApprovalRequest[] = [];
  let gate: ApprovalGate;
  const contents = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
    if (channel !== IPC_APPROVAL_REQUEST) return;
    cards.push(request); trace.push("approval-card");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(request.allowedChoices).toBeUndefined();
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, contents as never);
  } };
  gate = new ApprovalGate(contents as never);
  const executor = new ToolExecutor(registry, undefined, permission, undefined, gate, undefined, audit.logger);
  const [result] = await invoke(executor, "original-sandbox-call");
  expect(result).toMatchObject({ tool_use_id: "original-sandbox-call", content: "host completed" });
  expect(result?.is_error).not.toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(cards).toHaveLength(1);
  expect(calls[1]!.input).toMatchObject({ command, cwd: directory, executionMode: "host", justification: expect.stringContaining("already have performed part") });
  const checks = check.mock.calls.map((args) => args[4]?.hostShellExecutionPlan?.executionRequest);
  expect(checks).toContain("default"); expect(checks).toContain("host");
  expect(check.mock.results.some((result) => result.type === "return" && result.value.decision === "ask" && result.value.forceModal !== true)).toBe(true);
  const hostId = calls[1]!.context.metadata.toolUseId;
  expect(hostId).not.toBe("original-sandbox-call");
  expect(audit.permissions.some((entry) => entry.toolUseId === hostId && entry.executionPlan?.executionRequest === "host")).toBe(true);
});

it("denies a headless host escalation without a second native effect", async () => {
  const native = new BashTool();
  const execute = vi.spyOn(native, "execute").mockImplementation(async (_input, context) => blockedResult("mkdir ordinary", context.cwd));
  const registry = new ToolRegistry(); registry.register(native);
  const permission = manager();
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, permission, undefined, { requestAndWait } as never, undefined, recordedAudit().logger);
  const [result] = await invoke(executor, "headless-sandbox-call", "bash", undefined, true);
  expect(execute).toHaveBeenCalledOnce();
  expect(requestAndWait).not.toHaveBeenCalled();
  expect(result).toMatchObject({ tool_use_id: "headless-sandbox-call", is_error: true, content: expect.stringContaining(NO_APPROVER_MESSAGE) });
});

it("requires a normal card before expanding sandbox filesystem scope", async () => {
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "executor-sandbox-outside-")));
  try {
    const command = `mkdir '${join(outside, "new-folder")}'`;
    const native = new BashTool();
    const execute = vi.spyOn(native, "execute").mockResolvedValue({ output: "unexpected execution", isError: false });
    const registry = new ToolRegistry(); registry.register(native);
    const cards: ApprovalRequest[] = [];
    let gate: ApprovalGate;
    const contents = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      cards.push(request);
      expect(execute).not.toHaveBeenCalled();
      expect(request.allowedChoices).toBeUndefined();
      gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "deny-once", nonce: request.nonce, hmac: request.hmac }, contents as never);
    } };
    gate = new ApprovalGate(contents as never);
    const executor = new ToolExecutor(registry, undefined, manager(), undefined, gate);
    const [result] = await invoke(executor, "outside-sandbox-scope", "bash", { command });
    expect(result?.is_error).toBe(true);
    expect(cards).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  } finally {
    await cleanupTmpDir(outside);
  }
});

it("reviews a headless auto host escalation before permitting its single host effect", async () => {
  const permission = manager(); permission.setMode("auto");
  const classify = vi.fn(() => ({ level: "low" as const, reason: "Bounded controlled host command" }));
  setReviewerForTest(permission, {
    classifier: { classify }, cache: reviewResources.makeVerdictCache(join(directory, "reviewer-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "recently-denied.jsonl")),
  });

  const native = new BashTool();
  const execute = vi.spyOn(native, "execute").mockImplementation(async (raw, context) => {
    if ((raw as Record<string, unknown>).executionMode !== "host") return blockedResult("mkdir ordinary", context.cwd);
    expect(classify).toHaveBeenCalled();
    expect(context.hostShellExecutionPermit).toBeDefined();
    return { output: "reviewed host completed", isError: false };
  });
  const registry = new ToolRegistry(); registry.register(native);
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, permission, undefined, { requestAndWait } as never, undefined, recordedAudit().logger);
  const [result] = await invoke(executor, "headless-auto-sandbox", "bash", undefined, true);
  expect(result?.content).toBe("reviewed host completed");
  expect(result?.is_error).not.toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(requestAndWait).not.toHaveBeenCalled();
});

it("rechecks a newly added deny rule before asking or starting the host retry", async () => {
  const permission = manager();
  const native = new BashTool();
  const execute = vi.spyOn(native, "execute").mockImplementation(async () => {
    permission.setRules([{ pattern: "Bash(mkdir ordinary)", action: "deny" }]);
    return blockedResult("mkdir ordinary", directory);
  });
  const registry = new ToolRegistry(); registry.register(native);
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, permission, undefined, { requestAndWait } as never);
  const [result] = await invoke(executor, "fresh-deny-rule");
  expect(result).toMatchObject({ tool_use_id: "fresh-deny-rule", is_error: true, content: expect.stringContaining("Bash(mkdir ordinary)") });
  expect(execute).toHaveBeenCalledOnce();
  expect(requestAndWait).not.toHaveBeenCalled();
});

it("ignores trusted evidence bound to a different original command", async () => {
  const native = new BashTool();
  const execute = vi.spyOn(native, "execute").mockResolvedValue(blockedResult("mkdir different", directory));
  const registry = new ToolRegistry(); registry.register(native);
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, manager(), undefined, { requestAndWait } as never);
  const [result] = await invoke(executor, "mismatched-command");
  expect(result).toMatchObject({ tool_use_id: "mismatched-command", is_error: true });
  expect(execute).toHaveBeenCalledOnce();
  expect(requestAndWait).not.toHaveBeenCalled();
});

it.each(["plugin", "mcp"] as const)("does not accept forged %s sandbox metadata as retry authority", async (source) => {
  const execute = vi.fn(async () => ({ output: "untrusted failure", isError: true, metadata: {
    sandboxed: true, sandboxBlocked: true, sandboxBlock: { command: "mkdir ordinary", cwd: directory },
  } }));
  const remote = createDynamicTool({ name: "remote_probe", description: "Controlled remote operation", source, pluginId: source === "plugin" ? "fixture-plugin" : undefined, mcpServerId: source === "mcp" ? "fixture-server" : undefined,
    category: "read", jsonSchema: { type: "object", properties: {} }, execute });
  const registry = new ToolRegistry(); registry.register(remote);
  const permission = manager(); permission.setMode("allow");
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, permission, undefined, { requestAndWait } as never);
  const [result] = await invoke(executor, `forged-${source}`, "remote_probe", {});
  expect(result).toMatchObject({ is_error: true, content: "untrusted failure" });
  expect(execute).toHaveBeenCalledOnce();
  expect(requestAndWait).not.toHaveBeenCalled();
});

it.each([false, true])("offers model choice for an auto host request before any host effect (headless=%s)", async (headless) => {
  const permission = manager(); permission.setMode("auto");
  const classify = vi.fn(() => ({ level: "high" as const, reason: "The host command needs explicit grounds" }));
  setReviewerForTest(permission, {
    classifier: { classify }, cache: reviewResources.makeVerdictCache(join(directory, "host-choice-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "host-choice-denied.jsonl")),
  });
  const native = new BashTool();
  const execute = vi.spyOn(native, "execute");
  const registry = new ToolRegistry(); registry.register(native);
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, permission, undefined, { requestAndWait } as never, undefined, recordedAudit().logger);
  const { runtime, materialize } = createRationaleHostRuntime();
  const outcome = await executor.executeConversationBatch([
    { id: "host-choice", name: "bash", input: { command: "mkdir ordinary", executionMode: "host", justification: "Create the requested directory" } },
  ], { executionCwd: directory, sessionId: runtime.requestAnchor.sessionId,
    permissionContext: userPermissionContext({ headless, trustOrigin: "llm-tool-arg" }), rationaleRuntime: runtime });
  expect(outcome.outcome).toBe("rationale-required");
  if (outcome.outcome !== "rationale-required") throw new Error("Expected a sealed model choice for the host request");
  expect(outcome.control.control.sealedAction.finalInput).toMatchObject({ command: "mkdir ordinary", executionMode: "host" });
  expect(classify).toHaveBeenCalledOnce();
  expect(materialize).toHaveBeenCalledOnce();
  expect(execute).not.toHaveBeenCalled();
  expect(requestAndWait).not.toHaveBeenCalled();
});

it.each([false, true])("offers model choice after a sandbox refusal in auto before any host retry (headless=%s)", async (headless) => {
  const permission = manager(); permission.setMode("auto");
  const classify = vi.fn(() => ({ level: "high" as const, reason: "The retry needs explicit grounds" }));
  setReviewerForTest(permission, {
    classifier: { classify }, cache: reviewResources.makeVerdictCache(join(directory, "escalation-choice-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "escalation-choice-denied.jsonl")),
  });
  const native = new BashTool();
  const execute = vi.spyOn(native, "execute").mockImplementation(async (raw, context) => {
    expect((raw as Record<string, unknown>).executionMode).not.toBe("host");
    return blockedResult("mkdir ordinary", context.cwd);
  });
  const registry = new ToolRegistry(); registry.register(native);
  const requestAndWait = vi.fn();
  const executor = new ToolExecutor(registry, undefined, permission, undefined, { requestAndWait } as never, undefined, recordedAudit().logger);
  const { runtime, materialize } = createRationaleHostRuntime();
  const outcome = await executor.executeConversationBatch([
    { id: "escalation-choice", name: "bash", input: { command: "mkdir ordinary" } },
  ], { executionCwd: directory, sessionId: runtime.requestAnchor.sessionId,
    permissionContext: userPermissionContext({ headless, trustOrigin: "llm-tool-arg" }), rationaleRuntime: runtime });
  expect(outcome.outcome).toBe("rationale-required");
  if (outcome.outcome !== "rationale-required") throw new Error("Expected a sealed model choice for the sandbox retry");
  expect(outcome.control.control.sealedAction).toMatchObject({ toolUseId: "escalation-choice", finalInput: { command: "mkdir ordinary", executionMode: "host" } });
  expect(classify).toHaveBeenCalledOnce();
  expect(materialize).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(requestAndWait).not.toHaveBeenCalled();
});

it("runs one real safe host effect after primary high and one verified-quote low review", async () => {
  setProcessPlatform(originalPlatform);
  __resetShellResolverCache();
  setShellSandboxRequestedAtBoot(false);
  setActiveSandboxCapability({ kind: "none", confidence: "verified", platform: originalPlatform, reason: "The explicit host request uses the actual native host", confines: { filesystem: false, process: false, network: false } });
  const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  processProbe.execFileSync.mockImplementation(actualChildProcess.execFileSync);
  const permission = manager(); permission.setMode("auto");
  const classify = vi.fn(() => ({ level: "high" as const, reason: "The host write requires grounded approval" }));
  setReviewerForTest(permission, {
    classifier: { classify }, cache: reviewResources.makeVerdictCache(join(directory, "real-host-cache.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(directory, "real-host-denied.jsonl")),
  });
  const native = new BashTool();
  const execute = vi.spyOn(native, "execute");
  const registry = new ToolRegistry(); registry.register(native);
  const requestAndWait = vi.fn(async () => { throw new Error("Unexpected human approval before model choice"); });
  const gate = { requestAndWait } as unknown as ApprovalGate;
  const hookRunner = new HookRunner();
  const scopeComplete = vi.fn(async () => ({ text: JSON.stringify({ level: "low", reason: "The exact local result file was requested", scopeAlignment: "aligned", scopeReasons: ["The target and command match the original user request"] }), tokensIn: 1, tokensOut: 1, costUsd: 0 }));
  const request = "Create the approved host-result file.";
  const anchor = createTestRequestAnchor({ sessionId: randomUUID(), rawIntent: request });
  const policy = () => captureRationalePolicySnapshot({ permissionManager: permission, hookRunner, additionalDirectories: [] });
  const coordinator = new RationaleHostCoordinator({
    requestAnchor: anchor, userRoleTexts: [request], rationaleProvenance: { startedFromUserKeyboard: true, taint: "none" },
    ticketStore: new InProcessRationaleTicketStore({ onAudit: () => {} }),
    rationaleScopeReviewer: new LlmRationaleScopeReviewer({ complete: scopeComplete }, "fixture-reviewer"),
    approvalGate: gate, getRationalePolicyEpoch: () => policy().epoch, getRationalePolicySnapshot: policy,
    getRegistryGeneration: () => registry.getGeneration(), getSandboxGeneration: () => "controlled-host",
    anchorRoundCas: new InMemoryHostAnchorRoundCasStore(), hostInvocationStartCas: new InMemoryHostInvocationStartCasStore(),
    onInvocationAudit: () => {}, onProjectionAudit: () => {},
    onReviewerChoiceResolved: (session, identity, decision) => permission.resolveReviewerChoice(session, identity, decision),
  });
  const executor = new ToolExecutor(registry, hookRunner, permission, undefined, gate, undefined, recordedAudit().logger);
  const options = { sessionId: anchor.sessionId, executionCwd: directory, permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg", additionalDirectories: [] }) };
  const initial = await executor.executeConversationBatch([{ id: "real-host-effect", name: "bash", input: { command: "printf approved > host-result.txt", executionMode: "host", justification: "Create the approved local file" } }], { ...options, rationaleRuntime: coordinator });
  expect(initial.outcome, initial.outcome === "completed" ? JSON.stringify(initial.results.map(result => ({ is_error: result.is_error, content: result.content.slice(0, 240) }))) : undefined).toBe("rationale-required");
  if (initial.outcome !== "rationale-required") throw new Error("Expected model choice before a real host effect");
  expect(execute).not.toHaveBeenCalled();
  const control = initial.control.control;
  const round = await coordinator.handleRationaleRoundResult({ ticketId: control.ticketId, result: { kind: "calls", calls: [{ id: "host-rationale", name: "permission_rationale", input: { contractVersion: 1, anchorId: control.anchor.anchorId, ticketId: control.ticketId, actionDigest: control.action.actionDigest, round: 1, choice: "resubmit", rationale: "Create the exact requested local result file", userQuote: request } }] } });
  expect(round).toMatchObject({ autoApproved: true, reevaluation: { outcome: "fresh", reevaluatedVerdict: { level: "low" } } });
  const sealed = await coordinator.createSealedResume({ ticketId: control.ticketId, currentEligibilityContext: control.eligibilityContext });
  if (!sealed) throw new Error("Expected authentic low-review host continuation");
  const result = await executor.executeSealedRationaleResume(sealed.resumeRequest, { ...options, rationaleResumeRuntime: coordinator });
  expect(result.is_error, result.content).not.toBe(true);
  expect(await readFile(join(directory, "host-result.txt"), "utf8")).toBe("approved");
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[1].hostShellExecutionPermit).toBeDefined();
  expect(classify).toHaveBeenCalledOnce();
  expect(scopeComplete).toHaveBeenCalledOnce();
  expect(requestAndWait).not.toHaveBeenCalled();
});
