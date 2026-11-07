// An unverifiable Ave home read boundary leaves host shells unconfined only through a human ask, every command.
vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childProcessMock = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFileSync: childProcessMock.execFileSync,
}));

import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { reviewerJudgeOutcomeForTest, setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import * as powerShellStartup from "../../shared/powershell-startup-policy.js";
import { ToolExecutor } from "../executor.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { ToolRegistry } from "../registry.js";
import type { Tool } from "../base.js";
import type { ToolExecutionContext } from "../types.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { requestedSandboxUnavailable } from "../../__tests__/support/host-shell-sandbox-fixtures.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot, AVE_HOME_BOUNDARY_UNVERIFIED_ERROR_CODE } from "../../shared/ave-home.js";
import { shellExecutionEnvironmentLines } from "../../shared/shell-execution-environment.js";
import { t } from "../../i18n/runtime.js";
import { userPermissionContext as permissionContext } from "./tool-context-fixture.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

const ORIGINAL_PLATFORM = process.platform;
const HOME = "C:\\Users\\alice\\.ave";
let testRoot: string;

const DIALECTS = [
  { toolName: "bash", create: () => new BashTool(), command: "echo boundary", prefixRule: "Bash(echo *)", writeCommand: "echo x > out.txt" },
  { toolName: "powershell", create: () => new PowerShellTool(), command: "Write-Output boundary", prefixRule: "PowerShell(Write-Output *)", writeCommand: "Set-Content out.txt x" },
] as const;

function probe(create: () => Tool, execute: (ctx: ToolExecutionContext) => void): ToolRegistry {
  const tool = create();
  vi.spyOn(tool, "execute").mockImplementation(async (_input, ctx) => {
    execute(ctx);
    return { output: "executed", isError: false };
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  return registry;
}

function cardGate(choice: "allow-once" | "deny-once" | "allow-session") {
  let gate: ApprovalGate;
  const send = vi.fn((channel: string, request: ApprovalRequest) => {
    if (channel !== "ave:approval:request") return;
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice, nonce: request.nonce, hmac: request.hmac }, webContents as never);
  });
  const webContents = { isDestroyed: () => false, send };
  gate = new ApprovalGate(webContents as never);
  return { gate, cards: () => sentApprovalCards<ApprovalRequest>({ send } as never) };
}

function manager(mode: "default" | "auto" | "allow", rules: readonly string[]): PermissionManager {
  const pm = new PermissionManager(join(testRoot, `permissions-${mode}.json`));
  pm.setMode(mode);
  pm.setRules(rules.map(pattern => pattern.includes("(")
    ? { pattern, action: "allow" as const, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }
    : { pattern, action: "allow" as const }));
  setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
  pm.dispatchReviewer = vi.fn(async () => ({ verdict: { level: "low" as const, reason: "Bounded effect" }, cacheReason: "miss-not-found" as const,
    outcome: "fresh" as const, judge: reviewerJudgeOutcomeForTest("allow", "Bounded effect") })) as never;
  return pm;
}

function publishBoundary(category: "boundary-link" | "boundary-unlisted"): void {
  setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, reason: AVE_HOME_BOUNDARY_UNVERIFIED_ERROR_CODE, category });
}

