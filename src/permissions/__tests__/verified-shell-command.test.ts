import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
import { resolveVerifiedExecutable } from "../../shared/verified-executable.js";
import { PermissionManager } from "../permission-manager.js";
import { prepareVerifiedShellCommand, verifiedShellEnvironment, verifiedShellExecution, type VerifiedShellCommand } from "../verified-shell-command.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { inspectShellCommand } from "../rules/shell-exfiltration.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { holdSandboxGitWrites } from "../../shared/host-git.js";

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
  vi.mocked(resolveVerifiedExecutable).mockReset().mockImplementation((candidates) => candidates[0] === undefined ? null : { executable: candidates[0].executable });
  vi.mocked(childProcess.execFileSync).mockReset().mockReturnValue("git version 2.54.0\n");
  vi.mocked(childProcess.spawn).mockClear();
  mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
  mkdirSync(join(cwd, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(cwd, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(cwd, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
});
afterEach(() => { setProcessPlatform(originalPlatform); vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }); });
const READ_CASES = [
  "git log", "git log --oneline -n 3", "git log 'HEAD'", "git show --no-patch HEAD",
  "git diff 'HEAD~1' HEAD --raw", "git diff HEAD main --name-status", "git rev-parse --verify HEAD", "git branch --list",
] as const;
const LITERAL_COMMAND = "bash --noprofile --norc -p -c 'printf ready'";

function permission(command: string, dialect: "bash" | "powershell", handle: VerifiedShellCommand | undefined, sandboxed: boolean, headless: boolean) {
  return manager.checkDetailed(dialect, "builtin", "shell", null, {
    ruleSubject: { kind: "shell", dialect, command, cwd }, shellExecution: { runsSandboxed: sandboxed }, headless,
    ...(handle === undefined ? {} : { verifiedShellCommand: handle }),
  });
}

