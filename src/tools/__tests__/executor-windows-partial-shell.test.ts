vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { reviewerJudgeOutcomeForTest, setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));

// The executor prepares the bash invocation before routing, which probes a Bash for the simulated platform. A darwin or linux probe cannot find /bin/bash on a Windows host, and
// the resolver caches that failure for every later case, so answer both probes here: these cases test routing and approval, not host shell discovery. No shell child is started.
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: childProcessMock.execFileSync,
}));

import { createDynamicTool, type Tool } from "../base.js";
import { BashTool } from "../shell-tools.js";
import { ToolExecutor, type ToolCallMeta } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { preparedShellFacts } from "../prepared-shell-invocation.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { permissionManagerReturning as pmReturning } from "./executor-reviewer-fixtures.js";
import {
  ApprovalGate,
  type ApprovalRequest,
} from "../../permissions/approval-gate.js";
import {
  canonicalizeHostShellAllowedDirectories,
  consumeHostShellExecutionPermit,
  resolveHostShellWorkingDirectory,
} from "../../permissions/host-shell-execution-permit.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import {
  __resetActiveSandboxCapabilityForTest,
  __resetSandboxRequestedAtBootForTest,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
} from "../../permissions/sandbox-capability.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import {
  partialWindowsAsrt,
  requestedSandboxUnavailable,
} from "../../__tests__/support/host-shell-sandbox-fixtures.js";
import type { AuditEntry, AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../../audit/audit-schema.js";
import { getHostShellExecutionPlanAuditProjection } from "../../permissions/host-shell-execution-plan.js";
import { userPermissionContext as permissionContext } from "./tool-context-fixture.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

const ORIGINAL_PLATFORM = process.platform;
let testRoot: string;

function shellProbe(execute: (ctx: import("../types.js").ToolExecutionContext) => void): Tool {
  const tool = new BashTool();
  vi.spyOn(tool, "execute").mockImplementation(async (_input, ctx) => {
    execute(ctx);
    return { output: "executed", isError: false };
  });
  return tool;
}

function shellProbeRegistry(execute: Parameters<typeof shellProbe>[0]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(shellProbe(execute));
  return registry;
}

function dynamicShellProbe(execute: (ctx: import("../types.js").ToolExecutionContext) => void): Tool {
  return createDynamicTool({
    name: "bash",
    description: "test-only shell probe",
    source: "builtin",
    category: "shell",
    jsonSchema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    execute: async (_input, ctx) => {
      execute(ctx);
      return { output: "executed", isError: false };
    },
  });
}

function fullDarwinAsrt(): void {
  setProcessPlatform("darwin");
  setShellSandboxRequestedAtBoot(true);
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: "darwin",
    reason: "full ASRT",
    confines: { filesystem: true, process: true, network: true },
  });
}
function explicitlySandboxOff(platform: "darwin" | "linux" | "win32"): void {
  setProcessPlatform(platform);
  __resetActiveSandboxCapabilityForTest();
  setShellSandboxRequestedAtBoot(false);
}
function gateResolving(
  choice: "allow-once" | "deny-once",
  auditLogger?: AuditLogger,
) {
  let gate: ApprovalGate;
  const send = vi.fn((_channel: string, request: ApprovalRequest) => {
    gate.resolve(request.id, {
      requestId: request.id,
      choice,
      nonce: request.nonce,
      hmac: request.hmac,
    });
  });
  gate = new ApprovalGate(
    { isDestroyed: vi.fn(() => false), send } as never,
    undefined,
    undefined,
    auditLogger,
  );
  return { gate, send };
}

function recordingAuditLogger(): {
  auditLogger: AuditLogger;
  telemetryEntries: AuditEntry[];
  permissionEntries: PermissionAuditEntryInput[];
} {
  const telemetryEntries: AuditEntry[] = [];
  const permissionEntries: PermissionAuditEntryInput[] = [];
  const auditLogger = {
    log: vi.fn((entry: AuditEntry) => telemetryEntries.push(entry)),
    logShadow: vi.fn(),
    isPermissionAuditChainReady: vi.fn(() => true),
    assertPermissionAuditWritable: vi.fn(),
    appendPermissionAuditEntry: vi.fn(async (entry: PermissionAuditEntryInput) => {
      permissionEntries.push(entry);
      return { ...entry, prevHash: "test-chain" };
    }),
    isShadowChannelWritable: vi.fn(() => true),
    getPermissionShadowLogFile: vi.fn(() => "test-shadow.jsonl"),
  } as unknown as AuditLogger;
  return { auditLogger, telemetryEntries, permissionEntries };
}

