// A requested OS sandbox that could not start leaves host shells to a human ask on every platform: once, or for this session; never saved.
vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
import type { ToolRegistry } from "../registry.js";
import type { ToolExecutionContext } from "../types.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalGate } from "../../permissions/approval-gate.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest } from "../../permissions/sandbox-capability.js";
import { requestedSandboxUnavailable } from "../../__tests__/support/host-shell-sandbox-fixtures.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { __resetShellResolverCache } from "../../lib/shell-resolver.js";
import { shellExecutionEnvironmentLines } from "../../shared/shell-execution-environment.js";
import { t } from "../../i18n/runtime.js";
import { userPermissionContext as permissionContext } from "./tool-context-fixture.js";
import { cardGate, defined, probe, sessionGate } from "../../__tests__/support/forced-shell-card.js";

const ORIGINAL_PLATFORM = process.platform;
let testRoot: string;

const DIALECTS = [
  { toolName: "bash", create: () => new BashTool(), command: "echo unavailable", prefixRule: "Bash(echo *)" },
  { toolName: "powershell", create: () => new PowerShellTool(), command: "Write-Output unavailable", prefixRule: "PowerShell(Write-Output *)" },
] as const;

const PLATFORMS = (["win32", "linux", "darwin"] as const).map(platform => ({ platform }));

function rulesFile(mode: string): string {
  return join(testRoot, `permissions-${mode}.json`);
}

function manager(mode: "default" | "auto" | "allow", rules: readonly string[]): PermissionManager {
  const pm = new PermissionManager(rulesFile(mode));
  pm.setMode(mode);
  pm.setRules(rules.map(pattern => pattern.includes("(")
    ? { pattern, action: "allow" as const, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION }
    : { pattern, action: "allow" as const }));
  setReviewerForTest(pm, { classifier: {} as never, cache: {} as never, recentlyDenied: makeRecentlyDeniedStore(join(testRoot, "recently-denied.json")) });
  pm.dispatchReviewer = vi.fn(async () => ({ verdict: { level: "low" as const, reason: "Bounded effect" }, cacheReason: "miss-not-found" as const,
    outcome: "fresh" as const, judge: reviewerJudgeOutcomeForTest("allow", "Bounded effect") })) as never;
  return pm;
}

