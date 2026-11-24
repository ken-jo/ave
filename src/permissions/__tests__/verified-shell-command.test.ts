import { stabilizeFixtureAncestorStats } from "../../__tests__/support/fixture-ancestor-stats.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, renameSync, symlinkSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as childProcess from "node:child_process";
import * as fsPromises from "node:fs/promises";
import { resolveVerifiedExecutableAsync } from "../../shared/verified-executable.js";
import { resolveHostGit } from "../../shared/host-git-executable.js";
import { PermissionManager } from "../permission-manager.js";
import { prepareVerifiedShellCommand, verifiedShellEnvironment, verifiedShellExecution, verifiedShellRequiresResultCheck, verifiedShellResultRefusal, type VerifiedShellCommand } from "../verified-shell-command.js";
import { buildShellRuleApproval, shellRuleCoversCommand } from "../rules/shell-rule-approval.js";
import { GIT_VERSION_FLOOR } from "../rules/git-readonly-argv.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { inspectShellCommand } from "../rules/literal-shell-inspection.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { holdSandboxGitWrites } from "../../shared/host-git.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn(), resolveVerifiedExecutableAsync: vi.fn() }));
vi.mock("node:fs/promises", { spy: true });
vi.mock("../../shared/host-git-executable.js", { spy: true });
vi.mock("../../shared/powershell-startup-policy.js", () => ({ isPowerShellStartupPinned: () => true, POWERSHELL_STARTUP_UNPROVEN_REASON: "startup is unproven" }));
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;
/** Answers the asynchronous version probe; an Error models a failed launch, exit, timeout or output limit. */
function mockGitVersion(output: string | Error): void {
  vi.mocked(childProcess.execFile).mockReset().mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as ExecFileCallback;
    setImmediate(() => typeof output === "string" ? callback(null, output, "") : callback(output, "", ""));
    return {} as childProcess.ChildProcess;
  }) as unknown as typeof childProcess.execFile);
}
const originalPlatform = process.platform;
let cwd: string;
let manager: PermissionManager;
beforeEach(() => {
  setProcessPlatform("linux");
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "verified-shell-")));
  stabilizeFixtureAncestorStats(cwd);
  vi.stubEnv("AVE_HOME", join(cwd, "state"));
  manager = new PermissionManager(join(cwd, "permissions.json"));
  manager.setMode("default");
  vi.mocked(resolveVerifiedExecutableAsync).mockReset().mockImplementation(async (candidates) => candidates[0] === undefined ? null : { executable: candidates[0].executable });
  mockGitVersion("git version 2.54.0\n");
  vi.mocked(fsPromises.lstat).mockClear();
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
  it("uses the shared resolver with the protected Git installation policy", async () => {
    vi.stubEnv("PATH", join(cwd, "bin"));
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    expect(await prepareVerifiedShellCommand(identity)).toBeDefined();
    expect(resolveHostGit).toHaveBeenCalledWith("verified");
    expect(resolveVerifiedExecutableAsync).toHaveBeenCalledWith([
      { executable: "/usr/bin/git", installationRoots: ["/usr/bin/git"] },
      { executable: "/opt/git/bin/git", installationRoots: ["/opt/git"] },
    ]);
  });

  it.each(["bash", "powershell"] as const)("rechecks unchanged checked repository results on %s", async dialect => {
    const identity = { command: "git rev-parse --verify HEAD", dialect, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(verifiedShellRequiresResultCheck(handle, identity)).toBe(true);
    expect(await verifiedShellResultRefusal(handle, identity)).toBeUndefined();
    expect(await verifiedShellResultRefusal(handle, identity)).toBeUndefined();
  });

  it.each([
    ["missing metadata", () => rmSync(join(cwd, ".git"), { recursive: true })],
    ["gitfile", () => { rmSync(join(cwd, ".git"), { recursive: true }); writeFileSync(join(cwd, ".git"), "gitdir: /outside\n"); }],
    ["new alternates", () => { mkdirSync(join(cwd, ".git", "objects", "info")); writeFileSync(join(cwd, ".git", "objects", "info", "alternates"), "/outside\n"); }],
    ["ref symbolic link", () => { const outside = join(cwd, "outside-ref"); writeFileSync(outside, "a".repeat(40) + "\n"); symlinkSync(outside, join(cwd, ".git", "refs", "heads", "main")); }],
    ["regular ref addition", () => writeFileSync(join(cwd, ".git", "refs", "heads", "main"), "a".repeat(40) + "\n")],
    ["packed ref type", () => mkdirSync(join(cwd, ".git", "packed-refs"))],
    ["config rewrite", () => writeFileSync(join(cwd, ".git", "config"), "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = false\n")],
    ["outside include", () => writeFileSync(join(cwd, ".git", "config"), "[include]\npath = /outside\n")],
    ["metadata rename", () => renameSync(join(cwd, ".git"), join(cwd, "renamed-metadata"))],
  ] as const)("refuses checked output after %s", async (_name, mutate) => {
    const identity = { command: "git rev-parse --verify HEAD", dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(await verifiedShellResultRefusal(handle, identity)).toBeUndefined();
    mutate();
    expect(await verifiedShellResultRefusal(handle, identity)).toBe("Read-only Git output discarded: repository metadata changed during execution.");
  });

  it("fails closed for forged or mismatched output-validation handles", async () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    for (const supplied of [{} as VerifiedShellCommand, handle]) {
      const mismatched = { ...identity, command: "git show --no-patch" };
      expect(verifiedShellRequiresResultCheck(supplied, mismatched)).toBe(true);
      expect(await verifiedShellResultRefusal(supplied, mismatched)).toBe("Read-only Git output discarded: repository metadata changed during execution.");
    }
    expect(verifiedShellRequiresResultCheck(undefined, identity)).toBe(false);
    expect(await verifiedShellResultRefusal(undefined, identity)).toBeUndefined();
  });

  it("retains exact-approved literal evaluation without repository output checks", async () => {
    const identity = { command: LITERAL_COMMAND, dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    rmSync(join(cwd, ".git"), { recursive: true });
    expect(verifiedShellRequiresResultCheck(handle, identity)).toBe(false);
    expect(await verifiedShellResultRefusal(handle, identity)).toBeUndefined();
  });

  it.each((["bash", "powershell"] as const).flatMap((dialect) => READ_CASES.map((command) => ({ dialect, command }))))
    ("admits checked repository reads for $dialect $command", async ({ dialect, command }) => {
      const handle = await prepareVerifiedShellCommand({ command, dialect, cwd });
      expect(handle).toBeDefined();
      expect(resolveVerifiedExecutableAsync).toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
      const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
      const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
      expect(approval.exactRule).toBe(`${wrapper}(${command})`);
      expect(permission(command, dialect, handle, true, false)).toMatchObject({ decision: "allow" });
      expect(permission(command, dialect, handle, false, false)).toMatchObject({ decision: "ask" });
      manager.setRules([withCurrentShellRuleVersion({ pattern: `${wrapper}(git *)`, action: "allow" })]);
      expect(permission(command, dialect, handle, false, true)).toMatchObject(dialect === "bash"
        ? { decision: "deny", reasonCode: "no-approver" }
        : { decision: "allow", reasonCode: "rule-allow" });
      manager.setRules([withCurrentShellRuleVersion({ pattern: approval.exactRule!, action: "allow" })]);
      for (const sandboxed of [false, true]) {
        expect(permission(command, dialect, handle, sandboxed, true)).toMatchObject({ decision: "allow" });
      }
      const identity = { command, dialect, cwd };
      expect(verifiedShellExecution(handle, identity)?.command).toContain(`'--git-dir=${join(cwd, ".git")}'`);
      expect(verifiedShellExecution(handle, identity)?.command).toContain(`'--work-tree=${cwd}'`);
      expect(verifiedShellEnvironment(handle, identity, { GIT_CONFIG_PARAMETERS: "evil", git_dir: "/outside", HOME: cwd })).toMatchObject({
        GIT_DIR: join(cwd, ".git"), GIT_WORK_TREE: cwd, GIT_INDEX_FILE: join("/usr/bin", ".ave-readonly-index"), GIT_REFERENCE_BACKEND: "files", GIT_CEILING_DIRECTORIES: cwd, HOME: cwd,
      });
    });

  it.each(["bash", "powershell"] as const)("applies a bounded saved prefix to a host repository read on %s", async (dialect) => {
    const command = "git log --oneline -n 3";
    const handle = await prepareVerifiedShellCommand({ command, dialect, cwd });
    expect(handle).toBeDefined();
    const approval = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
    const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
    expect(approval.exactRule).toBe(`${wrapper}(${command})`);
    const prefix = `${wrapper}(git log *)`;
    expect(shellRuleCoversCommand(dialect, prefix, "allow", command, cwd, handle)).toBe(true);
    manager.setRules([withCurrentShellRuleVersion({ pattern: prefix, action: "allow" })]);
    for (const headless of [false, true]) {
      const result = permission(command, dialect, handle, false, headless);
      expect(result).toMatchObject({ decision: "allow", reasonCode: "rule-allow" });
      expect(result).not.toHaveProperty("forceModal");
    }
  });
  it.each(["bash", "powershell"] as const)("keeps proved literal evaluation exact-only on %s", async (dialect) => {
    const handle = await prepareVerifiedShellCommand({ command: LITERAL_COMMAND, dialect, cwd });
    expect(handle).toBeDefined();
    const approval = buildShellRuleApproval(dialect, LITERAL_COMMAND, cwd, { allow: true, deny: true }, undefined, handle);
    const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
    expect(approval.exactRule).toBe(`${wrapper}(${LITERAL_COMMAND})`);
    expect(permission(LITERAL_COMMAND, dialect, handle, true, false)).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    manager.setRules([withCurrentShellRuleVersion({ pattern: `${wrapper}(bash *)`, action: "allow" })]);
    expect(permission(LITERAL_COMMAND, dialect, handle, true, false)).toMatchObject({ decision: "ask", reasonCode: "shell-approval" });
    manager.setRules([withCurrentShellRuleVersion({ pattern: approval.exactRule!, action: "allow" })]);
    for (const sandboxed of [false, true]) {
      expect(permission(LITERAL_COMMAND, dialect, handle, sandboxed, true)).toMatchObject({ decision: "allow" });
    }
    expect(verifiedShellExecution(handle, { command: LITERAL_COMMAND, dialect, cwd })?.command).toContain("'/usr/bin/bash'");
  });

  it.each(["git status", "git diff", "git show", "git -c core.fsmonitor=evil status", "git -C .. log", "env git log", "git log; git log", "git log | cat", "git log > out", "GIT_CONFIG_COUNT=1 git log", "python3 -I -S ordinary.py", "fish -N -c 'printf ready'", "node -e 'ready'", "pwsh -NoProfile -File ordinary.ps1", 'bash --noprofile --norc -p -c "$runtime"'])("retains default refusal for %s", async (command) => {
    for (const dialect of ["bash", "powershell"] as const) expect(await prepareVerifiedShellCommand({ command, dialect, cwd })).toBeUndefined();
  });

  it("refuses missing installations without a native probe", async () => {
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue(null);
    expect(await prepareVerifiedShellCommand({ command: LITERAL_COMMAND, dialect: "bash", cwd })).toBeUndefined();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
  it("refuses unchecked configuration before consulting the image", async () => {
    writeFileSync(join(cwd, ".git", "config"), "[include]\npath=/outside/config\n");
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
    expect(resolveVerifiedExecutableAsync).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });
  it("suspends an issued repository plan while sandbox writes are outstanding", async () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    const release = holdSandboxGitWrites([cwd]);
    try {
      expect(await prepareVerifiedShellCommand(identity)).toBeUndefined();
      expect(verifiedShellExecution(handle, identity)).toBeUndefined();
      expect(() => verifiedShellEnvironment(handle, identity, {})).toThrow("Verified shell command is no longer available");
    } finally { release(); }
    expect(verifiedShellExecution(handle, identity)).toBeDefined();
  });
  it("refuses a pre-existing reserved installation index path", async () => {
    const executable = join(cwd, "verified-install", "git");
    mkdirSync(join(cwd, "verified-install"));
    writeFileSync(executable, "verified fixture");
    writeFileSync(join(cwd, "verified-install", ".ave-readonly-index"), "index must never be read");
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable });
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("requires a supported protected Git version", async () => {
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable: "/verified-older-git" });
    mockGitVersion("git version 2.53.0\n");
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
  });
  it.each([
    ["below the floor", `git version ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor - 1}.9\n`, false],
    ["below the floor in Git for Windows spelling", `git version ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor - 1}.9.windows.1\n`, false],
    ["at the floor in Git for Windows spelling", `git version ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor}.0.windows.1\n`, false],
    ["at the floor", `git version ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor}.0\n`, true],
  ] as const)("admits through the version probe only an engine %s that the floor accepts", async (name, version, admitted) => {
    const command = "git log";
    for (const dialect of ["bash", "powershell"] as const) {
      // Each installation path has its own cached probe result.
      vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable: `/verified-git-${dialect}-${name.replaceAll(" ", "-")}` });
      mockGitVersion(version);
      const handle = await prepareVerifiedShellCommand({ command, dialect, cwd });
      expect(childProcess.execFile).toHaveBeenCalledWith(expect.stringContaining("/verified-git-"), ["--version"], expect.anything(), expect.any(Function));
      expect(handle === undefined).toBe(!admitted);
      expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle).exactRule === null).toBe(!admitted);
    }
  });
  it.each(["git diff --cached --name-only", "git diff --staged --raw"])("never upgrades an index-reading command through a saved rule: %s", async (command) => {
    for (const dialect of ["bash", "powershell"] as const) {
      const handle = await prepareVerifiedShellCommand({ command, dialect, cwd });
      expect(handle).toBeUndefined();
      expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).toBeNull();
      const wrapper = dialect === "bash" ? "Bash" : "PowerShell";
      manager.setRules([withCurrentShellRuleVersion({ pattern: `${wrapper}(${command})`, action: "allow" })]);
      expect(permission(command, dialect, handle, true, false)).toMatchObject(dialect === "bash"
        ? { decision: "allow", reasonCode: "read-only-shell" }
        : { decision: "ask", reasonCode: "shell-approval" });
      expect(permission(command, dialect, handle, false, true)).toMatchObject({ decision: "deny", reasonCode: "no-approver" });
    }
  });
  it("bounds input before parsing or installation discovery", async () => {
    expect(await prepareVerifiedShellCommand({ command: "bash " + "x".repeat(2000), dialect: "bash", cwd })).toBeUndefined();
    expect(resolveVerifiedExecutableAsync).not.toHaveBeenCalled();
  });
  it("rejects forged and mismatched sidecars", async () => {
    const identity = { command: LITERAL_COMMAND, dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(verifiedShellExecution({} as VerifiedShellCommand, identity)).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, command: "git log" })).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, cwd: join(cwd, "other") })).toBeUndefined();
    expect(verifiedShellExecution(handle, { ...identity, dialect: "powershell" })).toBeUndefined();
  });
  it("removes loader overrides from the complete child environment after wrapping", async () => {
    const identity = { command: LITERAL_COMMAND, dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(verifiedShellEnvironment(handle, identity, { HOME: cwd, LD_PRELOAD: "evil", DYLD_INSERT_LIBRARIES: "evil", ld_library_path: "evil" })).toEqual({ HOME: cwd });
    expect(() => verifiedShellEnvironment({} as VerifiedShellCommand, identity, {})).toThrow("Verified shell command is no longer available for this invocation");
  });
  it("refuses pathspecs and retains their visible floors", async () => {
    const identity = { command: "git log '.ssh/config'", dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeUndefined();
    expect(inspectShellCommand(identity.command, cwd).outcome).toBe("visible-floor");
    expect(buildShellRuleApproval(identity.dialect, identity.command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).toBeNull();
  });
});

describe("asynchronous Git lookup", () => {
  const timeout = Object.assign(new Error("Command failed: git --version"), { killed: true, signal: "SIGTERM" });
  const oversize = Object.assign(new RangeError("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
  const launch = Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
  const exit = Object.assign(new Error("Command failed: git --version"), { code: 128 });

  it.each([
    ["non-zero exit", exit], ["timeout", timeout], ["output limit", oversize], ["launch failure", launch],
    ["unparseable output", "not a version\n"], ["older engine", "git version 2.53.0\n"],
  ] as const)("refuses on %s and caches the refusal for that executable", async (name, outcome) => {
    for (const dialect of ["bash", "powershell"] as const) {
      vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable: `/verified-git-probe-${dialect}-${name.replaceAll(" ", "-")}` });
      mockGitVersion(outcome);
      expect(await prepareVerifiedShellCommand({ command: "git log", dialect, cwd })).toBeUndefined();
      expect(childProcess.execFile).toHaveBeenCalledTimes(1);
      expect(await prepareVerifiedShellCommand({ command: "git log", dialect, cwd })).toBeUndefined();
      expect(childProcess.execFile).toHaveBeenCalledTimes(1);
    }
  });

  it("probes with the synchronous probe's working directory, environment and limits", async () => {
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable: "/verified-options/git" });
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeDefined();
    const { TOOL_TIMEOUT_POLICY } = await import("../../shared/tool-timeout-policy.js");
    expect(childProcess.execFile).toHaveBeenCalledWith("/verified-options/git", ["--version"], expect.objectContaining({
      encoding: "utf8", cwd: dirname("/verified-options/git"), timeout: TOOL_TIMEOUT_POLICY.windowsAclRequestMs, maxBuffer: 4096,
      env: expect.objectContaining({ LANG: "C", LC_ALL: "C", GIT_INDEX_FILE: join(dirname("/verified-options/git"), ".ave-readonly-index") }),
    }), expect.any(Function));
  });

  it("shares one in-flight version probe between concurrent preparations", async () => {
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable: "/verified-concurrent/git" });
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const [first, second] = await Promise.all([prepareVerifiedShellCommand(identity), prepareVerifiedShellCommand(identity)]);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  });

  it.each(["EACCES", "ELOOP", "ENOTDIR"])("refuses an index path whose absence cannot be proven (%s) before probing", async (code) => {
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue({ executable: `/verified-index-${code}/git` });
    const stabilized = vi.mocked(fsPromises.lstat).getMockImplementation();
    if (stabilized === undefined) throw new Error("Fixture ancestor stabilization is not installed");
    vi.mocked(fsPromises.lstat).mockImplementation(((path: string, options?: unknown) => String(path).endsWith(".ave-readonly-index")
      ? Promise.reject(Object.assign(new Error(code), { code })) : stabilized(path, options as never)) as typeof fsPromises.lstat);
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
    expect(fsPromises.lstat).toHaveBeenCalledWith(join(dirname(`/verified-index-${code}/git`), ".ave-readonly-index"));
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it.each(["bash", "powershell"] as const)("refuses a missing Git installation before the index or version checks on %s", async (dialect) => {
    vi.mocked(resolveVerifiedExecutableAsync).mockResolvedValue(null);
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect, cwd })).toBeUndefined();
    expect(resolveHostGit).toHaveBeenCalledWith("verified");
    expect(fsPromises.lstat).not.toHaveBeenCalledWith(expect.stringContaining(".ave-readonly-index"));
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("refuses verified Git on a platform without a protected installation policy, without I/O", async () => {
    setProcessPlatform("win32");
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect: "bash", cwd })).toBeUndefined();
    expect(resolveVerifiedExecutableAsync).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
  });

  it("proves PowerShell argv only from the recorded literal argv and binds the same plan", async () => {
    const identity = { command: "git log --oneline -n 3", dialect: "powershell" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    expect(resolveVerifiedExecutableAsync).toHaveBeenCalledTimes(1);
    // The bash dialect proves the same argv in one pass; both bind one plan.
    const bash = { ...identity, dialect: "bash" as const };
    const bashCommand = verifiedShellExecution(await prepareVerifiedShellCommand(bash), bash)?.command;
    expect(bashCommand).toContain(`'--git-dir=${join(cwd, ".git")}'`);
    expect(verifiedShellExecution(handle, identity)?.command).toBe(`& ${bashCommand}`);
  });

  it.each(["bash", "powershell"] as const)("issues no plan when cancelled during the asynchronous lookup on %s", async (dialect) => {
    const controller = new AbortController();
    vi.mocked(resolveVerifiedExecutableAsync).mockImplementation(async (candidates) => {
      controller.abort();
      return candidates[0] === undefined ? null : { executable: candidates[0].executable };
    });
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect, cwd }, undefined, controller.signal)).toBeUndefined();
    expect(fsPromises.lstat).not.toHaveBeenCalledWith(expect.stringContaining(".ave-readonly-index"));
    vi.mocked(resolveVerifiedExecutableAsync).mockImplementation(async (candidates) => candidates[0] === undefined ? null : { executable: candidates[0].executable });
    expect(await prepareVerifiedShellCommand({ command: "git log", dialect, cwd }, undefined, new AbortController().signal)).toBeDefined();
  });

  it("refuses output when the post-run repository inspection rejects", async () => {
    const identity = { command: "git log", dialect: "bash" as const, cwd };
    const handle = await prepareVerifiedShellCommand(identity);
    expect(handle).toBeDefined();
    vi.mocked(fsPromises.lstat).mockRejectedValueOnce(Object.assign(new Error("I/O"), { code: "EIO" }));
    expect(await verifiedShellResultRefusal(handle, identity)).toBe("Read-only Git output discarded: repository metadata changed during execution.");
    expect(await verifiedShellResultRefusal(handle, identity)).toBeUndefined();
  });

  // Locks direct calls only: workspace availability (host-git.ts) stays a synchronous in-process check.
  it("calls no synchronous child-process, filesystem, installation-proof or repository-inspection API directly", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    for (const module of ["../verified-shell-command.ts", "../rules/verified-launcher-argv.ts"]) {
      const source = fs.readFileSync(new URL(module, import.meta.url), "utf8");
      expect(source, module).not.toMatch(/\b[\w$]+Sync\b/);
      expect(source, module).not.toMatch(/from "node:fs"/);
      expect(source, module).not.toMatch(/\bresolveVerifiedExecutable\b/);
      expect(source, module).not.toMatch(/\binspectGitRepository\b/);
      const childProcessImport = /import \{([^}]*)\} from "node:child_process"/.exec(source)?.[1] ?? "";
      expect(childProcessImport.split(",").map((name) => name.trim()).filter(Boolean).every((name) => name === "execFile")).toBe(true);
    }
  });
});
