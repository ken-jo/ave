import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSourceHostResources } from "../../__tests__/support/source-host-resources.js";
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { toolUseAnswer } from "../../__tests__/support/standing-answer.js";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequest } from "../../permissions/approval-gate.js";

const spawnBoundary = vi.hoisted(() => ({
  mutate: undefined as (() => void) | undefined,
  cwd: undefined as string | undefined,
  helperArgs: undefined as string[] | undefined,
  helperExe: undefined as string | undefined,
  launcherExe: undefined as string | undefined,
  onHelper: undefined as ((helper: import("node:child_process").ChildProcess) => void) | undefined,
  commands: [] as string[],
  launcher: undefined as ChildProcess | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      if (String(args[0]).endsWith("ave-path-kind.exe")) {
        if (spawnBoundary.helperArgs !== undefined) args[1] = spawnBoundary.helperArgs;
        if (spawnBoundary.helperExe !== undefined) args[0] = spawnBoundary.helperExe;
        const helper = actual.spawn(...args);
        spawnBoundary.onHelper?.(helper);
        return helper;
      }
      spawnBoundary.commands.push(String(args[0]));
      if (String(args[0]).endsWith("ave-job.exe") && spawnBoundary.launcher !== undefined) return spawnBoundary.launcher;
      if (spawnBoundary.launcherExe !== undefined) args[0] = spawnBoundary.launcherExe;
      if (spawnBoundary.mutate !== undefined) {
        const mutate = spawnBoundary.mutate;
        spawnBoundary.mutate = undefined;
        spawnBoundary.cwd = String(args[2]?.cwd);
        mutate();
      }
      return actual.spawn(...args);
    }),
  };
});

import { PermissionManager } from "../../permissions/permission-manager.js";
import * as hostShellPermit from "../../permissions/host-shell-execution-permit.js";
import { buildHostShellExecutionPermitBinding, createShellApprovalDirectory, HOST_SHELL_DIRECTORY_HOLD_ERROR, mintHostShellExecutionPermit, recordHostShellPolicyAuthorization } from "../../permissions/host-shell-execution-permit.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, getHostShellExecutionPlan, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { backgroundShellManager, BashTool, createBashOutputTool, PowerShellTool } from "../shell-tools.js";
import { __resetManagedChildProcessesForTest, forceKillAndDrainManagedChildProcesses, forceKillManagedChildProcesses, sealManagedChildProcessAdmission } from "../../main/managed-child-processes.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import type { WindowsHoldVerdict } from "../../shared/windows-path-facts.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { HOST_SHELL_CWD_REVOKED_EXIT_CODE } from "../host-shell-cwd-guard.js";

withSourceHostResources();

let directory: string;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-cwd-spawn-")));
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  spawnBoundary.mutate = undefined;
  spawnBoundary.cwd = undefined;
  spawnBoundary.helperArgs = undefined;
  spawnBoundary.helperExe = undefined;
  spawnBoundary.launcherExe = undefined;
  spawnBoundary.onHelper = undefined;
  spawnBoundary.commands = [];
  spawnBoundary.launcher = undefined;
});
afterEach(async () => {
  spawnBoundary.mutate = undefined;
  spawnBoundary.helperArgs = undefined;
  spawnBoundary.helperExe = undefined;
  spawnBoundary.launcherExe = undefined;
  spawnBoundary.onHelper = undefined;
  delete process.env.AVE_TEST_HOLD_RECHECK;
  await cleanupTmpDir(directory);
});

