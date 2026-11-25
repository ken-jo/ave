// An unverifiable Ave home read boundary leaves host shells unconfined only through a human ask: once, or for this session's later shells.
vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHostResources } from "../../main/host-resources.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childProcessMock = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  actualExecFileSync: undefined as unknown as typeof import("node:child_process").execFileSync,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  childProcessMock.actualExecFileSync = actual.execFileSync;
  return { ...actual, execFileSync: childProcessMock.execFileSync };
});

import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { HOST_SHELL_AUTHORIZATION_REVOKED_ERROR } from "../../permissions/host-shell-execution-permit.js";
import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { reviewerJudgeOutcomeForTest, setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { BashTool, PowerShellTool } from "../shell-tools.js";
import * as powerShellStartup from "../../shared/powershell-startup-policy.js";
import { ToolExecutor } from "../executor.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { ToolRegistry } from "../registry.js";
import type { ToolExecutionContext } from "../types.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { requestedSandboxUnavailable } from "../../__tests__/support/host-shell-sandbox-fixtures.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot, ensureAveHomePrivate, AVE_HOME_BOUNDARY_UNVERIFIED_ERROR_CODE, type AveHomePrivacyFailureCategory } from "../../shared/ave-home.js";
import { shellExecutionEnvironmentLines } from "../../shared/shell-execution-environment.js";
import { setWindowsDenyUnenforceableAtBoot } from "../../permissions/admitted-obligation.js";
import { __resetRunGrantsForTest, registerRunSession } from "../../permissions/run-grants.js";
import { windowsPathKindHelperUnavailable } from "../../main/windows-path-kind-launcher.js";
import { getLocale, setLocale, t } from "../../i18n/runtime.js";
import { userPermissionContext as permissionContext } from "./tool-context-fixture.js";
import { cardGate, defined, probe, sessionGate } from "../../__tests__/support/forced-shell-card.js";

const ORIGINAL_PLATFORM = process.platform;
const HOME = "C:\\Users\\alice\\.ave";
let testRoot: string;

const DIALECTS = [
  { toolName: "bash", create: () => new BashTool(), command: "echo boundary", prefixRule: "Bash(echo *)", writeCommand: "echo x > out.txt",
    other: "echo done", sequences: ["echo boundary && echo boundary", "echo boundary; echo boundary", "echo boundary | echo boundary"],
    compose: (a: string, b: string) => [`${a} && ${b}`, `${a}; ${b}`, `${a} | ${b}`], protectedWrite: "echo x > .git/config" },
  { toolName: "powershell", create: () => new PowerShellTool(), command: "Write-Output boundary", prefixRule: "PowerShell(Write-Output *)", writeCommand: "Set-Content out.txt x",
    other: "Write-Output done", sequences: ["Write-Output boundary; Write-Output boundary", "Write-Output boundary | Write-Output boundary"],
    compose: (a: string, b: string) => [`${a}; ${b}`, `${a} | ${b}`], protectedWrite: "Set-Content .git/config x" },
] as const;

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

// Windows path admission pins through the shipped path-kind helper; boot configures its resources first.
beforeAll(() => configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }));