describe("host shells under an unverifiable Ave home boundary", () => {
  beforeEach(() => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), "boundary-shell-")));
    __resetShellResolverCache();
    vi.spyOn(powerShellStartup, "isPowerShellStartupPinned").mockReturnValue(true);
    childProcessMock.execFileSync.mockImplementation((_file, args: readonly string[]) =>
      args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB\0" : "__ave_shell_ok__");
    requestedSandboxUnavailable("win32");
  });

  afterEach(() => {
    _resetAveHomePrivacyForTest();
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockReset();
    vi.restoreAllMocks();
    setProcessPlatform(ORIGINAL_PLATFORM);
    rmSync(testRoot, { recursive: true, force: true });
  });

  const cases = (["boundary-link", "boundary-unlisted"] as const).flatMap(category => DIALECTS.flatMap(dialect => ([
    { category, dialect, mode: "default" as const, label: "saved prefix and tool allows", rules: [dialect.prefixRule, dialect.toolName], command: dialect.command },
    { category, dialect, mode: "auto" as const, label: "auto review", rules: [], command: dialect.command },
    { category, dialect, mode: "allow" as const, label: "allow mode", rules: [], command: dialect.command },
    { category, dialect, mode: "default" as const, label: "an in-directory write despite a saved tool allow", rules: [dialect.toolName], command: dialect.writeCommand },
  ])));

  it.each(cases)("$category: $dialect.toolName with $label asks on the unavailable-sandbox card and spawns only after approval", async ({ category, dialect, mode, rules, command }) => {
    publishBoundary(category);
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager(mode, rules);
    const denied = cardGate("deny-once");
    const run = (gate: ApprovalGate, id: string) => runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
      [{ id, name: dialect.toolName, input: { command } }],
      { sessionId: "boundary-shell", permissionContext: permissionContext() },
    ));

    const refused = await run(denied.gate, "boundary-deny");
    expect(denied.cards()).toHaveLength(1);
    const card = denied.cards()[0]!;
    expect(card.kind ?? "tool").toBe("tool");
    expect(card.executionPlan).toMatchObject({ mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(shellExecutionEnvironmentLines(card.executionPlan!)).toContain(t("shellExecution.sandboxUnavailableAsk"));
    expect(execute).not.toHaveBeenCalled();
    expect(refused[0]?.is_error).toBe(true);
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();

    const approved = cardGate("allow-once");
    const ran = await run(approved.gate, "boundary-allow");
    expect(approved.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    const ctx = execute.mock.calls[0]![0] as ToolExecutionContext;
    expect(ctx.hostShellExecutionPermit).toBeDefined();
    expect(ctx.hostShellExecutionPlan).toMatchObject({ mode: "plain", sandboxed: false, substrate: "none",
      capability: { kind: "none", confines: { filesystem: false, process: false, network: false } } });
    expect(ran[0]?.is_error).toBeUndefined();

    // Approval is for that command only: the next one asks again.
    const again = cardGate("deny-once");
    await run(again.gate, "boundary-again");
    expect(again.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(DIALECTS)("asks on the out-of-directory card with once-only choices for $toolName, every command", async (dialect) => {
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager("allow", [dialect.prefixRule, dialect.toolName]);
    const run = (gate: ApprovalGate, id: string) => new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
      [{ id, name: dialect.toolName, input: { command: dialect.command, cwd: testRoot } }],
      { sessionId: "boundary-directory", permissionContext: permissionContext() },
    );
    const denied = cardGate("deny-once");
    await run(denied.gate, "directory-deny");
    expect(denied.cards()).toHaveLength(1);
    expect(denied.cards()[0]).toMatchObject({ kind: "out-of-allowed-dir", allowedChoices: ["allow-once", "deny-once"],
      executionPlan: { mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true } });
    expect(execute).not.toHaveBeenCalled();
    const approved = cardGate("allow-once");
    await run(approved.gate, "directory-allow");
    expect(execute).toHaveBeenCalledOnce();
    const again = cardGate("deny-once");
    await run(again.gate, "directory-again");
    expect(again.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  const HOST = { executionMode: "host", justification: "Retry outside the OS sandbox" } as const;
  const hostCases = (["boundary-link", "boundary-unlisted"] as const).flatMap(category => DIALECTS.flatMap(dialect => ([
    { category, dialect, mode: "default" as const, label: "saved prefix and tool allows", rules: [dialect.prefixRule, dialect.toolName] },
    { category, dialect, mode: "auto" as const, label: "auto review", rules: [] },
    { category, dialect, mode: "allow" as const, label: "allow mode", rules: [] },
  ])));

  it.each(hostCases)("$category: explicit-host $dialect.toolName with $label asks every command", async ({ category, dialect, mode, rules }) => {
    publishBoundary(category);
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager(mode, rules);
    const run = (gate: ApprovalGate, id: string) => runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
      [{ id, name: dialect.toolName, input: { command: dialect.command, ...HOST } }],
      { sessionId: "boundary-host", permissionContext: permissionContext() },
    ));

    const denied = cardGate("deny-once");
    const refused = await run(denied.gate, "host-deny");
    expect(denied.cards()).toHaveLength(1);
    const card = denied.cards()[0]!;
    expect(card.executionPlan).toMatchObject({ mode: "plain", executionRequest: "host", requiresExplicitUserApproval: true,
      capability: { kind: "none" } });
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(execute).not.toHaveBeenCalled();
    expect(refused[0]?.is_error).toBe(true);
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();

    const approved = cardGate("allow-once");
    await run(approved.gate, "host-allow");
    expect(approved.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect((execute.mock.calls[0]![0] as ToolExecutionContext).hostShellExecutionPlan).toMatchObject({ executionRequest: "host", sandboxed: false });

    const again = cardGate("deny-once");
    await run(again.gate, "host-again");
    expect(again.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("asks for a background bash command through the same invocation authorization", async () => {
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = probe(DIALECTS[0].create, execute);
    const approvals = cardGate("deny-once");
    await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("allow", ["bash"]), undefined, approvals.gate).executeAll(
      [{ id: "boundary-background", name: "bash", input: { command: "echo boundary", run_in_background: true } }],
      { sessionId: "boundary-background", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(1);
    expect(approvals.cards()[0]!.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(execute).not.toHaveBeenCalled();
  });

  // Worker confinement on, shell scope off: boot still publishes the boundary state, and the sandbox-off plan asks every command.
  const workerOnlyCases = (["boundary-link", "boundary-unlisted"] as const).flatMap(category => DIALECTS.flatMap(dialect => ([
    { category, dialect, mode: "default" as const, label: "saved prefix and tool allows", rules: [dialect.prefixRule, dialect.toolName] },
    { category, dialect, mode: "auto" as const, label: "auto review", rules: [] },
    { category, dialect, mode: "allow" as const, label: "allow mode", rules: [] },
  ])));

  it.each(workerOnlyCases)("$category on a worker-only boot: $dialect.toolName with $label asks every command", async ({ category, dialect, mode, rules }) => {
    setShellSandboxRequestedAtBoot(false);
    publishBoundary(category);
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager(mode, rules);
    const run = (gate: ApprovalGate, id: string) => runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
      [{ id, name: dialect.toolName, input: { command: dialect.command } }],
      { sessionId: "boundary-worker-only", permissionContext: permissionContext() },
    ));

    const denied = cardGate("deny-once");
    await run(denied.gate, "worker-only-deny");
    expect(denied.cards()).toHaveLength(1);
    const card = denied.cards()[0]!;
    expect(card.executionPlan).toMatchObject({ mode: "plain", requestedSandbox: false, fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: true });
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(shellExecutionEnvironmentLines(card.executionPlan!)).toContain(t("shellExecution.boundaryUnverifiedAsk"));
    expect(execute).not.toHaveBeenCalled();
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();

    const approved = cardGate("allow-once");
    await run(approved.gate, "worker-only-allow");
    expect(execute).toHaveBeenCalledOnce();
    expect((execute.mock.calls[0]![0] as ToolExecutionContext).hostShellExecutionPlan).toMatchObject({ mode: "plain", sandboxed: false });

    const again = cardGate("deny-once");
    await run(again.gate, "worker-only-again");
    expect(again.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("denies a headless shell on a worker-only boot with an unverifiable boundary", async () => {
    setShellSandboxRequestedAtBoot(false);
    publishBoundary("boundary-unlisted");
    const execute = vi.fn();
    const registry = probe(DIALECTS[0].create, execute);
    const result = await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("allow", ["bash"]), undefined, cardGate("allow-once").gate).executeAll(
      [{ id: "worker-only-headless", name: "bash", input: { command: "echo boundary" } }],
      { sessionId: "worker-only-headless", permissionContext: permissionContext({ headless: true }) },
    ));
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.content).toContain(NO_APPROVER_MESSAGE);
  });

  it.each(DIALECTS)("keeps ordinary sandbox-off policy for $toolName with the shell scope off and no boundary failure", async (dialect) => {
    setShellSandboxRequestedAtBoot(false);
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, reason: "icacls failed", category: "icacls-failed" });
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("default", [dialect.prefixRule, dialect.toolName]), undefined, approvals.gate).executeAll(
      [{ id: "worker-only-control", name: dialect.toolName, input: { command: dialect.command } }],
      { sessionId: "worker-only-control", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
    expect((execute.mock.calls[0]![0] as ToolExecutionContext).hostShellExecutionPlan).toMatchObject({
      fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: false });
  });

  it("denies a headless shell with no approver", async () => {
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = probe(DIALECTS[0].create, execute);
    const result = await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("allow", ["bash"]), undefined, cardGate("allow-once").gate).executeAll(
      [{ id: "boundary-headless", name: "bash", input: { command: "echo boundary" } }],
      { sessionId: "boundary-headless", permissionContext: permissionContext({ headless: true }) },
    ));
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.content).toContain(NO_APPROVER_MESSAGE);
  });

  it.each(DIALECTS)("keeps the ordinary explicit-host route for $toolName under any other boot failure", async (dialect) => {
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, reason: "icacls failed", category: "icacls-failed" });
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("allow", []), undefined, approvals.gate).executeAll(
      [{ id: "other-failure-host", name: dialect.toolName, input: { command: dialect.command, ...HOST } }],
      { sessionId: "other-failure-host", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
    expect((execute.mock.calls[0]![0] as ToolExecutionContext).hostShellExecutionPlan).toMatchObject({ executionRequest: "host" });
  });

  it.each(DIALECTS)("keeps the ordinary unavailable-sandbox route for $toolName under any other boot failure", async (dialect) => {
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, reason: "icacls failed", category: "icacls-failed" });
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    const result = await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("default", [dialect.prefixRule, dialect.toolName]), undefined, approvals.gate).executeAll(
      [{ id: "other-failure", name: dialect.toolName, input: { command: dialect.command } }],
      { sessionId: "other-failure", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
    expect((execute.mock.calls[0]![0] as ToolExecutionContext).hostShellExecutionPlan).toMatchObject({
      fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: false });
    expect(result[0]?.is_error).toBeUndefined();
  });
});