describe.each(PLATFORMS)("host shells when the requested sandbox is unavailable on $platform", ({ platform }) => {
  beforeEach(() => {
    testRoot = realpathSync(mkdtempSync(join(tmpdir(), "unavailable-shell-")));
    __resetShellResolverCache();
    vi.spyOn(powerShellStartup, "isPowerShellStartupPinned").mockReturnValue(true);
    childProcessMock.execFileSync.mockImplementation((_file, args: readonly string[]) =>
      args.join(" ").includes("AVE_PROBE_RHS") ? "parent\0AB\0" : "__ave_shell_ok__");
    requestedSandboxUnavailable(platform);
  });

  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
    __resetShellResolverCache();
    childProcessMock.execFileSync.mockReset();
    vi.restoreAllMocks();
    setProcessPlatform(ORIGINAL_PLATFORM);
    rmSync(testRoot, { recursive: true, force: true });
  });

  const run = (dialect: (typeof DIALECTS)[number], sessionId: string, command: string = dialect.command) => {
    let serial = 0;
    return (pm: PermissionManager, gate: ApprovalGate, registry: ToolRegistry, headless = false) => runWithToolExecutionCwd(testRoot, () =>
      new ToolExecutor(registry, undefined, pm, undefined, gate).executeAll(
        [{ id: `${sessionId}-${++serial}`, name: dialect.toolName, input: { command } }],
        { sessionId, permissionContext: permissionContext(headless ? { headless: true } : {}) },
      ));
  };

  const bypasses = DIALECTS.flatMap(dialect => ([
    { dialect, mode: "default" as const, label: "saved prefix and tool allow rules", rules: [dialect.prefixRule, dialect.toolName] },
    { dialect, mode: "allow" as const, label: "allow mode", rules: [] },
    { dialect, mode: "auto" as const, label: "auto review", rules: [] },
  ]));

  it.each(bypasses)("$dialect.toolName with $label asks on the forced card and spawns only after approval", async ({ dialect, mode, rules }) => {
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager(mode, rules);
    const start = run(dialect, "unavailable-shell");

    const denied = cardGate("deny-once");
    const refused = await start(pm, denied.gate, registry);
    expect(denied.cards()).toHaveLength(1);
    const card = defined(denied.cards()[0], "approval card");
    expect(card.executionPlan).toMatchObject({ platform, mode: "plain", fallbackReason: "requested-sandbox-unavailable", requiresExplicitUserApproval: true });
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(card.shellRule).toMatchObject({ exactRule: null, sessionAllowed: true, persistentAllowed: false, denyAllowed: false, floorSessionOnly: true });
    expect(shellExecutionEnvironmentLines(defined(card.executionPlan, "card execution plan"))).toContain(t("shellExecution.sandboxUnavailableAsk"));
    expect(execute).not.toHaveBeenCalled();
    expect(refused[0]?.is_error).toBe(true);
    expect(pm.dispatchReviewer).not.toHaveBeenCalled();

    const approved = cardGate("allow-once");
    const ran = await start(pm, approved.gate, registry);
    expect(approved.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    const ctx = defined(execute.mock.calls[0], "execute call")[0] as ToolExecutionContext;
    expect(ctx.hostShellExecutionPermit).toBeDefined();
    expect(ctx.hostShellExecutionPlan).toMatchObject({ mode: "plain", sandboxed: false, substrate: "none", capability: { kind: "none" } });
    expect(ran[0]?.is_error).toBeUndefined();

    // Once is once: the same command asks again.
    const again = cardGate("deny-once");
    await start(pm, again.gate, registry);
    expect(again.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each(bypasses)("a headless $dialect.toolName with $label is denied with no approver", async ({ dialect, mode, rules }) => {
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const approvals = cardGate("allow-once");
    const result = await run(dialect, "unavailable-headless")(manager(mode, rules), approvals.gate, registry, true);
    expect(approvals.cards()).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(result[0]?.content).toContain(NO_APPROVER_MESSAGE);
  });

  it.each(DIALECTS)("$toolName allowed for this session runs later shells of that conversation without a card and saves no rule", async (dialect) => {
    const execute = vi.fn();
    const registry = probe(dialect.create, execute);
    const pm = manager("default", [dialect.prefixRule]);
    const rulesBefore = existsSync(rulesFile("default")) ? readFileSync(rulesFile("default"), "utf8") : undefined;
    const start = run(dialect, "unavailable-session");

    const first = sessionGate(pm);
    await start(pm, first.gate, registry);
    expect(first.cards()).toHaveLength(1);
    expect(first.saves).toEqual([expect.objectContaining({ ok: true, scope: "session", action: "allow" })]);
    expect(execute).toHaveBeenCalledOnce();

    const next = cardGate("deny-once");
    await start(pm, next.gate, registry);
    await run(dialect, "unavailable-session", `${dialect.command}2`)(pm, next.gate, registry);
    expect(next.cards()).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(3);
    expect((defined(execute.mock.calls[2], "third call")[0] as ToolExecutionContext).hostShellExecutionPermit).toBeDefined();

    // Nothing was written: another conversation and a restart ask again, and headless stays denied.
    expect(existsSync(rulesFile("default")) ? readFileSync(rulesFile("default"), "utf8") : undefined).toBe(rulesBefore);
    const otherSession = cardGate("deny-once");
    await run(dialect, "unavailable-other-session")(pm, otherSession.gate, registry);
    expect(otherSession.cards()).toHaveLength(1);
    const restarted = cardGate("deny-once");
    await start(manager("default", [dialect.prefixRule]), restarted.gate, registry);
    expect(restarted.cards()).toHaveLength(1);
    const headless = await start(pm, cardGate("allow-once").gate, registry, true);
    expect(headless[0]?.content).toContain(NO_APPROVER_MESSAGE);
    pm.endSession("unavailable-session");
    const ended = cardGate("deny-once");
    await start(pm, ended.gate, registry);
    expect(ended.cards()).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