async function authorizedContext(cwd: string, command = "touch marker", rulePatterns: readonly string[] = ["Bash(touch marker)"], background = false) {
  const plan = getHostShellExecutionPlan(background ? "default" : "host");
  const input = background
    ? { command, cwd, run_in_background: true as const, timeoutSeconds: 10 }
    : { command, cwd, executionMode: "host" as const, justification: "Run in the approved directory", timeoutSeconds: 10 };
  const manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setRules(rulePatterns.map((pattern) => ({ pattern, action: "allow" as const, shellRuleVersion: SHELL_RULE_CANONICAL_VERSION })));
  const decision = manager.checkDetailed("bash", "builtin", "shell", null, {
    hostShellExecutionPlan: plan, ruleSubject: { kind: "shell", dialect: "bash", command: input.command, cwd: join(directory, cwd) },
    // An explicit host retry runs without a sandbox, so only an exact Bash(<command>) allow issues the rule proof (owner 2026-10-25, unsandboxed shell exact-rule requirement).
    shellExecution: { runsSandboxed: false },
  });
  const binding = buildHostShellExecutionPermitBinding({
    plan, toolName: "bash", toolUseId: "cwd-spawn", rawInput: input, executionCwd: directory, extraAllowedDirectories: [],
  })!;
  let approvalDecision: ApprovalDecision | undefined;
  if (background) recordHostShellPolicyAuthorization(binding, undefined);
  else if (decision.decision !== "allow") {
    const webContents = { isDestroyed: vi.fn(() => false), send: vi.fn() };
    const gate = new ApprovalGate(webContents as never);
    const directory = createShellApprovalDirectory(binding);
    try {
    const pending = gate.requestAndWait({
      id: "cwd-spawn-approval", category: "tool", toolName: "bash", toolCategory: "shell", args: input,
      reason: "Approve the one host command used by the cwd race fixture", source: "builtin", createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"], forceExplicit: true, hostShellExecutionPermitBinding: binding,
      processCwd: { directory },
    });
    const request = webContents.send.mock.calls[0]?.[1] as ApprovalRequest | undefined;
    if (!request?.nonce || !request.hmac) throw new Error("ApprovalGate did not publish a sealed request");
    gate.resolveFromDesktopRenderer("cwd-spawn-approval", { requestId: "cwd-spawn-approval", choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, webContents as never);
    approvalDecision = await pending;
    } finally {
      directory.dispose();
    }
  }
  const permit = mintHostShellExecutionPermit({
    plan, binding, answer: approvalDecision && toolUseAnswer("cwd-spawn", approvalDecision),
    ...(approvalDecision === undefined ? { allowRuleDecision: decision, permissionManager: manager } : {}),
  });
  expect(permit).toBeDefined();
  return { input, context: { cwd: directory, extraAllowedDirectories: [], metadata: { toolUseId: "cwd-spawn" }, hostShellExecutionPlan: plan, hostShellExecutionPermit: permit } };
}

// A bare tool rule does not admit a shell; exact Bash(...) rules cover each command.
const COMPOUND_RULES = ["Bash(printf command-ran)", "Bash(printf C)", "Bash(exit 0)", "Bash(exit 197)"];

describe("host cwd approval", () => {
  it.each(["explicit", "ordinary"] as const)("refuses to launch after the %s card's directory alias is retargeted", async (cardKind) => {
    if (cardKind === "ordinary") setShellSandboxRequestedAtBoot(false);
    const first = join(directory, "first");
    const second = join(directory, "second");
    const alias = join(directory, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias, "junction");
    const webContents = { isDestroyed: () => false, send: vi.fn() };
    const gate = new ApprovalGate(webContents as never);
    const registry = new ToolRegistry();
    const tool = new BashTool();
    const launch = vi.spyOn(tool, "execute").mockResolvedValue({ output: "mock launch", isError: false });
    registry.register(tool);
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("strict");
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate);
    const abort = new AbortController();
    try {
      const invoke = (id: string) => executor.executeAll([{ id, name: "bash", input: {
        command: "touch marker", cwd: "alias",
        ...(cardKind === "explicit" ? { executionMode: "host", justification: "Use the workspace fixture" } : {}),
      } }], { sessionId: "cwd-consent", executionCwd: directory, abortSignal: abort.signal, permissionContext: { trustOrigin: "llm-tool-arg" } });
      const awaitCard = (pending: ReturnType<typeof invoke>) => Promise.race([
        vi.waitFor(() => {
          const request = webContents.send.mock.calls.find(([channel]) => channel === "ave:approval:request")?.[1] as ApprovalRequest | undefined;
          if (!request) throw new Error("No host approval request");
          return request;
        }),
        pending.then(([result]) => { throw new Error(result?.content); }),
      ]);
      const pending = invoke("cwd-consent");
      const card = await awaitCard(pending);
      if (cardKind === "ordinary") expect(card.allowedChoices).toBeUndefined();
      expect(card.executionCwd).toBe(first);
      unlinkSync(alias);
      symlinkSync(second, alias, "junction");
      gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, webContents as never);
      const [result] = await pending;
      expect.soft(launch).not.toHaveBeenCalled();
      expect(result?.is_error).toBe(true);
      expect(result?.content).toMatch(/working directory.*changed/i);

      webContents.send.mockClear();
      const retry = invoke("cwd-consent-retry");
      const fresh = await awaitCard(retry);
      expect(fresh.id).not.toBe(card.id);
      expect(fresh.executionCwd).toBe(second);
      gate.resolveFromDesktopRenderer(fresh.id, { requestId: fresh.id, choice: "allow-once", nonce: fresh.nonce, hmac: fresh.hmac }, webContents as never);
      const [completed] = await retry;
      expect(completed?.content).toContain("mock launch");
      expect(completed?.is_error).not.toBe(true);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      abort.abort();
    }
  });
});

