import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { resolveVerifiedExecutable } from "../../shared/verified-executable.js";
import { holdSandboxGitWrites } from "../../shared/host-git.js";
import { PermissionManager } from "../permission-manager.js";
import { prepareVerifiedShellCommand, verifiedShellEnvironment, verifiedShellExecution, type VerifiedShellCommand } from "../verified-shell-command.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { inspectShellCommand } from "../rules/shell-exfiltration.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("node:child_process", { spy: true });
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../shared/powershell-startup-policy.js", () => ({ isPowerShellStartupPinned: () => true, POWERSHELL_STARTUP_UNPROVEN_REASON: "startup is unproven" }));
const originalPlatform = process.platform;
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  setProcessPlatform("linux");
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "verified-shell-")));
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("allow");
  vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: "/usr/bin/git" });
  vi.mocked(childProcess.execFileSync).mockReturnValue("git version 2.45.0\n");
});
afterEach(() => { setProcessPlatform(originalPlatform); vi.unstubAllEnvs(); vi.mocked(childProcess.execFileSync).mockRestore(); rmSync(cwd, { recursive: true, force: true }); });
const READ_CASES = [
  "git log", "git log --oneline -n 3", "git log 'HEAD'", "git show --no-patch HEAD",
  "git diff --cached --name-only", "git diff HEAD main --name-status", "git rev-parse --verify HEAD", "git branch --list",
] as const;

function permission(command: string, dialect: "bash" | "powershell", handle: VerifiedShellCommand | undefined, sandboxed: boolean, headless: boolean) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd }, shellExecution: { runsSandboxed: sandboxed }, headless,
    ...(handle === undefined ? {} : { verifiedShellCommand: handle }),
  });
}

describe("bound native command authority", () => {
  it.each((["bash", "powershell"] as const).flatMap((dialect) => READ_CASES.map((command) => ({ dialect, command }))))
    ("admits only the issued execution for $dialect $command", ({ dialect, command }) => {
      const identity = { command, dialect, cwd };
      const handle = prepareVerifiedShellCommand(identity);
      expect(handle).toBeDefined();
      const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
      expect(approval.exactRule).toBe(`${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`);
      expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }).exactRule).toBeNull();
      manager.setRules([withCurrentShellRuleVersion({ pattern: approval.exactRule!, action: "allow" })]);
      for (const sandboxed of [false, true]) {
        expect(permission(command, dialect, handle, sandboxed, false)).toMatchObject({ decision: "allow", layer: 3 });
        expect(permission(command, dialect, handle, sandboxed, true)).toMatchObject({ decision: "allow", layer: 3 });
        expect(permission(command, dialect, undefined, sandboxed, false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
        expect(permission(command, dialect, undefined, sandboxed, true)).toMatchObject({ decision: "deny", layer: 2 });
      }
      expect(verifiedShellExecution(handle, identity)?.command).toContain("'/usr/bin/git'");
    });

  it.each(["bash", "powershell"] as const)("keeps proved literal evaluation exact-only on %s", (dialect) => {
    vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: "/bin/bash" });
    const command = "bash --noprofile --norc -p -c 'printf ready'";
    const handle = prepareVerifiedShellCommand({ command, dialect, cwd });
    expect(handle).toBeDefined();
    const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
    expect(approval.exactRule).toBe(`${dialect === "bash" ? "Bash" : "PowerShell"}(${command})`);
    expect(permission(command, dialect, handle, true, false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    manager.setRules([withCurrentShellRuleVersion({ pattern: approval.exactRule!, action: "allow" })]);
    expect(permission(command, dialect, handle, false, true)).toMatchObject({ decision: "allow", layer: 3 });
  });

  it.each(["git status", "git diff", "git show", "git -c core.fsmonitor=evil status", "git -C .. log", "env git log", "git log; git log", "git log | cat", "git log > out", "GIT_CONFIG_COUNT=1 git log", "python3 -I -S ordinary.py", "fish -N -c 'printf ready'", "node -e 'ready'", "pwsh -NoProfile -File ordinary.ps1", 'bash --noprofile --norc -p -c "$runtime"'])("retains default refusal for %s", (command) => {
    for (const dialect of ["bash", "powershell"] as const) expect(prepareVerifiedShellCommand({ command, dialect, cwd })).toBeUndefined();
  });

  it("refuses missing installations before version discovery", () => {
    vi.mocked(resolveVerifiedExecutable).mockReturnValue(null);
    vi.mocked(childProcess.execFileSync).mockClear();
    expect(prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
  it("bounds input before parsing or installation discovery", () => {
    vi.mocked(resolveVerifiedExecutable).mockClear();
    expect(prepareVerifiedShellCommand({ command: "git log " + "x".repeat(2000), dialect: "bash", cwd })).toBeUndefined();
    expect(resolveVerifiedExecutable).not.toHaveBeenCalled();
  });
  it("rejects forged and mismatched sidecars", () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(verifiedShellExecution({} as VerifiedShellCommand, identity)).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, command: "git status" })).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, cwd: join(cwd, "other") })).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, dialect: "powershell" })).toBeUndefined();
  });
  it("sanitizes the complete child environment after wrapping", () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    const env = verifiedShellEnvironment(handle, identity, { PATH: "/untrusted", HOME: cwd, GIT_CONFIG_PARAMETERS: "'core.fsmonitor=evil'", GIT_CONFIG_COUNT: "999", GIT_CONFIG_KEY_99: "evil", git_trace: "marker", PAGER: "evil", LD_PRELOAD: "evil", DYLD_INSERT_LIBRARIES: "evil" });
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_COUNT).not.toBe("999");
    for (const key of ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_KEY_99", "git_trace", "PAGER", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) expect(env[key]).toBeUndefined();
    expect(env.HOME).toBe(cwd);
  });
  it("refuses pathspecs and retains their visible floors", () => {
    const identity = { command: "git log '.ssh/config'", dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(handle).toBeUndefined();
    const signals = inspectShellCommand(identity.command, cwd);
    expect(signals.outcome).toBe("visible-floor");
    expect(buildShellRuleApproval(identity.dialect, identity.command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).toBeNull();
  });
  it("refuses a proof after another invocation holds its workspace", () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    const release = holdSandboxGitWrites([cwd]);
    try {
      expect(verifiedShellExecution(handle, identity)).toBeUndefined();
      expect(prepareVerifiedShellCommand(identity)).toBeUndefined();
      expect(verifiedShellEnvironment(handle, identity, {}).GIT_NO_LAZY_FETCH).toBe("1");
      manager.setRules([withCurrentShellRuleVersion({ pattern: "Bash(git log)", action: "allow" })]);
      expect(permission(identity.command, identity.dialect, handle, false, true)).toMatchObject({ decision: "deny", layer: 2 });
    } finally { release(); }
    expect(verifiedShellExecution(handle, identity)).toBeDefined();
  });

});
