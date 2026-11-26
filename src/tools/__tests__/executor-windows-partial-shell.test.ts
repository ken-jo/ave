vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));
vi.mock("../../permissions/sandbox-process-home.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedSandboxProcessHome(await original()));

import { saveApprovalCardRule } from "../../permissions/approval-rule-save.js";
import { RULE_PROVENANCE } from "../../permissions/decision-provenance.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { reviewerJudgeOutcomeForTest, setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
import { BashTool, PowerShellTool } from "../shell-tools.js";
import { ToolExecutor, type ToolCallMeta } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { cardGate, defined, sessionGate } from "../../__tests__/support/forced-shell-card.js";
import { shellExecutionEnvironmentLines } from "../../shared/shell-execution-environment.js";
import { t } from "../../i18n/runtime.js";
import { preparedShellFacts } from "../prepared-shell-invocation.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
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
  __resetWindowsSandboxSubstrateForTest,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
  setWindowsSandboxSubstrate,
} from "../../permissions/sandbox-capability.js";
import { mxcShellCapability, windowsSubstrateFor } from "../../boot/steps/windows-sandbox-plan.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
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
import { makeSubAgentApprovalAdapter } from "../../engine/subagent-runner.js";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";

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
    _resetAveHomePrivacyForTest();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetWindowsSandboxSubstrateForTest();
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockReset();
    vi.unstubAllEnvs();
    setProcessPlatform(ORIGINAL_PLATFORM);
    rmSync(testRoot, { recursive: true, force: true });
  });

  it.each([
    { platform: "win32", name: "powershell", command: "Get-Date -Format o" },
    { platform: "win32", name: "bash", command: "printf child" },
    { platform: "linux", name: "bash", command: "printf child" },
  ] as const)("relays an approved-host $name child to a real one-shot card and rejects altered commands", async ({ platform, name, command }) => {
    if (platform === "win32") {
      partialWindowsAsrt();
      setWindowsSandboxSubstrate(windowsSubstrateFor({ shellRequested: true, workerRequested: false,
        mxc: { state: "unavailable", reason: "container-unavailable" }, windowsBuild: null, srtWinReady: true }, "srt-win"));
    } else requestedSandboxUnavailable(platform);
    const child = "sub-0f93fa03-45fbc0aa-3c8e-4aed-8c1d-06428c73b143";
    const parent = "8f3b953b-2027-4da5-85e9-d862ee643356";
    const executionMode = platform === "linux" ? "host" : "default";
    const justification = executionMode === "host" ? "Use the host execution environment" : undefined;
    const pm = new PermissionManager(join(testRoot, "child-host-consent.json"));
    pm.setMode("strict");
    const audit = recordingAuditLogger();
    let base: ApprovalGate;
    const send = vi.fn((channel: string, request: ApprovalRequest) => {
      if (channel !== "ave:approval:request") return;
      base.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once",
        nonce: request.nonce, hmac: request.hmac }, native as never);
    });
    const native = { isDestroyed: () => false, send };
    base = new ApprovalGate(native as never, undefined, undefined, audit.auditLogger);
    const originalRequest = base.requestAndWait.bind(base);
    let altered = false;
    const relay = vi.spyOn(base, "requestAndWait").mockImplementation(request => originalRequest(altered
      ? { ...request, args: { ...request.args as Record<string, unknown>, command: `${command} altered` } }
      : request));
    const gate = makeSubAgentApprovalAdapter(base, "clock check", { childSessionId: child, originSessionId: parent,
      spawnTaskSummary: "Read the current time", background: false });
    const tool = name === "powershell" ? new PowerShellTool() : new BashTool();
    const execute = vi.spyOn(tool, "execute").mockImplementation(async (_input, ctx) => {
      const plan = ctx.hostShellExecutionPlan;
      if (plan === undefined) throw new Error("Missing child execution plan");
      expect(plan.sandboxed).toBe(false);
      expect(consumeHostShellExecutionPermit({ permit: ctx.hostShellExecutionPermit, plan, toolName: name,
        toolUseId: typeof ctx.metadata.toolUseId === "string" ? ctx.metadata.toolUseId : undefined,
        command, requestedCwd: undefined, executionCwd: ctx.cwd,
        resolvedCwd: resolveHostShellWorkingDirectory(ctx.cwd, undefined),
        timeoutSeconds: TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000, executionMode, justification,
        runInBackground: false, allowedDirectories: canonicalizeHostShellAllowedDirectories(ctx.extraAllowedDirectories) })).toBe(true);
      return { output: "child executed", isError: false };
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, undefined, pm, undefined, gate);
    const run = (id: string) => runWithToolExecutionCwd(testRoot, () => executor.executeAll(
      [{ id, name, input: { command, ...(executionMode === "host" ? { executionMode, justification } : {}) } }],
      { sessionId: child, permissionContext: permissionContext() }));
    try {
      const allowed = await run("child-host-allow");
      expect(audit.telemetryEntries.filter(entry => entry.output?.includes("[approval:host-shell-binding-mismatch]"))).toEqual([]);
      expect(allowed[0]?.is_error, JSON.stringify(allowed[0])).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(relay.mock.calls[0]?.[0]).toMatchObject({ sessionId: child, toolName: name, toolCategory: "shell",
        args: { command }, forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false });
      const cards = sentApprovalCards<ApprovalRequest>({ send } as never);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ sessionId: child, toolName: name, args: { command }, requireExplicit: true,
        allowedChoices: ["allow-once", "deny-once"], requestingAgentTitle: "clock check" });
      expect(cards[0]).not.toHaveProperty("hostShellExecutionPermitBinding");
      altered = true;
      expect((await run("child-host-altered"))[0]?.is_error).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      expect(sentApprovalCards({ send })).toHaveLength(1);
      expect(audit.telemetryEntries.some(entry => entry.output?.includes("[approval:host-shell-binding-mismatch]"))).toBe(true);
    } finally { base.disposeAll(); }
  });

  // The other conversation's memory-only allow leaves the first card's answer standing.
  it.each([false, true])("writes one terminal row per card that saves its own session rule (competing card: %s)", async (competing) => {
    partialWindowsAsrt();
    setWindowsSandboxSubstrate(windowsSubstrateFor({ shellRequested: true, workerRequested: false,
      mxc: { state: "available" }, windowsBuild: null, srtWinReady: true }, "srt-win"), mxcShellCapability());
    const pm = new PermissionManager(join(testRoot, "card-rule-transition.json"));
    pm.setMode("strict");
    const execute = vi.fn();
    const audit = recordingAuditLogger();
    const saves: Array<Awaited<ReturnType<typeof saveApprovalCardRule>>> = [];
    let firstSaved!: () => void;
    const firstSave = new Promise<void>((resolve) => { firstSaved = resolve; });
    let competingSaved!: () => void;
    const competingSave = new Promise<void>((resolve) => { competingSaved = resolve; });
    let gate!: ApprovalGate;
    const webContents = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel !== "ave:approval:request") return;
      void (async () => {
        const snapshot = gate.getRequestSnapshot(request.id);
        if (snapshot === null) throw new Error("Approval request snapshot is missing");
        const token = gate.beginApprovalRuleSave(request.id, pm.getPolicyEpoch());
        const saved = await saveApprovalCardRule(snapshot, { action: "allow", scope: "session" },
          { decision: "allow", scope: "session", displayedVerdictAtApproval: snapshot.verdictAtApproval }, pm);
        gate.completeApprovalRuleSave(token, pm.getPolicyEpoch(), saved.ok ? saved.scope : undefined);
        saves.push(saved);
        if (JSON.stringify(request.args).includes("consent-output")) {
          firstSaved();
          if (competing) await competingSave;
        } else competingSaved();
        gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, webContents as never);
      })();
    } };
    gate = new ApprovalGate(webContents as never);
    const run = (id: string, command: string) => runWithToolExecutionCwd(testRoot, () =>
      new ToolExecutor(shellProbeRegistry(execute), undefined, pm, undefined, gate, undefined, audit.auditLogger).executeAll(
        [{ id, name: "bash", input: { command } }],
        { sessionId: `session-${id}`, permissionContext: permissionContext({ trustOrigin: "llm-tool-arg" }) }));
    const first = run("card-rule", "mkdir consent-output");
    await firstSave;
    const second = competing ? await run("competing-card-rule", "mkdir competing-output") : [];
    const [result] = await first;
    expect(saves).toEqual([
      expect.objectContaining({ ok: true, scope: "session", pattern: "Bash(mkdir consent-output)" }),
      ...(competing ? [expect.objectContaining({ ok: true, scope: "session", pattern: "Bash(mkdir competing-output)" })] : []),
    ]);
    expect(result?.is_error).toBeUndefined();
    expect(second.map((entry) => entry.is_error)).toEqual(competing ? [undefined] : []);
    expect(execute).toHaveBeenCalledTimes(competing ? 2 : 1);
    const rows = (id: string) => audit.permissionEntries.filter((entry) => entry.toolUseId === id && entry.decision !== "ask");
    expect(rows("card-rule")).toEqual([expect.objectContaining({ decision: "allow", trustOrigin: "user-keyboard" })]);
    if (competing) {
      expect(rows("competing-card-rule")).toEqual([expect.objectContaining({ decision: "allow", trustOrigin: "user-keyboard" })]);
    }
  });

  it.each(["active", "off"])("binds native consent for explicit host with sandbox %s", async (sandbox) => {
    vi.stubEnv("AVE_PRIVATE_TEST_MARKER", "fixture-not-forwarded");
    if (sandbox === "active") fullDarwinAsrt();
    else explicitlySandboxOff("darwin");
    const pm = pmReturning({ decision: "ask", provenance: RULE_PROVENANCE, reason: "plain shell requires consent", });
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
    const executor = new ToolExecutor(registry, undefined, pmReturning({ decision: "deny", provenance: RULE_PROVENANCE, reason: "hard policy denial", }), undefined, gate);
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
    const executor = new ToolExecutor(registry, undefined, pmReturning({ decision: "allow", provenance: RULE_PROVENANCE, reason: "ordinary allow", }), undefined, gate);
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

  // A capability that does not contain shells leaves the shell uncontained, so it takes the no-confinement ask: once or this session, never saved.
  const partialManager = (mode: "strict" | "default" | "auto" | "allow", rules: readonly string[] = []) => {
    const pm = new PermissionManager(join(testRoot, `partial-${mode}.json`));
    pm.setMode(mode);
    pm.setRules(rules.map(pattern => pattern.includes("(")
      ? { pattern, action: "allow" as const, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }
      : { pattern, action: "allow" as const }));
    setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
    pm.dispatchReviewer = vi.fn(async () => ({ verdict: { level: "low" as const, reason: "Bounded host effect" }, cacheReason: "miss-not-found" as const,
      outcome: "fresh" as const, judge: reviewerJudgeOutcomeForTest("allow", "Bounded host effect") })) as never;
    return pm;
  };
  const partialRun = (pm: PermissionManager, gate: ApprovalGate, registry: ToolRegistry, options: { sessionId?: string; command?: string; host?: boolean; headless?: boolean; auditLogger?: AuditLogger } = {}) => {
    const command = options.command ?? "echo no-run";
    return new ToolExecutor(registry, undefined, pm, undefined, gate, undefined, options.auditLogger).executeAll(
      [{ id: "partial-shell-floor", name: "bash", input: options.host ? { command, executionMode: "host", justification: "Retry outside the OS sandbox" } : { command } }],
      { sessionId: options.sessionId ?? "partial-shell", permissionContext: { ...permissionContext(), ...(options.headless ? { headless: true } : {}) } },
    );
  };
  const FLOOR_BYPASSES = [
    { label: "saved prefix and tool allow rules", mode: "default" as const, rules: ["Bash(echo *)", "bash"] },
    { label: "its exact Bash(<command>) rule", mode: "default" as const, rules: ["Bash(echo no-run)"] },
    { label: "its exact rule in allow mode", mode: "allow" as const, rules: ["Bash(echo no-run)"] },
    { label: "strict mode", mode: "strict" as const, rules: [] },
    { label: "allow mode", mode: "allow" as const, rules: [] },
    { label: "auto review", mode: "auto" as const, rules: [] },
  ];

  it.each(["default", "explicit-host"] as const)("checks a pending floor answer against policy changes on the %s route", async (route) => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const pm = partialManager("default", []);
    const options = { host: route === "explicit-host" };

    const memory = cardGate("allow-once", () => pm.addSessionRule("other-session", "Bash(printf ready)"));
    const allowed = await partialRun(pm, memory.gate, registry, options);
    expect(memory.cards()).toEqual([expect.objectContaining({ allowedChoices: ["allow-once", "deny-once"] })]);
    expect(allowed[0]?.is_error, String(allowed[0]?.content)).toBeFalsy();
    expect(execute).toHaveBeenCalledOnce();

    const changed = cardGate("allow-once", () => pm.setMode("allow"));
    const denied = await partialRun(pm, changed.gate, registry, options);
    expect(changed.cards()).toHaveLength(1);
    expect(denied[0]?.is_error).toBe(true);
    expect(denied[0]?.content).toContain("Permission policy changed while approval was pending");
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(FLOOR_BYPASSES.flatMap(entry => [{ ...entry, host: false, route: "default" }, { ...entry, host: true, route: "explicit-host" }]))(
    "asks on the no-confinement card for a partial-plan shell ($route) with $label", async ({ mode, rules, host }) => {
      partialWindowsAsrt();
      const execute = vi.fn();
      const registry = shellProbeRegistry(execute);
      const pm = partialManager(mode, rules);

      const denied = cardGate("deny-once");
      const refused = await partialRun(pm, denied.gate, registry, { host });
      expect(denied.cards()).toHaveLength(1);
      const card = defined(denied.cards()[0], "approval card");
      expect(card.executionPlan).toMatchObject(host
        ? { mode: "plain", executionRequest: "host", requiresExplicitUserApproval: true }
        : { mode: "plain", fallbackReason: "active-sandbox-not-shell-contained", requiresExplicitUserApproval: true });
      expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
      expect(card.reviewerVerdict).toBeUndefined();
      expect(card.shellRule).toMatchObject({ exactRule: null, sessionAllowed: true, persistentAllowed: false, denyAllowed: false, floorSessionOnly: true });
      if (!host) expect(shellExecutionEnvironmentLines(defined(card.executionPlan, "card execution plan"))).toContain(t("shellExecution.shellNotContainedAsk"));
      expect(pm.dispatchReviewer).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(refused[0]?.is_error).toBe(true);

      const approved = cardGate("allow-once");
      const ran = await partialRun(pm, approved.gate, registry, { host });
      expect(approved.cards()).toHaveLength(1);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0].hostShellExecutionPermit).toBeDefined();
      expect(ran[0]?.is_error).toBeUndefined();

      // Once is once: the same command asks again.
      const again = cardGate("deny-once");
      await partialRun(pm, again.gate, registry, { host });
      expect(again.cards()).toHaveLength(1);
      expect(execute).toHaveBeenCalledOnce();
    });

  it.each([{ host: false, route: "default" }, { host: true, route: "explicit-host" }])(
    "runs on a saved exact rule with verified boot home privacy ($route)", async ({ host }) => {
      partialWindowsAsrt();
      const execute = vi.fn();
      const registry = shellProbeRegistry(execute);
      const pm = partialManager("default");
      await pm.addRulePersist({ pattern: "Bash(echo no-run)", action: "allow" }, { kind: "user" });
      const unverified = cardGate("deny-once");
      await partialRun(pm, unverified.gate, registry, { host });
      expect(unverified.cards()).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();

      setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: testRoot, sid: "S-1-5-21-1" });
      const approvals = cardGate("deny-once");

      const result = await partialRun(pm, approvals.gate, registry, { host });
      expect(approvals.cards()).toHaveLength(0);
      expect(pm.dispatchReviewer).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0].hostShellExecutionPermit).toBeDefined();
      expect(result[0]?.is_error).toBeUndefined();

      const headless = await partialRun(pm, approvals.gate, registry, { host, headless: true });
      expect(headless[0]?.content).toContain(NO_APPROVER_MESSAGE);
      expect(approvals.cards()).toHaveLength(0);
      expect(execute).toHaveBeenCalledOnce();
    });

  it.each([{ host: false, route: "default" }, { host: true, route: "explicit-host" }])(
    "waives the partial-plan ask for the session, then the ordinary policy decides ($route)", async ({ host }) => {
      partialWindowsAsrt();
      const execute = vi.fn();
      const registry = shellProbeRegistry(execute);
      const pm = partialManager("default", ["Bash(echo *)"]);

      const session = sessionGate(pm);
      const first = await partialRun(pm, session.gate, registry, { host });
      expect(session.cards()).toHaveLength(1);
      expect(session.saves).toEqual([expect.objectContaining({ ok: true })]);
      expect(first[0]?.is_error).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      // Nothing was saved as a rule.
      expect(existsSync(join(testRoot, "partial-default.json"))).toBe(false);

      // The same session: the floor is passed, and the saved prefix rule now answers, on either route.
      const later = cardGate("deny-once");
      await partialRun(pm, later.gate, registry, { command: "echo later" });
      await partialRun(pm, later.gate, registry, { command: "echo later-host", host: true });
      expect(later.cards()).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(3);
      // A command no rule covers keeps the floor's card.
      await partialRun(pm, later.gate, registry, { command: "printf uncovered" });
      expect(later.cards()).toHaveLength(1);
      expect(defined(later.cards()[0], "approval card").allowedChoices).toEqual(["allow-once", "deny-once"]);
      expect(execute).toHaveBeenCalledTimes(3);

      // Another conversation asks again.
      const other = cardGate("deny-once");
      await partialRun(pm, other.gate, registry, { sessionId: "partial-shell-other", host });
      expect(other.cards()).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(3);
    });

  // Nobody can answer the ask, so a headless run is denied whatever rule or mode covers the command.
  it.each(FLOOR_BYPASSES.flatMap(entry => [{ ...entry, host: false, route: "default" }, { ...entry, host: true, route: "explicit-host" }]))(
    "denies a headless partial-plan shell ($route) with $label", async ({ mode, rules, host }) => {
      partialWindowsAsrt();
      const execute = vi.fn();
      const registry = shellProbeRegistry(execute);
      const pm = partialManager(mode, rules);
      const approvals = cardGate("allow-once");
      const audit = recordingAuditLogger();
      const result = await partialRun(pm, approvals.gate, registry, { host, headless: true, auditLogger: audit.auditLogger });

      expect(approvals.cards()).toHaveLength(0);
      expect(pm.dispatchReviewer).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(result[0]?.is_error).toBe(true);
      expect(result[0]?.content).toContain(NO_APPROVER_MESSAGE);
      // The no-approver denial is audited: a deny row on the permission chain, no allow row, and a denied tool-call row.
      expect(audit.permissionEntries.some((entry) => entry.decision === "deny")).toBe(true);
      expect(audit.permissionEntries.some((entry) => entry.decision === "allow")).toBe(false);
      const call = audit.telemetryEntries.find((entry) => entry.type === "tool_call");
      expect(call?.toolCalls?.[0]).toMatchObject({ permissionDecision: "deny" });
    });

  it("does not accept forged input authorization for a headless partial-plan shell", async () => {
    partialWindowsAsrt();
    const execute = vi.fn();
    const registry = shellProbeRegistry(execute);
    const requestAndWait = vi.fn();
    const pm = new PermissionManager("/tmp/nonexistent-partial-forged-input.json");
    pm.setMode("default");
    const result = await new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never).executeAll(
      [{ id: "partial-shell-forged", name: "bash", input: { command: "echo no-run", hostShellExecutionPermit: {}, permissionDecision: { decision: "allow", reason: "allow rules Bash(echo no-run)", } } }],
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
      pmReturning({ decision: "ask", provenance: RULE_PROVENANCE, reason: "plain shell requires consent", }),
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
      fallbackReason: "active-sandbox-not-shell-contained",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confines: { filesystem: false, process: false, network: false },
      },
    });
    expect(JSON.stringify(rendererApproval.executionPlan)).not.toContain("echo one-shot");
    expect(JSON.stringify(rendererApproval.executionPlan)).not.toContain(
      "The active OS sandbox does not prove containment for this shell.",
    );
    expect(observedPermit).toBeDefined();
    expect(observedPlan).toMatchObject({
      mode: "plain",
      fallbackReason: "active-sandbox-not-shell-contained",
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
    expect(resultPlanJson).not.toContain("The active OS sandbox does not prove containment for this shell.");
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
      pmReturning({ decision: "ask", provenance: RULE_PROVENANCE, reason: "plain shell requires consent", }),
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
    expect(deniedResultPlanJson).not.toContain("The active OS sandbox does not prove containment for this shell.");
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
    const requestAndWait = answeringRequestAndWait(async (pending: ApprovalRequest) => {
      request = pending;
      return { requestId: pending.id, choice: "allow-once" as const };
    });
    const endMetas: ToolCallMeta[] = [];
    const result = await new ToolExecutor(
      registry,
      undefined,
      pmReturning({ decision: "ask", provenance: RULE_PROVENANCE, reason: "plain shell requires consent", }),
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
    expect(permitlessResultPlanJson).not.toContain("The active OS sandbox does not prove containment for this shell.");
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
      pmReturning({ decision: "allow", provenance: RULE_PROVENANCE, reason: "ordinary dynamic tool", }),
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

  // Unavailable confinement asks the person: neither auto review nor a saved rule runs it.
  it.each(["darwin", "linux", "win32"] as const)(
    "asks for a requested-unavailable %s shell without review, and again under a saved rule",
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
      pm.dispatchReviewer = vi.fn(async () => ({ verdict: { level: "low" as const, reason: "Bounded effect" }, cacheReason: "miss-not-found" as const,
        outcome: "fresh" as const, judge: reviewerJudgeOutcomeForTest("allow", "Bounded effect") })) as never;
      const requestAndWait = answeringRequestAndWait<{ id: string }>(() => ({ choice: "deny-once" as const }));
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
      expect(pm.dispatchReviewer).not.toHaveBeenCalled();
      expect(requestAndWait).toHaveBeenCalledTimes(2);
      expect(requestAndWait).toHaveBeenLastCalledWith(expect.objectContaining({
        forceExplicit: true, allowedChoices: ["allow-once", "deny-once"],
        executionPlan: expect.objectContaining({ platform, fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true }),
      }));
      expect(execute).not.toHaveBeenCalled();
      expect(observedPlan).toBeUndefined();
      expect(result[0]?.is_error).toBe(true);
    },
  );

  // A policy allow that did not come through the forced ask carries no permit, so the unavailable-confinement plan does not spawn.
  it.each(["darwin", "linux", "win32"] as const)(
    "refuses requested-unavailable %s shells on a policy allow that skipped the forced ask",
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
        pmReturning({ decision: "allow", provenance: RULE_PROVENANCE, reason: "exact allow rule", }),
        undefined,
        gate,
      ).executeAll(
        [{ id: `requested-unavailable-allow-${platform}`, name: "bash", input: { command: "echo normal-rules" } }],
        { sessionId: `requested-unavailable-allow-${platform}`, permissionContext: permissionContext() },
      );

      expect(sentApprovalCards<ApprovalRequest>({ send } as never)).toHaveLength(0);
      expect(observedPermit).toBe("unset");
      expect(observedPlan).toBeUndefined();
      expect(result[0]?.is_error).toBe(true);
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
      const pm = pmReturning({ decision: "allow", provenance: RULE_PROVENANCE, reason: "ordinary explicit-off path", });
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