describe("ToolExecutor — Windows partial shell Plan B", () => {
  beforeEach(() => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), "partial-shell-policy-")));
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockImplementation((_file, args: readonly string[]) =>
      args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB가😀\0" : "__ave_shell_ok__");
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockReset();
    vi.unstubAllEnvs();
    setProcessPlatform(ORIGINAL_PLATFORM);
    rmSync(testRoot, { recursive: true, force: true });
  });

  it.each(["active", "off"])("binds native consent for explicit host with sandbox %s", async (sandbox) => {
    vi.stubEnv("AVE_PRIVATE_TEST_MARKER", "fixture-not-forwarded");
    if (sandbox === "active") fullDarwinAsrt();
    else explicitlySandboxOff("darwin");
    const pm = pmReturning({ decision: "ask", reason: "plain shell requires consent", layer: 6 });
    const checkDetailed = vi.spyOn(pm, "checkDetailed");
    let environmentMatched = false;
    let pwdMatched = false;
    let privateMarkerRemoved = false;
    let issuedEnvironmentKeys: string[] = [];
    let checkedEnvironmentKeys: string[] = [];
    const executed = vi.fn((context: import("../types.js").ToolExecutionContext) => {
      expect(context.preparedShellInvocation).toBeDefined();
      const issuedEnvironment = preparedShellFacts(context.preparedShellInvocation!).environment;
      const checkedEnvironment = checkDetailed.mock.calls[0]?.[4]?.shellExecution?.environmentSnapshot;
      environmentMatched = checkedEnvironment === issuedEnvironment;
      pwdMatched = checkedEnvironment?.PWD === context.cwd;
      privateMarkerRemoved = !Object.hasOwn(checkedEnvironment ?? {}, "AVE_PRIVATE_TEST_MARKER");
      issuedEnvironmentKeys = Object.keys(issuedEnvironment).sort();
      checkedEnvironmentKeys = Object.keys(checkedEnvironment ?? {}).sort();
    });
    const registry = shellProbeRegistry(executed);
    let gate: ApprovalGate;
    const send = vi.fn((channel: string, request: ApprovalRequest) => {
      if (channel !== "ave:approval:request") return;
      expect(request).toMatchObject({ executionPlan: { executionRequest: "host", mode: "plain", fallbackReason: "none", requiresExplicitUserApproval: true }, requireExplicit: true });
      gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, nativeWebContents as never);
    });
    const nativeWebContents = { isDestroyed: () => false, send };
    gate = new ApprovalGate(nativeWebContents as never);
    const executor = new ToolExecutor(registry, undefined, pm, undefined, gate);
    const result = await executor.executeAll([{ id: "explicit-host", name: "bash", input: { command: "echo host", executionMode: "host", justification: "Use the host execution environment" } }], { sessionId: "explicit-host", permissionContext: permissionContext() });
    expect(sentApprovalCards({ send })).toHaveLength(1);
    expect(executed).toHaveBeenCalledOnce();
    expect(executed.mock.calls[0][0].hostShellExecutionPermit).toBeDefined();
    const checkedContext = checkDetailed.mock.calls[0]?.[4];
    expect(checkedContext?.hostShellExecutionPlan).toBe(executed.mock.calls[0][0].hostShellExecutionPlan);
    const { environmentSnapshot: checkedEnvironment, ...executionFlags } = checkedContext!.shellExecution!;
    expect(executionFlags).toEqual({ runsSandboxed: false, pathPolicyRelaxations: [] });
    expect(checkedEnvironment !== undefined).toBe(true);
    expect(environmentMatched).toBe(true);
    expect(checkedEnvironmentKeys).toEqual(issuedEnvironmentKeys);
    expect(pwdMatched).toBe(true);
    expect(privateMarkerRemoved).toBe(true);
    expect(result[0].is_error).toBeUndefined();
  });

  it("does not turn a hard denial into explicit host approval", async () => {
    fullDarwinAsrt();
    const executed = vi.fn();
    const registry = shellProbeRegistry(executed);
    const { gate, send } = gateResolving("allow-once");
    const executor = new ToolExecutor(registry, undefined, pmReturning({ decision: "deny", reason: "hard policy denial", layer: 1 }), undefined, gate);
    const result = await executor.executeAll([{ id: "explicit-host-deny", name: "bash", input: { command: "echo host", executionMode: "host", justification: "Use the host execution environment" } }], { sessionId: "executor-windows-partial-shell-session", permissionContext: permissionContext() });
    expect(result[0].is_error).toBe(true);
    expect(executed).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["headless", "remote"])("refuses %s host requests without valid native directory authorization", async (origin) => {
    fullDarwinAsrt();
    const executed = vi.fn();
    const registry = shellProbeRegistry(executed);
    const { gate, send } = gateResolving("allow-once");
    const executor = new ToolExecutor(registry, undefined, pmReturning({ decision: "allow", reason: "ordinary allow", layer: 6 }), undefined, gate);
    const context = origin === "headless" ? { headless: true } : { remoteControllerAuthority: { kind: "tailnet-controller" as const, actorId: "tailnet:fixture" as const } };
    const result = await executor.executeAll([{ id: "unavailable-host", name: "bash", input: { command: "echo host", cwd: "/outside-host-request", executionMode: "host", justification: "Use the host environment" } }], { sessionId: "executor-windows-partial-shell-session", permissionContext: permissionContext(context) });
    expect(result[0].is_error).toBe(true);
    expect(result[0].content.toLowerCase()).toMatch(/host policy authorization|remote controller|remote-controller/);
    expect(send).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  it("allows and audits a headless explicit host request under a real allow-mode policy", async () => {
    fullDarwinAsrt();
    const audit = recordingAuditLogger();
    const executed = vi.fn();
    const registry = shellProbeRegistry(executed);
    const { gate, send } = gateResolving("allow-once", audit.auditLogger);
    const pm = new PermissionManager("/tmp/nonexistent-headless-host-allow.json");
    pm.setMode("allow");
    const executor = new ToolExecutor(registry, undefined, pm, undefined, gate, undefined, audit.auditLogger);
    const result = await executor.executeAll([{ id: "headless-host", name: "bash", input: { command: "echo host", executionMode: "host", justification: "Use the host environment" } }], { sessionId: "executor-windows-partial-shell-session", permissionContext: permissionContext({ headless: true }) });
    expect(result[0].is_error).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect(executed).toHaveBeenCalledOnce();
    expect(executed.mock.calls[0][0].hostShellExecutionPermit).toBeDefined();
    expect(audit.permissionEntries.some((entry) => entry.decision === "allow")).toBe(true);
    expect(audit.permissionEntries.some((entry) => entry.decision === "deny")).toBe(false);
  });

  it("returns a recoverable tool error for malformed explicit host input", async () => {
    fullDarwinAsrt();
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const result = await new ToolExecutor(registry).executeAll([{ id: "malformed-host", name: "bash", input: { command: "echo host", executionMode: "host", justification: " " } }], { sessionId: "executor-windows-partial-shell-session", permissionContext: permissionContext() });
    expect(result[0].is_error).toBe(true);
    expect(result[0].content).toContain("nonblank justification");
  });

  it("threads one sealed full-ASRT plan through the interactive reviewer and cache key", async () => {
    fullDarwinAsrt();
    let executedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
    let reviewerInput: import("../../permissions/permission-manager.js").ReviewerDispatchInput | undefined;
    const registry = new ToolRegistry();
    registry.register(shellProbe((ctx) => { executedPlan = ctx.hostShellExecutionPlan; }));

    const pm = new PermissionManager("/tmp/nonexistent-full-asrt-review.json");
    pm.setMode("auto");
    const checkDetailed = vi.spyOn(pm, "checkDetailed");
    setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
    pm.dispatchReviewer = vi.fn(async (_toolName, input) => {
      reviewerInput = input;
      return {
        verdict: { level: "low" as const, reason: "full ASRT reviewed" },
        cacheReason: "miss-not-found" as const,
        outcome: "fresh" as const,
        judge: reviewerJudgeOutcomeForTest("allow", "full ASRT reviewed"),
      };
    }) as never;

    const result = await new ToolExecutor(registry, undefined, pm).executeAll(
      [{ id: "full-asrt-review", name: "bash", input: { command: "workspace_tool reviewed" } }],
      { sessionId: "full-asrt", permissionContext: permissionContext() },
    );

    expect(pm.dispatchReviewer).toHaveBeenCalledTimes(1);
    expect(result[0]?.is_error).toBeUndefined();
    expect(executedPlan).toMatchObject({
      platform: "darwin",
      requestedSandbox: true,
      mode: "asrt",
      fallbackReason: "none",
      capability: { kind: "asrt", confines: { filesystem: true, process: true, network: true } },
    });
    expect(reviewerInput?.hostShellExecutionPlan).toBe(executedPlan);
    expect(checkDetailed.mock.calls[0]?.[4]).toMatchObject({
      hostShellExecutionPlan: executedPlan,
      shellExecution: { runsSandboxed: true },
    });
    expect(reviewerInput?.approvalCacheKey).toContain(
      "host-shell-execution-plan-cache/v4:",
    );
  });

  it.each(["default", "auto", "allow"] as const)("honors prefix and tool allows for a partial-plan host shell in %s mode", async (mode) => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-plan-b.json");
    pm.setMode(mode);
    pm.setRules([{ pattern: "Bash(echo *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }, { pattern: "bash", action: "allow" }]);
    setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
    pm.dispatchReviewer = vi.fn() as never;
    const requestAndWait = vi.fn();
    const result = await new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never).executeAll(
      [{ id: "partial-shell-rule", name: "bash", input: { command: "echo no-run" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0].hostShellExecutionPermit).toBeDefined();
    expect(result[0]?.is_error).toBeUndefined();
  });

  it.each(["default", "auto", "allow"] as const)("uses the ordinary %s policy for a partial-plan host shell without a rule", async (mode) => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-mode.json");
    pm.setMode(mode);
    setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
    pm.dispatchReviewer = vi.fn(async () => ({ verdict: { level: "low" as const, reason: "Bounded host effect" }, cacheReason: "miss-not-found" as const,
      outcome: "fresh" as const, judge: reviewerJudgeOutcomeForTest("allow", "Bounded host effect") })) as never;
    const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "deny-once" as const }));
    const result = await new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never).executeAll(
      [{ id: "partial-shell-mode", name: "bash", input: { command: "echo no-run" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );
    expect(pm.dispatchReviewer).toHaveBeenCalledTimes(mode === "auto" ? 1 : 0);
    expect(requestAndWait).toHaveBeenCalledTimes(mode === "default" ? 1 : 0);
    expect(execute).toHaveBeenCalledTimes(mode === "default" ? 0 : 1);
    if (mode === "default") {
      expect(result[0]?.is_error).toBe(true);
      expect(requestAndWait.mock.calls[0]?.[0]).toMatchObject({ executionPlan: { fallbackReason: "windows-partial-shell-acl-unsafe" } });
      expect((requestAndWait.mock.calls[0]?.[0] as ApprovalRequest).allowedChoices).toBeUndefined();
    } else {
      expect(execute.mock.calls[0][0].hostShellExecutionPermit).toBeDefined();
      expect(result[0]?.is_error).toBeUndefined();
    }
  });

  // The card a Plan B shell raises, as the host sends it to the renderer: Deny, Allow once, This session, This project
  // and Always, the three saves all naming the one exact Bash(<command>) rule the host derived.
  it.each(["strict", "default"] as const)("sends a Plan B shell card that offers the session, project and always saves in %s mode", async (mode) => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-plan-b-card.json");
    pm.setMode(mode);
    let gate: ApprovalGate;
    const send = vi.fn((channel: string, request: ApprovalRequest) => {
      if (channel !== "ave:approval:request") return;
      gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, nativeWebContents as never);
    });
    const nativeWebContents = { isDestroyed: () => false, send };
    gate = new ApprovalGate(nativeWebContents as never);
    const result = await new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
      [{ id: "partial-shell-card", name: "bash", input: { command: "echo plan-b" } }],
      { sessionId: "partial-shell-card", permissionContext: permissionContext() },
    );

    const cards = sentApprovalCards<ApprovalRequest>({ send } as never);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.executionPlan).toMatchObject({ fallbackReason: "windows-partial-shell-acl-unsafe", requiresExplicitUserApproval: true });
    // No once/deny narrowing: the renderer shows the full grid.
    expect(card.allowedChoices).toBeUndefined();
    expect(card.reviewerVerdict).toBeUndefined();
    // Allow for session (the conversation is known), this project and everywhere (persistent saves allowed), and Always deny, all for the exact rule.
    expect(card.shellRule).toEqual({
      dialect: "bash",
      exactRule: "Bash(echo plan-b)",
      denyRule: "Bash(echo plan-b)",
      denyAllowed: true,
      projectCwd: expect.any(String),
      projectRoot: expect.any(String),
      sessionAllowed: true,
      persistentAllowed: true,
    });
    expect(card.persistentAllowAllowed).toBe(true);
    expect(card.sessionId).toBe("partial-shell-card");
    expect(execute).toHaveBeenCalledOnce();
    expect(result[0]?.is_error).toBeUndefined();
  });

  // Explicit matching rules authorize the action before mode review; the native permit stays action-bound.
  it.each(["default", "allow"] as const)("runs a Plan B shell on its exact Bash(<command>) rule in %s mode without a card", async (mode) => {
    partialWindowsAsrt();
    let observedPermit: unknown;
    const execute = vi.fn((ctx: import("../types.js").ToolExecutionContext) => { observedPermit = ctx.hostShellExecutionPermit; });
    const registry = shellProbeRegistry(execute);
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-plan-b-rule.json");
    pm.setMode(mode);
    pm.setRules([{ pattern: "Bash(echo no-run)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
    setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
    pm.dispatchReviewer = vi.fn() as never;
    const requestAndWait = vi.fn();
    const result = await new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never).executeAll(
      [{ id: "partial-shell-exact-rule", name: "bash", input: { command: "echo no-run" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );

    expect(pm.dispatchReviewer).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(observedPermit).toBeDefined();
    expect(result[0]?.is_error).toBeUndefined();
  });

  // Headless default mode honors a prefix rule and denies unmatched actions without a human.
  it.each([true, false])("runs a headless partial-plan shell only when its default-mode rule covers it (rule %s)", async (withRule) => {
    partialWindowsAsrt();
    let observedPermit: unknown;
    const execute = vi.fn((ctx: import("../types.js").ToolExecutionContext) => { observedPermit = ctx.hostShellExecutionPermit; });
    const registry = shellProbeRegistry(execute);
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-plan-b-headless.json");
    pm.setMode("default");
    pm.setRules(withRule ? [{ pattern: "Bash(echo *)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }] : []);
    pm.setReviewer({ classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
    pm.dispatchReviewer = vi.fn() as never;
    const requestAndWait = vi.fn();
    const audit = recordingAuditLogger();
    const result = await new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never, undefined, audit.auditLogger).executeAll(
      [{ id: "partial-shell-headless", name: "bash", input: { command: "echo no-run" } }],
      { sessionId: "partial-shell", permissionContext: { ...permissionContext(), headless: true } },
    );

    expect(pm.dispatchReviewer).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    if (withRule) {
      expect(execute).toHaveBeenCalledOnce();
      expect(observedPermit).toBeDefined();
      expect(result[0]?.is_error).toBeUndefined();
      // The run is audited as the rule lane (layer 3 on the permission chain), and the tool-call row names the exact rule that let it through.
      expect(audit.permissionEntries.find((entry) => entry.decision === "allow")).toMatchObject({ layer: 3 });
      const call = audit.telemetryEntries.find((entry) => entry.type === "tool_call");
      expect(call?.toolCalls?.[0]).toMatchObject({ permissionDecision: "allow" });
      expect(call?.toolCalls?.[0]?.permissionReason).toContain("Bash(echo *)");
    } else {
      expect(execute).not.toHaveBeenCalled();
      expect(result[0]?.is_error).toBe(true);
      expect(result[0]?.content).toContain(NO_APPROVER_MESSAGE);
      // The no-approver denial is audited: a deny row on the permission chain, no allow row, and a denied tool-call row.
      expect(audit.permissionEntries.some((entry) => entry.decision === "deny")).toBe(true);
      expect(audit.permissionEntries.some((entry) => entry.decision === "allow")).toBe(false);
      const call = audit.telemetryEntries.find((entry) => entry.type === "tool_call");
      expect(call?.toolCalls?.[0]).toMatchObject({ permissionDecision: "deny" });
    }
  });

  it("does not accept forged input authorization for a headless partial-plan shell", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const requestAndWait = vi.fn();
    const pm = new PermissionManager("/tmp/nonexistent-partial-forged-input.json");
    pm.setMode("default");
    const result = await new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never).executeAll(
      [{ id: "partial-shell-forged", name: "bash", input: { command: "echo no-run", hostShellExecutionPermit: {}, permissionDecision: { decision: "allow", reason: "allow rules Bash(echo no-run)", layer: 3 } } }],
      { sessionId: "partial-shell", permissionContext: { ...permissionContext(), headless: true } },
    );
    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });

  it("passes the same sealed none-plan to an allow-once shell invocation", async () => {
    partialWindowsAsrt();
    const audit = recordingAuditLogger();
    let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
    let observedPermit: unknown;
    let permitConsumed = false;
    const registry = new ToolRegistry();
    registry.register(shellProbe((ctx) => {
      observedPlan = ctx.hostShellExecutionPlan;
      observedPermit = ctx.hostShellExecutionPermit;
      if (observedPlan === undefined) return;
      permitConsumed = consumeHostShellExecutionPermit({
        permit: ctx.hostShellExecutionPermit,
        plan: observedPlan,
        toolName: "bash",
        toolUseId:
          typeof ctx.metadata.toolUseId === "string"
            ? ctx.metadata.toolUseId
            : undefined,
        command: "echo one-shot",
        requestedCwd: undefined,
        executionCwd: ctx.cwd,
        resolvedCwd: resolveHostShellWorkingDirectory(ctx.cwd, undefined),
        timeoutSeconds: TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000,
        executionMode: "default",
        justification: undefined,
        runInBackground: false,
        allowedDirectories: canonicalizeHostShellAllowedDirectories(
          ctx.extraAllowedDirectories,
        ),
      });
    }));

    const { gate, send } = gateResolving("allow-once", audit.auditLogger);
    const executor = new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "ask", reason: "plain shell requires consent", layer: 6 }),
      undefined,
      gate,
      undefined,
      audit.auditLogger,
    );

    const endMetas: ToolCallMeta[] = [];
    const result = await executor.executeAll(
      [{ id: "partial-shell-allow", name: "bash", input: { command: "echo one-shot" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext(),
        callbacks: {
          onToolEnd: (_name, _content, _isError, meta) => endMetas.push(meta),
        },
      },
    );
    expect(permitConsumed).toBe(true);

    const cards = sentApprovalCards<ApprovalRequest>({ send } as never);
    expect(cards).toHaveLength(1);
    const rendererApproval = cards[0]!;
    // Canonical host shells expose only the sealed, allowlist projection. The raw capability carries a free-form host reason and must never cross IPC.
    expect(rendererApproval.sandboxCapability).toBeUndefined();
    expect(rendererApproval.executionPlan).toMatchObject({
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(JSON.stringify(rendererApproval.executionPlan)).not.toContain("echo one-shot");
    expect(JSON.stringify(rendererApproval.executionPlan)).not.toContain(
      "Windows ASRT partial shell confinement is unavailable",
    );
    expect(observedPermit).toBeDefined();
    expect(observedPlan).toMatchObject({
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(result[0]?.is_error).toBeUndefined();

    expect(observedPlan).toBeDefined();
    const auditPlan = getHostShellExecutionPlanAuditProjection(observedPlan!);
    expect(result[0]?.executionPlan).toBe(auditPlan);
    expect(endMetas).toHaveLength(1);
    expect(endMetas[0]?.executionPlan).toBe(auditPlan);
    const resultPlanJson = JSON.stringify(result[0]?.executionPlan);
    expect(resultPlanJson).not.toContain("echo one-shot");
    expect(resultPlanJson).not.toContain("Windows ASRT partial shell confinement is unavailable");
    expect(resultPlanJson).not.toContain("hostShellExecutionPermit");
    const ask = audit.permissionEntries.find((entry) => entry.decision === "ask");
    const terminal = audit.permissionEntries.find((entry) => entry.decision === "allow");
    const telemetry = audit.telemetryEntries.find(
      (entry) => entry.type === "tool_call" && entry.toolCalls?.[0]?.name === "bash",
    )?.toolCalls?.[0];
    for (const surface of [ask, terminal, telemetry]) {
      expect(surface).toBeDefined();
      expect(surface?.toolUseId).toBe("partial-shell-allow");
      expect(surface?.executionPlan).toBe(auditPlan);
    }
    const approvalAuditText = audit.telemetryEntries
      .filter((entry) => entry.type === "approval")
      .map((entry) => entry.input ?? entry.output ?? "")
      .join("\n");
    expect(approvalAuditText).toContain(`executionPlan.identity=${auditPlan.identity}`);
    expect(approvalAuditText).not.toContain("echo one-shot");
    expect(approvalAuditText).not.toContain("requestedCwd");
    expect(JSON.stringify(auditPlan)).not.toContain("reason");
  });

  it("preserves the Plan-B projection across ask, deny terminal audit, and telemetry", async () => {
    partialWindowsAsrt();
    const executed = vi.fn();
    const registry = shellProbeRegistry(executed);
    const audit = recordingAuditLogger();
    const { gate } = gateResolving("deny-once", audit.auditLogger);

    const executor = new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "ask", reason: "plain shell requires consent", layer: 6 }),
      undefined,
      gate,
      undefined,
      audit.auditLogger,
    );

    const endMetas: ToolCallMeta[] = [];
    const result = await executor.executeAll(
      [{ id: "partial-shell-audit-deny", name: "bash", input: { command: "echo denied" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext(),
        callbacks: {
          onToolEnd: (_name, _content, _isError, meta) => endMetas.push(meta),
        },
      },
    );

    expect(executed).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
    const ask = audit.permissionEntries.find((entry) => entry.decision === "ask");
    const terminal = audit.permissionEntries.find((entry) => entry.decision === "deny");
    const telemetry = audit.telemetryEntries.find(
      (entry) => entry.type === "tool_call" && entry.toolCalls?.[0]?.name === "bash",
    )?.toolCalls?.[0];
    expect(ask?.executionPlan).toBeDefined();
    const expectedPlan = ask!.executionPlan;
    expect(result[0]?.executionPlan).toBe(expectedPlan);
    expect(endMetas).toHaveLength(1);
    expect(endMetas[0]?.executionPlan).toBe(expectedPlan);
    const deniedResultPlanJson = JSON.stringify(result[0]?.executionPlan);
    expect(deniedResultPlanJson).not.toContain("echo denied");
    expect(deniedResultPlanJson).not.toContain("Windows ASRT partial shell confinement is unavailable");
    expect(deniedResultPlanJson).not.toContain("hostShellExecutionPermit");
    for (const surface of [ask, terminal, telemetry]) {
      expect(surface).toBeDefined();
      expect(surface?.toolUseId).toBe("partial-shell-audit-deny");
      expect(surface?.executionPlan).toBe(expectedPlan);
    }
    const approvalAuditText = audit.telemetryEntries
      .filter((entry) => entry.type === "approval")
      .map((entry) => entry.input ?? entry.output ?? "")
      .join("\n");
    expect(approvalAuditText).toContain(`executionPlan.identity=${expectedPlan.identity}`);
    expect(approvalAuditText).not.toContain("echo denied");
  });
  it("keeps the safe projection on a permitless requested-sandbox error", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    let request: ApprovalRequest | undefined;
    // This imitates an untrusted/stale gate response: it says allow-once but carries no host-issued receipt bound to the private action description.
    const requestAndWait = vi.fn(async (pending: ApprovalRequest) => {
      request = pending;
      return { requestId: pending.id, choice: "allow-once" as const };
    });
    const endMetas: ToolCallMeta[] = [];
    const result = await new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "ask", reason: "plain shell requires consent", layer: 6 }),
      undefined,
      { requestAndWait } as never,
    ).executeAll(
      [{ id: "partial-shell-permitless", name: "bash", input: { command: "echo receiptless" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext(),
        callbacks: {
          onToolEnd: (_name, _content, _isError, meta) => endMetas.push(meta),
        },
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(request?.executionPlan).toBeDefined();
    expect(result[0]?.is_error).toBe(true);
    expect(result[0]?.content).toContain("no host policy authorization or verified approval receipt");
    expect(result[0]?.executionPlan).toBe(request!.executionPlan);
    expect(endMetas).toHaveLength(1);
    expect(endMetas[0]?.executionPlan).toBe(request!.executionPlan);
    const permitlessResultPlanJson = JSON.stringify(result[0]?.executionPlan);
    expect(permitlessResultPlanJson).not.toContain("Windows ASRT partial shell confinement is unavailable");
    expect(permitlessResultPlanJson).not.toContain("hostShellExecutionPermit");
    expect(permitlessResultPlanJson).not.toContain('"reason"');
  });

  it("fails closed when neither PermissionManager nor ApprovalGate is present", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const executor = new ToolExecutor(registry, undefined, undefined, undefined, undefined);

    const result = await executor.executeAll(
      [{ id: "partial-shell-no-gates", name: "bash", input: { command: "echo blocked" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });

  it("does not attach a Plan-B capability to a dynamic bash lookalike", async () => {
    partialWindowsAsrt();
    let observedContext: import("../types.js").ToolExecutionContext | undefined;
    const registry = new ToolRegistry();
    registry.register(dynamicShellProbe((ctx) => { observedContext = ctx; }));
    const executor = new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "allow", reason: "ordinary dynamic tool", layer: 6 }),
    );

    const result = await executor.executeAll(
      [{ id: "dynamic-bash-lookalike", name: "bash", input: { command: "echo ordinary" } }],
      { sessionId: "partial-shell", permissionContext: permissionContext() },
    );

    expect(observedContext?.hostShellExecutionPlan).toBeUndefined();
    expect(observedContext?.hostShellExecutionPermit).toBeUndefined();
    expect(result[0]?.is_error).toBeUndefined();
  });

  it("fails closed before strict headless reviewer dispatch", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const pm = new PermissionManager("/tmp/nonexistent-windows-partial-headless.json");
    pm.setMode("strict");
    const requestAndWait = vi.fn();
    const executor = new ToolExecutor(
      registry,
      undefined,
      pm,
      undefined,
      { requestAndWait } as never,
    );

    const result = await executor.executeAll(
      [{ id: "partial-shell-headless", name: "bash", input: { command: "echo headless" } }],
      {
        sessionId: "partial-shell",
        permissionContext: permissionContext({ headless: true }),
      },
    );

    expect(requestAndWait).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });

  // Unavailable confinement follows normal host review while retaining its substrate projection.
  it.each(["darwin", "linux", "win32"] as const)(
    "reviews a requested-unavailable %s shell and preserves the fallback when a rule later authorizes it",
    async (platform) => {
      requestedSandboxUnavailable(platform);
      let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
      const execute = vi.fn((ctx: import("../types.js").ToolExecutionContext) => {
        observedPlan = ctx.hostShellExecutionPlan;
      });
      const registry = new ToolRegistry();
      registry.register(shellProbe(execute));
      const pm = new PermissionManager(`/tmp/nonexistent-requested-unavailable-${platform}.json`);
      pm.setMode("auto");
      setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
      pm.dispatchReviewer = vi.fn(async () => ({ verdict: { level: "high" as const, reason: "Host effect needs a human" }, cacheReason: "miss-not-found" as const,
        outcome: "fresh" as const, judge: reviewerJudgeOutcomeForTest("ask", "Host effect needs a human") })) as never;
      const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "deny-once" as const }));
      const executor = new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never);
      const run = (id: string) => executor.executeAll(
        [{ id, name: "bash", input: { command: "echo reviewed" } }],
        { sessionId: `requested-unavailable-${platform}`, permissionContext: permissionContext() },
      );

      const asked = await run(`requested-unavailable-${platform}-ask`);
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(asked[0]?.is_error).toBe(true);

      pm.setRules([{ pattern: "Bash(echo reviewed)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
      const result = await run(`requested-unavailable-${platform}-rule`);
      expect(pm.dispatchReviewer).toHaveBeenCalledTimes(1);
      expect(requestAndWait).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0].hostShellExecutionPermit).toBeUndefined();
      expect(observedPlan).toMatchObject({
        platform,
        requestedSandbox: true,
        mode: "plain",
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: false,
        capability: {
          kind: "none",
          confines: { filesystem: false, process: false, network: false },
        },
      });
      expect(result[0]?.is_error).toBeUndefined();
      expect(result[0]?.executionPlan).toMatchObject({ fallbackReason: "requested-sandbox-unavailable" });
    },
  );

  // The unavailable-confinement plan keeps normal policy authorization without adding an unrelated native permit.
  it.each(["darwin", "linux", "win32"] as const)(
    "runs requested-unavailable %s shells on a policy allow without a card or permit",
    async (platform) => {
      requestedSandboxUnavailable(platform);
      let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
      let observedPermit: unknown = "unset";
      const registry = new ToolRegistry();
      registry.register(shellProbe((ctx) => {
        observedPlan = ctx.hostShellExecutionPlan;
        observedPermit = ctx.hostShellExecutionPermit;
      }));
      const { gate, send } = gateResolving("deny-once");
      const result = await new ToolExecutor(
        registry,
        undefined,
        pmReturning({ decision: "allow", reason: "exact allow rule", layer: 3 }),
        undefined,
        gate,
      ).executeAll(
        [{ id: `requested-unavailable-allow-${platform}`, name: "bash", input: { command: "echo normal-rules" } }],
        { sessionId: `requested-unavailable-allow-${platform}`, permissionContext: permissionContext() },
      );

      expect(sentApprovalCards<ApprovalRequest>({ send } as never)).toHaveLength(0);
      expect(observedPermit).toBeUndefined();
      expect(observedPlan).toMatchObject({
        platform,
        requestedSandbox: true,
        mode: "plain",
        fallbackReason: "requested-sandbox-unavailable",
        requiresExplicitUserApproval: false,
      });
      expect(result[0]?.is_error).toBeUndefined();
    },
  );

  it.each(["darwin", "linux", "win32"] as const)(
    "keeps explicitly sandbox-off %s shells on the normal approval route",
    async (platform) => {
      explicitlySandboxOff(platform);
      let observedPlan: import("../../permissions/host-shell-execution-plan.js").HostShellExecutionPlan | undefined;
      const execute = vi.fn((ctx: import("../types.js").ToolExecutionContext) => {
        observedPlan = ctx.hostShellExecutionPlan;
      });
      const registry = new ToolRegistry();
      registry.register(shellProbe(execute));
      const requestAndWait = vi.fn();
      const pm = pmReturning({ decision: "allow", reason: "ordinary explicit-off path", layer: 6 });
      const checkDetailed = vi.spyOn(pm, "checkDetailed");
      const result = await new ToolExecutor(
        registry,
        undefined,
        pm,
        undefined,
        { requestAndWait } as never,
      ).executeAll(
        [{ id: `explicit-off-${platform}`, name: "bash", input: { command: "echo normal" } }],
        { sessionId: `explicit-off-${platform}`, permissionContext: permissionContext() },
      );

      expect(requestAndWait).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(checkDetailed.mock.calls[0]?.[4]).toMatchObject({
        hostShellExecutionPlan: observedPlan,
        shellExecution: { runsSandboxed: false },
      });
      expect(observedPlan).toMatchObject({
        platform,
        requestedSandbox: false,
        mode: "plain",
        fallbackReason: "disabled-by-setting",
        requiresExplicitUserApproval: false,
      });
      expect(result[0]?.is_error).toBeUndefined();
    },
  );
});