describe("host shells under an unverifiable Ave home boundary", () => {
  beforeEach(() => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), "boundary-shell-")));
    __resetShellResolverCache();
    vi.spyOn(powerShellStartup, "isPowerShellStartupPinned").mockReturnValue(true);
    // The shipped path-kind helper that pins Windows paths still runs.
    childProcessMock.execFileSync.mockImplementation((file: string, args: readonly string[], options?: object) =>
      /[\\/]ave-path-kind\.exe$/i.test(file) ? childProcessMock.actualExecFileSync(file, args, options)
        : args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB\0" : "__ave_shell_ok__");
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
    const card = defined(denied.cards()[0], "approval card");
    expect(card.kind ?? "tool").toBe("tool");
    expect(card.executionPlan).toMatchObject({ mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(shellExecutionEnvironmentLines(defined(card.executionPlan, "card execution plan"))).toContain(t("shellExecution.sandboxUnavailableAsk"));
    expect(execute).not.toHaveBeenCalled();
    expect(refused[0]?.is_error).toBe(true);
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();

    const approved = cardGate("allow-once");
    const ran = await run(approved.gate, "boundary-allow");
    expect(approved.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    const ctx = defined(execute.mock.calls[0], "execute call")[0] as ToolExecutionContext;
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

  it.each(DIALECTS.flatMap(dialect => ([
    { dialect, kind: "network" as const, key: "shellExecution.denyUnenforceableAsk" as const },
    { dialect, kind: "path" as const, key: "shellExecution.denyPathUnenforceableAsk" as const },
  ])))("$dialect.toolName asks on the unavailable-sandbox card, with the $kind reason, when boot could not enforce a Windows deny", async ({ dialect, kind, key }) => {
    setWindowsDenyUnenforceableAtBoot(kind);
    try {
      const execute = vi.fn();
      const registry = probe(dialect.create, execute);
      const pm = manager("allow", [dialect.prefixRule, dialect.toolName]);
      const denied = cardGate("deny-once");
      await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, pm, undefined, denied.gate).executeAll(
        [{ id: "deny-unenforceable", name: dialect.toolName, input: { command: dialect.command } }],
        { sessionId: "deny-unenforceable", permissionContext: permissionContext() },
      ));
      expect(denied.cards()).toHaveLength(1);
      const card = defined(denied.cards()[0], "approval card");
      expect(card.executionPlan).toMatchObject({ mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
      expect(JSON.stringify(card)).toContain(JSON.stringify(t(key)).slice(1, -1));
      if (kind === "path") expect(JSON.stringify(card)).not.toContain("network location");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      setWindowsDenyUnenforceableAtBoot(undefined);
    }
  });

  it.each(DIALECTS.flatMap(dialect => (["sibling run rule", "rule change", "mode change"] as const).map(change => ({ dialect, change }))))(
    "$dialect.toolName: the Windows deny card answered across a $change", async ({ dialect, change }) => {
      setWindowsDenyUnenforceableAtBoot("path");
      try {
        const execute = vi.fn();
        const registry = probe(dialect.create, execute);
        const pm = manager("allow", [dialect.prefixRule, dialect.toolName]);
        let gate: ApprovalGate;
        const send = vi.fn((channel: string, request: ApprovalRequest) => {
          if (channel !== "ave:approval:request") return;
          setTimeout(() => {
            if (change === "sibling run rule") {
              registerRunSession("stale-card-run", "sibling-session", { stageId: "plan", stageName: "Plan", lane: "attended" });
              pm.addRunRule("sibling-session", "Bash(npm test)");
            }
            else if (change === "rule change") pm.setRules([{ pattern: "Bash(npm test)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }]);
            else pm.setMode("default");
            gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, webContents as never);
          }, 0);
        });
        const webContents = { isDestroyed: () => false, send };
        gate = new ApprovalGate(webContents as never);
        const [result] = await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
          [{ id: "deny-unenforceable-stale", name: dialect.toolName, input: { command: dialect.command } }],
          { sessionId: "deny-unenforceable-stale", permissionContext: permissionContext() },
        ));
        expect(send).toHaveBeenCalledWith("ave:approval:request", expect.anything());
        if (change === "sibling run rule") {
          expect(result?.is_error, JSON.stringify(result)).toBeUndefined();
          expect(execute).toHaveBeenCalledOnce();
        } else {
          expect(result).toMatchObject({ is_error: true, content: expect.stringMatching(/policy changed/i) });
          expect(execute).not.toHaveBeenCalled();
        }
      } finally {
        __resetRunGrantsForTest();
        setWindowsDenyUnenforceableAtBoot(undefined);
      }
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
    const card = defined(denied.cards()[0], "approval card");
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
    expect((defined(execute.mock.calls[0], "execute call")[0] as ToolExecutionContext).hostShellExecutionPlan).toMatchObject({ executionRequest: "host", sandboxed: false });

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
    expect(defined(approvals.cards()[0], "approval card").allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(execute).not.toHaveBeenCalled();
  });

  // Worker confinement on, shell scope off: boot still publishes the privacy failure, and the sandbox-off plan asks every command.
  const FLOOR_CATEGORIES = [
    "boundary-link", "boundary-unlisted", "system-root-missing", "directory-failed", "identity-failed", "icacls-failed", "read-back-failed",
    "extra-principals", "workspace-extra-principals", "not-protected", "invalid-owner-grant", "owner-claim-failed", "reparse-point", "posix-root-unsafe",
  ] as const satisfies readonly AveHomePrivacyFailureCategory[];
  // The card names no category: the same words hold for every privacy failure that forces the floor.
  const CARD_TEXT = {
    en: "Ave home privacy could not be established at startup, so a shell command runs without the OS sandbox only after you approve it. Approve it once, or waive this sandbox approval for later shell commands and hooks in this session while home privacy stays unverified. Other permission checks still apply and may ask again.",
    ko: "시작할 때 Ave 홈 보호를 확인할 수 없어, 셸 명령은 승인한 뒤에만 OS 샌드박스 없이 실행됩니다. 한 번만 승인하거나, 홈 보호를 확인할 수 없는 동안 이 세션의 이후 셸 명령과 훅에 대한 샌드박스 승인을 면제할 수 있습니다. 다른 권한 검사는 계속 적용되며 다시 승인을 요청할 수 있습니다.",
  };
  const workerOnlyCases = FLOOR_CATEGORIES.flatMap(category => DIALECTS.flatMap(dialect => ([
    { category, dialect, mode: "default" as const, label: "saved prefix and tool allows", rules: [dialect.prefixRule, dialect.toolName] },
    { category, dialect, mode: "auto" as const, label: "auto review", rules: [] },
    { category, dialect, mode: "allow" as const, label: "allow mode", rules: [] },
  ])));

  it.each(workerOnlyCases)("$category on a worker-only boot: $dialect.toolName with $label asks every command", async ({ category, dialect, mode, rules }) => {
    setShellSandboxRequestedAtBoot(false);
    setAveHomePrivacyAtBoot({ enforcement: "none", home: HOME, reason: category, category });
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
    const card = defined(denied.cards()[0], "approval card");
    expect(card.executionPlan).toMatchObject({ mode: "plain", requestedSandbox: false, fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: true });
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    const locale = getLocale();
    try {
      for (const shown of ["en", "ko"] as const) {
        setLocale(shown);
        expect(shellExecutionEnvironmentLines(defined(card.executionPlan, "card execution plan"))).toContain(CARD_TEXT[shown]);
      }
    } finally {
      setLocale(locale);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();

    const approved = cardGate("allow-once");
    await run(approved.gate, "worker-only-allow");
    expect(execute).toHaveBeenCalledOnce();
    const ctx = execute.mock.calls[0]?.[0] as ToolExecutionContext;
    expect(ctx.hostShellExecutionPlan).toMatchObject({ mode: "plain", sandboxed: false });
    // The spawn consumer needs the one-shot permit this approval minted.
    expect(ctx.hostShellExecutionPermit).toBeDefined();

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

  it.each(DIALECTS)("keeps ordinary sandbox-off policy for $toolName with the shell scope off and no boot privacy failure", async (dialect) => {
    setShellSandboxRequestedAtBoot(false);
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("default", [dialect.prefixRule, dialect.toolName]), undefined, approvals.gate).executeAll(
      [{ id: "worker-only-control", name: dialect.toolName, input: { command: dialect.command } }],
      { sessionId: "worker-only-control", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledOnce();
    const ctx = execute.mock.calls[0]?.[0] as ToolExecutionContext;
    expect(ctx.hostShellExecutionPlan).toMatchObject({ fallbackReason: "disabled-by-setting", requiresExplicitUserApproval: false });
    expect(ctx.hostShellExecutionPermit).toBeUndefined();
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

  it.each(DIALECTS)("asks for the explicit-host route for $toolName without a boot privacy failure, allow mode included", async (dialect) => {
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("allow", []), undefined, approvals.gate).executeAll(
      [{ id: "other-failure-host", name: dialect.toolName, input: { command: dialect.command, ...HOST } }],
      { sessionId: "other-failure-host", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(1);
    expect(defined(approvals.cards()[0], "forced card")).toMatchObject({ requireExplicit: true, executionPlan: { executionRequest: "host" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(DIALECTS)("asks for the unavailable-sandbox route for $toolName without a boot privacy failure, saved allows included", async (dialect) => {
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    const result = await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, manager("default", [dialect.prefixRule, dialect.toolName]), undefined, approvals.gate).executeAll(
      [{ id: "other-failure", name: dialect.toolName, input: { command: dialect.command } }],
      { sessionId: "other-failure", permissionContext: permissionContext() },
    ));
    expect(approvals.cards()).toHaveLength(1);
    expect(defined(approvals.cards()[0], "forced card")).toMatchObject({
      requireExplicit: true,
      executionPlan: { fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.is_error).toBe(true);
  });

  // Owner decision 2026-11-08: the sandbox-unavailable floor also offers "this session", for the conversation's later shells and hooks.
  const sessionCases = (["boundary-link", "boundary-unlisted"] as const).flatMap(category => DIALECTS.flatMap(dialect => ([
    { category, dialect, route: "default", mode: "default" as const, label: "saved prefix and tool allows", rules: [dialect.prefixRule, dialect.toolName], command: dialect.command as string },
    { category, dialect, route: "default", mode: "allow" as const, label: "allow mode", rules: [], command: dialect.command as string },
    { category, dialect, route: "host", mode: "allow" as const, label: "allow mode", rules: [], command: dialect.command as string },
    { category, dialect, route: "worker-only", mode: "allow" as const, label: "allow mode and a saved prefix", rules: [dialect.prefixRule], command: dialect.command as string },
    { category, dialect, route: "default", mode: "allow" as const, label: "a compound command", rules: [], command: `${dialect.command}; ${dialect.other}` as string },
  ])));

  function sessionRun(dialect: (typeof DIALECTS)[number], route: string, sessionId: string, command: string = dialect.command) {
    const input = route === "host" ? { command, ...HOST } : { command };
    let serial = 0;
    return (pm: PermissionManager, gate: ApprovalGate, registry: ToolRegistry, headless = false) => runWithToolExecutionCwd(testRoot, () =>
      new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
        [{ id: `${sessionId}-${++serial}`, name: dialect.toolName, input }],
        { sessionId, permissionContext: permissionContext(headless ? { headless: true } : {}) },
      ));
  }

  type PrivacyFailure = { label: string; category: AveHomePrivacyFailureCategory; helperError?: Error };
  const privacyFailures: readonly PrivacyFailure[] = [
    { label: "path-kind helper error", category: "read-back-failed", helperError: new Error("Invalid Windows path facts response") },
    ...([
      "system-root-missing", "directory-failed", "identity-failed", "icacls-failed", "read-back-failed",
      "extra-principals", "workspace-extra-principals", "not-protected", "invalid-owner-grant", "owner-claim-failed", "reparse-point",
    ] as const).map(category => ({ label: category, category })),
  ];

  function publishPrivacyFailure({ category, helperError }: PrivacyFailure): void {
    const privacy = helperError === undefined
      ? { enforcement: "none" as const, home: HOME, reason: category, category }
      : ensureAveHomePrivate(join(testRoot, "ave-home"), {
          platform: "win32",
          readDacls: () => { throw helperError; },
        });
    expect(privacy).toMatchObject({ enforcement: "none", category });
    setAveHomePrivacyAtBoot(privacy);
  }

  const routes = [
    { route: "default", plan: { fallbackReason: "requested-sandbox-unavailable", executionRequest: "default" } },
    { route: "host", plan: { fallbackReason: "none", executionRequest: "host" } },
    { route: "worker-only", plan: { fallbackReason: "disabled-by-setting", executionRequest: "default" } },
  ] as const;
  const routeCases = routes.flatMap(route => DIALECTS.map(dialect => ({ ...route, dialect })));

  // Owner decision 2026-11-24: a helper that gave no answer checked nothing, so host shells are denied until a restart, whatever approves them.
  const RESTART = "Restart Ave; if it persists, reinstall Ave.";
  const helperUnavailable: readonly PrivacyFailure[] = [
    { label: "path-kind helper timeout", category: "helper-unavailable", helperError: windowsPathKindHelperUnavailable("Windows path facts helper did not answer within 15000 ms", "ETIMEDOUT") },
    { label: "bare category", category: "helper-unavailable" },
  ];

  describe.each(helperUnavailable)("helper-unavailable ($label) boot privacy failure", (failure) => {
    beforeEach(() => publishPrivacyFailure(failure));

    const approvers = [
      { label: "a saved prefix and tool allow", mode: "default" as const, rules: (d: (typeof DIALECTS)[number]) => [d.prefixRule, d.toolName] },
      { label: "auto review", mode: "auto" as const, rules: () => [] },
      { label: "allow mode and a saved prefix", mode: "allow" as const, rules: (d: (typeof DIALECTS)[number]) => [d.prefixRule, d.toolName] },
    ];
    const denyCases = routeCases.flatMap(route => approvers.map(approver => ({ ...route, approver })));

    it.each(denyCases)("$route route: $dialect.toolName with $approver.label is denied with the restart notice and no card", async ({ route, dialect, approver }) => {
      if (route === "worker-only") setShellSandboxRequestedAtBoot(false);
      const execute = vi.fn();
      const registry = probe(dialect.create, execute);
      const pm = manager(approver.mode, approver.rules(dialect));
      const run = sessionRun(dialect, route, `helper-${route}`);

      const once = cardGate("allow-once");
      const refused = await run(pm, once.gate, registry);
      expect(once.cards()).toHaveLength(0);
      expect(refused[0]?.is_error).toBe(true);
      expect(refused[0]?.content).toContain(RESTART);
      expect(pm.dispatchReviewer).not.toHaveBeenCalled();

      // No session waiver: there is no card to save one from.
      const session = sessionGate(pm);
      await run(pm, session.gate, registry);
      expect(session.cards()).toHaveLength(0);
      expect(session.saves).toEqual([]);

      const headless = await run(pm, cardGate("allow-once").gate, registry, true);
      expect(headless[0]?.content).toContain(RESTART);
      expect(headless[0]?.content).not.toContain(NO_APPROVER_MESSAGE);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each(DIALECTS)("an out-of-directory $toolName is denied with the restart notice and no card", async (dialect) => {
      const execute = vi.fn();
      const registry = probe(dialect.create, execute);
      const approvals = cardGate("allow-once");
      const result = await new ToolExecutor(registry, undefined, manager("allow", [dialect.prefixRule, dialect.toolName]), undefined, approvals.gate).executeAll(
        [{ id: "helper-directory", name: dialect.toolName, input: { command: dialect.command, cwd: testRoot } }],
        { sessionId: "helper-directory", permissionContext: permissionContext() },
      );
      expect(approvals.cards()).toHaveLength(0);
      expect(result[0]?.content).toContain(RESTART);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each(routeCases)("$route route: a direct $dialect.toolName call is refused with the restart notice", async ({ route, dialect }) => {
      if (route === "worker-only") setShellSandboxRequestedAtBoot(false);
      const result = await dialect.create().execute({ command: dialect.command, ...(route === "host" ? HOST : {}) },
        { cwd: testRoot, extraAllowedDirectories: [], metadata: { toolUseId: `helper-direct-${route}` } });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(RESTART);
    });
  });

  describe.each(privacyFailures)("$label boot privacy failure", (failure) => {
    const bash = DIALECTS[0];

    beforeEach(() => publishPrivacyFailure(failure));

    it("forces a card despite a saved Bash allow and lets this session pass the floor", async () => {
      const execute = vi.fn();
      const registry = probe(bash.create, execute);
      const pm = manager("default", [bash.prefixRule]);
      const run = sessionRun(bash, "default", "privacy-failure");

      const denied = cardGate("deny-once");
      await run(pm, denied.gate, registry);
      expect(denied.cards()).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      const card = defined(denied.cards()[0], "approval card");
      expect(card.executionPlan).toMatchObject({ mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
      expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
      expect(card.shellRule).toMatchObject({ floorSessionOnly: true, sessionAllowed: true, persistentAllowed: false });
      expect(shellExecutionEnvironmentLines(defined(card.executionPlan, "card execution plan"))).toContain(t("shellExecution.sandboxUnavailableAsk"));

      const approved = sessionGate(pm);
      await run(pm, approved.gate, registry);
      expect(approved.cards()).toHaveLength(1);
      expect(approved.saves).toEqual([expect.objectContaining({ ok: true, scope: "session", action: "allow" })]);
      expect(execute).toHaveBeenCalledOnce();

      const later = cardGate("deny-once");
      await sessionRun(bash, "default", "privacy-failure", bash.other)(pm, later.gate, registry);
      expect(later.cards()).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("denies a headless shell even with a saved Bash allow", async () => {
      const execute = vi.fn();
      const approvals = cardGate("allow-once");
      const result = await sessionRun(bash, "default", "privacy-failure-headless")(
        manager("allow", [bash.prefixRule]), approvals.gate, probe(bash.create, execute), true,
      );
      expect(approvals.cards()).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
      expect(result[0]?.content).toContain(NO_APPROVER_MESSAGE);
    });

    it.each(routeCases)("$route route: $dialect.toolName in allow mode with a saved prefix asks, and headless is denied", async ({ route, plan, dialect }) => {
      if (route === "worker-only") setShellSandboxRequestedAtBoot(false);
      const execute = vi.fn();
      const registry = probe(dialect.create, execute);
      const run = sessionRun(dialect, route, `privacy-${route}`);

      const denied = cardGate("deny-once");
      const refused = await run(manager("allow", [dialect.prefixRule, dialect.toolName]), denied.gate, registry);
      expect(denied.cards()).toHaveLength(1);
      expect(defined(denied.cards()[0], "approval card").executionPlan).toMatchObject({ mode: "plain", sandboxed: false, requiresExplicitUserApproval: true, ...plan });
      expect(refused[0]?.is_error).toBe(true);

      const headless = await run(manager("allow", [dialect.prefixRule, dialect.toolName]), cardGate("allow-once").gate, registry, true);
      expect(headless[0]?.content).toContain(NO_APPROVER_MESSAGE);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each(routeCases)("$route route: a direct $dialect.toolName call without the card's permit never spawns", async ({ route, dialect }) => {
      if (route === "worker-only") setShellSandboxRequestedAtBoot(false);
      const result = await dialect.create().execute({ command: dialect.command, ...(route === "host" ? HOST : {}) },
        { cwd: testRoot, extraAllowedDirectories: [], metadata: { toolUseId: `direct-${route}` } });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(`spawn failed: ${HOST_SHELL_AUTHORIZATION_REVOKED_ERROR.split(". ")[0]}`);
    });
  });

  it.each(sessionCases)("$category, $route route: $dialect.toolName allowed for this session runs the same command again without a card ($label)", async ({ category, dialect, route, mode, rules, command }) => {
    if (route === "worker-only") setShellSandboxRequestedAtBoot(false);
    publishBoundary(category);
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager(mode, rules);
    const run = sessionRun(dialect, route, "boundary-session", command);

    const first = sessionGate(pm);
    await run(pm, first.gate, registry);
    // Saved rules, allow mode and auto review still bring the floor's card; it offers this session but no lasting rule.
    expect(first.cards()).toHaveLength(1);
    const card = defined(first.cards()[0], "approval card");
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(card.shellRule).toMatchObject({ exactRule: null, sessionAllowed: true, persistentAllowed: false, denyAllowed: false, floorSessionOnly: true });
    expect(card).not.toHaveProperty("floorSessionGrant");
    expect(first.saves).toEqual([expect.objectContaining({ ok: true, scope: "session", action: "allow" })]);
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    const firstPermit = (defined(execute.mock.calls[0], "first call")[0] as ToolExecutionContext).hostShellExecutionPermit;
    expect(firstPermit).toBeDefined();

    // The same command in the same session: no card, and still its own one-shot spawn permit.
    const next = cardGate("deny-once");
    const ran = await run(pm, next.gate, registry);
    expect(next.cards()).toHaveLength(0);
    expect(ran[0]?.is_error).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    const secondCtx = defined(execute.mock.calls[1], "second call")[0] as ToolExecutionContext;
    expect(secondCtx.hostShellExecutionPermit).toBeDefined();
    expect(secondCtx.hostShellExecutionPermit).not.toBe(firstPermit);
    expect(secondCtx.hostShellExecutionPlan).toMatchObject({ mode: "plain", sandboxed: false });

    // A different command in the same session: no card either, its own permit.
    const other = cardGate("deny-once");
    await sessionRun(dialect, route, "boundary-session", `${command}2`)(pm, other.gate, registry);
    expect(other.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(3);
    expect((defined(execute.mock.calls[2], "third call")[0] as ToolExecutionContext).hostShellExecutionPermit).toBeDefined();
    // Another conversation asks again.
    const otherSession = cardGate("deny-once");
    await sessionRun(dialect, route, "boundary-other-session", command)(pm, otherSession.gate, registry);
    expect(otherSession.cards()).toHaveLength(1);
    // A restart (fresh permission state) asks again.
    const restarted = cardGate("deny-once");
    await run(manager(mode, rules), restarted.gate, registry);
    expect(restarted.cards()).toHaveLength(1);
    // Headless is still denied, grant or not.
    const headless = await run(pm, cardGate("allow-once").gate, registry, true);
    expect(headless[0]?.content).toContain(NO_APPROVER_MESSAGE);
    // Ending the conversation drops the grant.
    pm.endSession("boundary-session");
    const ended = cardGate("deny-once");
    await run(pm, ended.gate, registry);
    expect(ended.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each(DIALECTS)("an ordinary session allow made before the boundary state does not pass the floor for $toolName", async (dialect) => {
    const pm = manager("default", []);
    pm.addSessionRule("boundary-prior", `${dialect.toolName === "bash" ? "Bash" : "PowerShell"}(${dialect.command})`);
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await sessionRun(dialect, "default", "boundary-prior")(pm, approvals.gate, registry);
    expect(approvals.cards()).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(DIALECTS)("a floor session grant does not satisfy the ordinary ask after the boundary state changes for $toolName", async (dialect) => {
    publishBoundary("boundary-unlisted");
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager("default", []);
    const run = sessionRun(dialect, "default", "boundary-leak");
    const granted = sessionGate(pm);
    await run(pm, granted.gate, registry);
    expect(granted.saves).toEqual([expect.objectContaining({ ok: true })]);
    expect(execute).toHaveBeenCalledOnce();

    // A verified home: the grant was for the boot-privacy state, so the explicit host on the unavailable sandbox still shows its card.
    setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: HOME, sid: "S-1-5-21-1-2-3-1001" });
    const ordinary = cardGate("deny-once");
    await sessionRun(dialect, "host", "boundary-leak")(pm, ordinary.gate, registry);
    expect(ordinary.cards()).toHaveLength(1);
    expect(defined(ordinary.cards()[0], "ordinary card").executionPlan).toMatchObject({ executionRequest: "host" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(DIALECTS)("a floor session grant from $toolName covers later shells of the conversation: other commands, dialects, plans and background runs", async (dialect) => {
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = new ToolRegistry();
    for (const create of [DIALECTS[0].create, DIALECTS[1].create]) {
      const tool = create();
      vi.spyOn(tool, "execute").mockImplementation(async (_input, ctx) => {
        execute(ctx);
        return { output: "executed", isError: false };
      });
      registry.register(tool);
    }
    const pm = manager("allow", []);
    const granted = sessionGate(pm);
    await sessionRun(dialect, "default", "boundary-wide")(pm, granted.gate, registry);
    expect(granted.saves).toEqual([expect.objectContaining({ ok: true })]);
    expect(execute).toHaveBeenCalledTimes(1);
    const later = DIALECTS.flatMap((other) => [
      ...[other.other, ...other.sequences, ...other.compose(other.command, other.other)].map((command) => ({ dialect: other, route: "default", command })),
      { dialect: other, route: "host", command: other.other as string },
    ]);
    for (const { dialect: other, route, command } of later) {
      const quiet = cardGate("deny-once");
      const ran = await sessionRun(other, route, "boundary-wide", command)(pm, quiet.gate, registry);
      expect(quiet.cards(), `${other.toolName} ${route}: ${command}`).toHaveLength(0);
      expect(ran[0]?.is_error, command).toBeUndefined();
    }
    const background = cardGate("deny-once");
    await runWithToolExecutionCwd(testRoot, () => new ToolExecutor(registry, undefined, pm, undefined, background.gate).executeAll(
      [{ id: "boundary-wide-background", name: "bash", input: { command: "echo later", run_in_background: true } }],
      { sessionId: "boundary-wide", permissionContext: permissionContext() },
    ));
    expect(background.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(later.length + 2);
    const permits = execute.mock.calls.map((call) => (call[0] as ToolExecutionContext).hostShellExecutionPermit);
    expect(permits.every((permit) => permit !== undefined)).toBe(true);
    expect(new Set(permits).size).toBe(later.length + 2);

    // Another forced floor in a later command still brings its own card, with no session choice.
    const protectedCard = cardGate("deny-once");
    await sessionRun(dialect, "default", "boundary-wide", dialect.protectedWrite)(pm, protectedCard.gate, registry);
    expect(protectedCard.cards()).toHaveLength(1);
    const card = defined(protectedCard.cards()[0], "protected card");
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(card.shellRule?.sessionAllowed ?? false).toBe(false);
    expect(card.shellRule?.floorSessionOnly).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(later.length + 2);
  });

  it.each(["default", "auto"] as const)("after the grant the ordinary %s-mode ask still brings the floor's card, and leaving the folders the out-of-directory card", async (mode) => {
    publishBoundary("boundary-link");
    const dialect = DIALECTS[0];
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager(mode, []);
    const granted = sessionGate(pm);
    await sessionRun(dialect, "default", "boundary-ordinary")(pm, granted.gate, registry);
    expect(granted.saves).toEqual([expect.objectContaining({ ok: true })]);
    expect(execute).toHaveBeenCalledOnce();
    for (const command of [dialect.command, dialect.other]) {
      const asked = cardGate("deny-once");
      await sessionRun(dialect, "default", "boundary-ordinary", command)(pm, asked.gate, registry);
      expect(asked.cards(), command).toHaveLength(1);
      expect(defined(asked.cards()[0], "card").allowedChoices).toEqual(["allow-once", "deny-once"]);
    }
    const outside = cardGate("deny-once");
    await new ToolExecutor(registry, undefined, pm, undefined, outside.gate).executeAll(
      [{ id: "boundary-ordinary-outside", name: dialect.toolName, input: { command: dialect.command, cwd: testRoot } }],
      { sessionId: "boundary-ordinary", permissionContext: permissionContext() },
    );
    expect(outside.cards()[0]).toMatchObject({ kind: "out-of-allowed-dir", allowedChoices: ["allow-once", "deny-once"] });
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(DIALECTS)("keeps the card once-only when another forced floor also applies for $toolName", async (dialect) => {
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await sessionRun(dialect, "default", "boundary-protected", dialect.protectedWrite)(manager("allow", []), approvals.gate, registry);
    expect(approvals.cards()).toHaveLength(1);
    const card = defined(approvals.cards()[0], "approval card");
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(card.shellRule?.sessionAllowed ?? false).toBe(false);
    expect(card.shellRule?.floorSessionOnly).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(DIALECTS)("keeps the out-of-directory card once-only for $toolName", async (dialect) => {
    publishBoundary("boundary-link");
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("deny-once");
    await new ToolExecutor(registry, undefined, manager("allow", []), undefined, approvals.gate).executeAll(
      [{ id: "directory-session", name: dialect.toolName, input: { command: dialect.command, cwd: testRoot } }],
      { sessionId: "boundary-directory-session", permissionContext: permissionContext() },
    );
    expect(approvals.cards()[0]).toMatchObject({ kind: "out-of-allowed-dir", allowedChoices: ["allow-once", "deny-once"] });
    expect(approvals.cards()[0]?.shellRule?.sessionAllowed ?? false).toBe(false);
  });
});