describe("host cwd races after permit consumption", () => {
  it("preserves an ordinary exit 197 and the command's output", async () => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current", "printf command-ran; exit 197", COMPOUND_RULES);
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(true);
    expect(result.metadata?.returncode).toBe(197);
    expect(result.output).toContain("command-ran");
    expect(result.output).not.toMatch(/permission policy changed|authorization again/i);
  });

  it("closes the guard channel before the command can write to it", async () => {
    mkdirSync(join(directory, "current"));
    const command = "bash -c 'printf command-ran; if { printf C >&3; } 2>/dev/null; then exit 0; else exit 197; fi'";
    const { input, context } = await authorizedContext("current", command, [`Bash(${command})`]);
    const result = await new BashTool().execute(input, context);
    expect(result.output).toContain("command-ran");
    expect(result.metadata?.returncode).toBe(197);
    expect(result.output).not.toMatch(/permission policy changed|authorization again/i);
  });

  it.each(["project", "user"] as const)("honours a %s deny submitted by this host at native spawn", async (scope) => {
    const current = join(directory, "current");
    mkdirSync(current);
    const { input, context } = await authorizedContext("current");
    const writer = new PermissionManager(join(directory, "permissions.json"));
    let persisted: Promise<void> | undefined;
    spawnBoundary.mutate = () => {
      persisted = writer.addRulePersist({ pattern: "Bash(touch *)", action: "deny" }, scope === "project"
        ? { kind: "project", projectCwd: current } : { kind: "user" });
    };
    const result = await new BashTool().execute(input, context);
    await persisted;
    expect(persisted).toBeDefined();
    if (process.platform === "win32") {
      // The synchronous native handoff precedes this queued write on platforms without a child guard, so the mutation applies to the next invocation.
      expect(result.isError).toBe(false);
      expect(existsSync(join(current, "marker"))).toBe(true);
      return;
    }
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/permission policy changed/i);
    expect(existsSync(join(current, "marker"))).toBe(false);
  });

  it("validates an external policy write at native spawn before granting the waiting child", async () => {
    const current = join(directory, "current");
    mkdirSync(current);
    const { input, context } = await authorizedContext("current");
    spawnBoundary.mutate = () => {
      writeFileSync(join(directory, "permissions.json"), JSON.stringify({
        version: 1, rules: [{ pattern: "Bash(touch *)", action: "deny" }], mode: "default", updatedAt: new Date().toISOString(),
      }));
    };
    const result = await new BashTool().execute(input, context);
    if (process.platform === "win32") {
      // Uncoordinated edits after native handoff validation reach the next call.
      expect(result.isError).toBe(false);
      expect(existsSync(join(current, "marker"))).toBe(true);
      return;
    }
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/permission policy changed/i);
    expect(existsSync(join(current, "marker"))).toBe(false);
  });

  it("preserves literal quoted directory names and supported newlines", async () => {
    const name = process.platform === "win32" ? "quoted' directory" : "quoted' directory\n";
    mkdirSync(join(directory, name));
    const { input, context } = await authorizedContext(name);
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(false);
    expect(existsSync(join(directory, name, "marker"))).toBe(true);
  });

  it("spawns in the verified physical directory when a symlink is retargeted at native spawn", async () => {
    const first = join(directory, "first");
    const second = join(directory, "second");
    mkdirSync(first);
    mkdirSync(second);
    const current = join(directory, "current");
    symlinkSync(first, current, "junction");
    const { input, context } = await authorizedContext("current");
    spawnBoundary.mutate = () => {
      unlinkSync(current);
      symlinkSync(second, current, "junction");
    };
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.cwd).toBe(first);
    expect(result.isError).toBe(false);
    expect(existsSync(join(first, "marker"))).toBe(true);
    expect(existsSync(join(second, "marker"))).toBe(false);
  });

  it("keeps a directory replaced after the host permit check out of the command (child check on POSIX, held chain on Windows)", async () => {
    const current = join(directory, "current");
    const original = join(directory, "original");
    mkdirSync(current);
    const { input, context } = await authorizedContext("current");
    let renameError: string | undefined;
    spawnBoundary.mutate = () => {
      try {
        renameSync(current, original);
        mkdirSync(current);
      } catch (error) {
        renameError = (error as NodeJS.ErrnoException).code;
      }
    };
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.cwd).toBe(current);
    if (process.platform === "win32") {
      // No child-side check: the host hold refuses the rename, so the command runs in the approved directory.
      expect(renameError).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
      expect(result.isError).toBe(false);
      expect(existsSync(join(current, "marker"))).toBe(true);
      expect(existsSync(original)).toBe(false);
      return;
    }
    expect(renameError).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.metadata?.returncode).toBe(HOST_SHELL_CWD_REVOKED_EXIT_CODE);
    expect(result.output).toMatch(/working directory.*changed/i);
    expect(existsSync(join(current, "marker"))).toBe(false);
    expect(existsSync(join(original, "marker"))).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("Windows host cwd hold at launch", () => {
  const helperExitsOnReply = (helper: import("node:child_process").ChildProcess) => {
    helper.stdout?.once("data", () => queueMicrotask(() => {
      helper.kill();
      helper.emit("exit", null, "SIGTERM");
    }));
  };

  it.each([
    ["the directory cannot be held", () => { spawnBoundary.helperArgs = ["--hold", "relative"]; }],
    ["the helper exits before its reply", () => { spawnBoundary.onHelper = helper => { helper.kill(); }; }],
    ["the helper reply is malformed", () => { spawnBoundary.onHelper = helper => { queueMicrotask(() => helper.stdout?.emit("data", Buffer.from("not a facts row\n"))); }; }],
    ["the helper output stream fails", () => { spawnBoundary.onHelper = helper => { helper.stdout?.destroy(new Error("pipe broke")); }; }],
  ])("refuses the spawn when %s", async (_name, arrange) => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current");
    arrange();
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(HOST_SHELL_DIRECTORY_HOLD_ERROR);
    expect(spawnBoundary.commands).toEqual([]);
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
  });

  it("refuses the spawn when the helper exits after its reply and before the handoff", async () => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current");
    spawnBoundary.onHelper = helperExitsOnReply;
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(true);
    expect(result.output).toContain(HOST_SHELL_DIRECTORY_HOLD_ERROR);
    expect(spawnBoundary.commands).toEqual([]);
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
  });

  const killHelper = (helper: import("node:child_process").ChildProcess | undefined) =>
    execFileSync("taskkill", ["/PID", String(helper?.pid), "/F"], { stdio: "ignore", windowsHide: true });

  it("refuses the command when the helper dies before the host sees its exit", async () => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current");
    let helper: import("node:child_process").ChildProcess | undefined;
    spawnBoundary.onHelper = (child) => { helper = child; };
    // Runs inside the synchronous handoff, after the host's last hold check and before the launch.
    spawnBoundary.mutate = () => killHelper(helper);
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.commands).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cwd-pin-lost");
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
  });

  it("stops the command and a descendant holding its output when the helper dies after launch", async () => {
    mkdirSync(join(directory, "current"));
    const command = "(sleep 4; touch late) & sleep 4 && touch marker";
    const { input, context } = await authorizedContext("current", command, ["Bash(sleep 4)", "Bash(touch late)", "Bash(touch marker)"]);
    let helper: import("node:child_process").ChildProcess | undefined;
    spawnBoundary.onHelper = (child) => { helper = child; };
    spawnBoundary.mutate = () => { setTimeout(() => killHelper(helper), 1000); };
    const started = Date.now();
    const result = await new BashTool().execute(input, context);
    // The OS stops the job: nothing on the host signals the command, and the result does not wait for the descendant.
    expect(Date.now() - started).toBeLessThan(3500);
    expect(spawnBoundary.commands.filter(command => /taskkill/iu.test(command))).toEqual([]);
    // Only the launcher can say the run was reaped, and it went with the job.
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cwd-pin-unconfirmed");
    expect(result.notice).toContain("cwd-pin-unconfirmed");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, 5500 - (Date.now() - started))));
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
    expect(existsSync(join(directory, "current", "late"))).toBe(false);
  }, 15000);

  it("reports a short command as failed when its directory no longer stands at the end of the run", async () => {
    const fixture = join(process.cwd(), "resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
    if (!existsSync(fixture)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current");
    spawnBoundary.helperExe = fixture;
    process.env.AVE_TEST_HOLD_RECHECK = "lost";
    const result = await new BashTool().execute(input, context);
    expect(existsSync(join(directory, "current", "marker"))).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("cwd-pin-lost");
    expect(result.notice).toContain("cwd-pin-lost");
    expect(result.metadata).not.toHaveProperty("returncode");
    expect(result.output).not.toMatch(/exited with code|terminated by signal/u);
  });

  it.each([
    ["confirms", undefined, false],
    ["fails when the directory no longer stands for", "lost", true],
  ] as const)("%s a PowerShell command on the plain host route", async (_name, recheck, failed) => {
    const fixture = join(process.cwd(), "resources", "windows-path-kind", process.arch, "ave-path-kind-hold-fixture.exe");
    if (!existsSync(fixture)) throw new Error("Build the hold fixture: bun run build:windows-job -- -Helper path-kind -HoldFixture");
    mkdirSync(join(directory, "current"));
    const plan = getHostShellExecutionPlan();
    const input = { command: "Set-Content -LiteralPath marker -Value held; Write-Output ('pinned' + 'run')", cwd: "current", timeoutSeconds: 30 };
    const binding = buildHostShellExecutionPermitBinding({
      plan, toolName: "powershell", toolUseId: "cwd-spawn", rawInput: input, executionCwd: directory, extraAllowedDirectories: [],
    });
    if (binding === undefined) throw new Error("no permit binding");
    recordHostShellPolicyAuthorization(binding, undefined);
    const permit = mintHostShellExecutionPermit({ plan, binding, answer: undefined });
    expect(permit).toBeDefined();
    spawnBoundary.helperExe = fixture;
    if (recheck !== undefined) process.env.AVE_TEST_HOLD_RECHECK = recheck;
    const result = await new PowerShellTool().execute(input, {
      cwd: directory, extraAllowedDirectories: [], metadata: { toolUseId: "cwd-spawn" }, hostShellExecutionPlan: plan, hostShellExecutionPermit: permit,
    });
    expect(spawnBoundary.commands.filter(command => command.endsWith("ave-job.exe"))).toHaveLength(1);
    expect(existsSync(join(directory, "current", "marker"))).toBe(true);
    expect(result.output).toContain("pinnedrun");
    expect(result.isError).toBe(failed);
    if (failed) {
      expect(result.notice).toContain("cwd-pin-lost");
      expect(result.metadata).toMatchObject({ cwdPinLost: true });
      expect(result.metadata).not.toHaveProperty("returncode");
      expect(result.output).not.toMatch(/exited with code|terminated by signal/u);
    } else expect(result.notice).toBeUndefined();
  }, 60000);

  it("reports a launcher that never starts as a spawn failure the hold could not confirm", async () => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current");
    spawnBoundary.launcherExe = join(directory, "absent.exe");
    const result = await new BashTool().execute(input, context);
    expect(spawnBoundary.commands).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("spawn failed");
    expect(result.output).toContain("cwd-pin-unconfirmed");
    expect(result.notice).toContain("cwd-pin-unconfirmed");
    expect(result.metadata).toMatchObject({ cwdPinUnconfirmed: true });
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
  });

  it("stops a descendant still holding the output when the command exits", async () => {
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current", "(sleep 3; touch late) & touch marker", ["Bash(sleep 3)", "Bash(touch late)", "Bash(touch marker)"]);
    const started = Date.now();
    const result = await new BashTool().execute(input, context);
    expect(result.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(2500);
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect(existsSync(join(directory, "current", "marker"))).toBe(true);
    expect(existsSync(join(directory, "current", "late"))).toBe(false);
  }, 15000);

  it("refuses a background job when the helper has exited before the handoff", async () => {
    setShellSandboxRequestedAtBoot(false);
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current", "touch marker", ["Bash(touch marker)"], true);
    spawnBoundary.onHelper = helperExitsOnReply;
    const outcome = await new BashTool().execute(input, context).catch((error: unknown) => error);
    expect(String(outcome instanceof Error ? outcome.message : (outcome as { output?: string }).output)).toContain(HOST_SHELL_DIRECTORY_HOLD_ERROR);
    expect(spawnBoundary.commands).toEqual([]);
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
  });

  it("does not start a background job when the call is cancelled during hold acquisition", async () => {
    setShellSandboxRequestedAtBoot(false);
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current", "touch marker", ["Bash(touch marker)"], true);
    const abort = new AbortController();
    spawnBoundary.onHelper = () => abort.abort();
    const outcome = await new BashTool().execute(input, { ...context, abortSignal: abort.signal }).catch((error: unknown) => error);
    expect(abort.signal.aborted).toBe(true);
    expect(outcome).not.toMatchObject({ isError: false });
    expect(spawnBoundary.commands).toEqual([]);
    expect(existsSync(join(directory, "current", "marker"))).toBe(false);
  });

  it.each(["before spawn", "after bind"] as const)("honors quit %s during a deferred background handoff", async (order) => {
    setShellSandboxRequestedAtBoot(false);
    mkdirSync(join(directory, "current"));
    const { input, context } = await authorizedContext("current", "touch marker", ["Bash(touch marker)"], true);
    const entered = deferred<void>();
    const resume = deferred<void>();
    const verdict = deferred<WindowsHoldVerdict>();
    const kill = vi.fn(() => true);
    const stop = vi.fn(() => {
      setTimeout(() => verdict.resolve({ kind: "unconfirmed" }), TOOL_TIMEOUT_POLICY.windowsHoldStopMs);
      return verdict.promise;
    });
    const bind = vi.fn(() => ({ verdict: verdict.promise, stop }));
    spawnBoundary.launcher = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill }) as unknown as ChildProcess;
    const handoffSpy = vi.spyOn(hostShellPermit, "withHostShellExecutionHandoff").mockImplementationOnce(async (_authorization, handoff) => {
      if (order === "before spawn") {
        entered.resolve();
        await resume.promise;
      }
      const started = handoff({
        bind, launcherArgs: [], assertHeld() {}, dispose() {}, stdio: undefined,
        command: (executable, args) => ({ executable, args: [...args] }),
      });
      if (order === "after bind") {
        entered.resolve();
        await resume.promise;
      }
      return started;
    });
    const pending = new BashTool().execute(input, { ...context, metadata: { ...context.metadata, sessionId: "owner" } });
    const outcome = pending.catch((error: unknown) => error);
    let quitting: Promise<unknown> | undefined;
    const drain = vi.fn(() => forceKillAndDrainManagedChildProcesses("test quit"));
    try {
      await Promise.race([entered.promise, pending.then(() => { throw new Error("background handoff was not entered"); })]);
      vi.useFakeTimers();
      sealManagedChildProcessAdmission("test quit");
      quitting = backgroundShellManager.stopAllHeldShells(new AbortController().signal).then(drain);
      if (order === "before spawn") {
        await quitting;
        resume.resolve();
        expect(await outcome).toMatchObject({ message: expect.stringContaining("after shutdown started") });
        expect(bind).not.toHaveBeenCalled();
        expect(spawnBoundary.commands).toEqual([]);
      } else {
        expect(bind).toHaveBeenCalledOnce();
        expect(stop).toHaveBeenCalledOnce();
        expect(drain).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.windowsHoldStopMs - 1);
        expect(drain).not.toHaveBeenCalled();
        // The emergency sweep must also defer to the held owner after the stop request.
        forceKillManagedChildProcesses("test emergency sweep");
        expect(kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await quitting;
        expect(drain).toHaveBeenCalledOnce();
        expect(kill).not.toHaveBeenCalled();
        resume.resolve();
        const result = await pending;
        const output = await createBashOutputTool().execute({ shellId: result.metadata?.shellId }, { ...context, metadata: { sessionId: "owner" } });
        expect(output).toMatchObject({ isError: true, notice: expect.stringContaining("cwd-pin-unconfirmed") });
        expect(JSON.parse(output.output)).toMatchObject({ status: "failed" });
      }
    } finally {
      resume.resolve();
      verdict.resolve({ kind: "unconfirmed" });
      await outcome;
      await quitting;
      backgroundShellManager._resetForTest();
      __resetManagedChildProcessesForTest();
      handoffSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