describe("bound native command authority", () => {
  it.each((["bash", "powershell"] as const).flatMap((dialect) => READ_CASES.map((command) => ({ dialect, command }))))
    ("admits checked repository reads for $dialect $command", ({ dialect, command }) => {
      const handle = prepareVerifiedShellCommand({ command, dialect, cwd });
      expect(handle).toBeDefined();
      expect(resolveVerifiedExecutable).toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
      const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
      const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
      expect(approval.exactRule).toBe(`${wrapper}(${command})`);
      expect(permission(command, dialect, handle, true, false)).toMatchObject({ decision: "allow" });
      expect(permission(command, dialect, handle, false, false)).toMatchObject({ decision: "ask" });
      manager.setRules([withCurrentShellRuleVersion({ pattern: `${wrapper}(git *)`, action: "allow" })]);
      expect(permission(command, dialect, handle, false, true)).toMatchObject({ decision: "deny" });
      manager.setRules([withCurrentShellRuleVersion({ pattern: approval.exactRule!, action: "allow" })]);
      for (const sandboxed of [false, true]) {
        expect(permission(command, dialect, handle, sandboxed, true)).toMatchObject({ decision: "allow", layer: 3 });
      }
      const identity = { command, dialect, cwd };
      expect(verifiedShellExecution(handle, identity)?.command).toContain(`'--git-dir=${join(cwd, ".git")}'`);
      expect(verifiedShellExecution(handle, identity)?.command).toContain(`'--work-tree=${cwd}'`);
      expect(verifiedShellEnvironment(handle, identity, { GIT_CONFIG_PARAMETERS: "evil", git_dir: "/outside", HOME: cwd })).toMatchObject({
        GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, GIT_REFERENCE_BACKEND: "files", GIT_CEILING_DIRECTORIES: cwd, HOME: cwd,
      });
    });

  it.each(["bash", "powershell"] as const)("keeps proved literal evaluation exact-only on %s", (dialect) => {
    const handle = prepareVerifiedShellCommand({ command: LITERAL_COMMAND, dialect, cwd });
    expect(handle).toBeDefined();
    const approval = buildShellRuleApproval(dialect, LITERAL_COMMAND, cwd, { allow: true, deny: true }, undefined, handle);
    const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
    expect(approval.exactRule).toBe(`${wrapper}(${LITERAL_COMMAND})`);
    expect(permission(LITERAL_COMMAND, dialect, handle, true, false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${wrapper}(bash *)`, action: "allow" })]);
    expect(permission(LITERAL_COMMAND, dialect, handle, true, false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
    manager.setRules([withCurrentShellRuleVersion({ pattern: approval.exactRule!, action: "allow" })]);
    for (const sandboxed of [false, true]) {
      expect(permission(LITERAL_COMMAND, dialect, handle, sandboxed, true)).toMatchObject({ decision: "allow", layer: 3 });
    }
    expect(verifiedShellExecution(handle, { command: LITERAL_COMMAND, dialect, cwd })?.command).toContain("'/usr/bin/bash'");
  });

  it.each(["git status", "git diff", "git show", "git -c core.fsmonitor=evil status", "git -C .. log", "env git log", "git log; git log", "git log | cat", "git log > out", "GIT_CONFIG_COUNT=1 git log", "python3 -I -S ordinary.py", "fish -N -c 'printf ready'", "node -e 'ready'", "pwsh -NoProfile -File ordinary.ps1", 'bash --noprofile --norc -p -c "$runtime"'])("retains default refusal for %s", (command) => {
    for (const dialect of ["bash", "powershell"] as const) expect(prepareVerifiedShellCommand({ command, dialect, cwd })).toBeUndefined();
  });

  it("refuses missing installations without a native probe", () => {
    vi.mocked(resolveVerifiedExecutable).mockReturnValue(null);
    expect(prepareVerifiedShellCommand({ command: LITERAL_COMMAND, dialect: "bash", cwd })).toBeUndefined();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
  it("refuses unchecked configuration before consulting the image", () => {
    writeFileSync(join(cwd, ".git", "config"), "[include]\npath=/outside/config\n");
    expect(prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
    expect(resolveVerifiedExecutable).not.toHaveBeenCalled();
    expect(childProcess.execFileSync).not.toHaveBeenCalled();
  });
  it("suspends an issued repository plan while sandbox writes are outstanding", () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    const release = holdSandboxGitWrites([cwd]);
    try {
      expect(prepareVerifiedShellCommand(identity)).toBeUndefined();
      expect(verifiedShellExecution(handle, identity)).toBeUndefined();
      expect(() => verifiedShellEnvironment(handle, identity, {})).toThrow("Verified shell command is no longer available");
    } finally { release(); }
    expect(verifiedShellExecution(handle, identity)).toBeDefined();
  });
  it("requires a supported protected Git version", () => {
    vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: "/verified-older-git" });
    vi.mocked(childProcess.execFileSync).mockReturnValue("git version 2.53.0\n");
    expect(prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
  });
  it.each(["git diff --cached --name-only", "git diff --staged --raw"])("never upgrades an index-reading command through a saved rule: %s", (command) => {
    for (const dialect of ["bash", "powershell"] as const) {
      const handle = prepareVerifiedShellCommand({ command, dialect, cwd });
      expect(handle).toBeUndefined();
      expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).toBeNull();
      const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
      manager.setRules([withCurrentShellRuleVersion({ pattern: `${wrapper}(${command})`, action: "allow" })]);
      expect(permission(command, dialect, handle, true, false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
      expect(permission(command, dialect, handle, false, true)).toMatchObject({ decision: "deny", layer: 2 });
    }
  });
  it("bounds input before parsing or installation discovery", () => {
    expect(prepareVerifiedShellCommand({ command: "bash " + "x".repeat(2000), dialect: "bash", cwd })).toBeUndefined();
    expect(resolveVerifiedExecutable).not.toHaveBeenCalled();
  });
  it("rejects forged and mismatched sidecars", () => {
    const identity = { command: LITERAL_COMMAND, dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(verifiedShellExecution({} as VerifiedShellCommand, identity)).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, command: "git log" })).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, cwd: join(cwd, "other") })).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, dialect: "powershell" })).toBeUndefined();
  });
  it("removes loader overrides from the complete child environment after wrapping", () => {
    const identity = { command: LITERAL_COMMAND, dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(verifiedShellEnvironment(handle, identity, { HOME: cwd, LD_PRELOAD: "evil", DYLD_INSERT_LIBRARIES: "evil", ld_library_path: "evil" })).toEqual({ HOME: cwd });
    expect(() => verifiedShellEnvironment({} as VerifiedShellCommand, identity, {})).toThrow("Verified shell command is no longer available for this invocation");
  });
  it("refuses pathspecs and retains their visible floors", () => {
    const identity = { command: "git log '.ssh/config'", dialect: "bash" as const, cwd };
    const handle = prepareVerifiedShellCommand(identity);
    expect(handle).toBeUndefined();
    expect(inspectShellCommand(identity.command, cwd).outcome).toBe("visible-floor");
    expect(buildShellRuleApproval(identity.dialect, identity.command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).toBeNull();
  });
});
