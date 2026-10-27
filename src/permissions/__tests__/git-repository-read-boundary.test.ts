import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as childProcess from "node:child_process";
import { resolveVerifiedExecutable } from "../../shared/verified-executable.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { PermissionManager } from "../permission-manager.js";
import { prepareVerifiedShellCommand, verifiedShellEnvironment, verifiedShellExecution } from "../verified-shell-command.js";
import { buildShellRuleApproval } from "../rules/shell-rule-approval.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

vi.mock("node:child_process", { spy: true });
vi.mock("../../shared/verified-executable.js", () => ({ resolveVerifiedExecutable: vi.fn() }));
vi.mock("../../shared/powershell-startup-policy.js", () => ({ isPowerShellStartupPinned: () => true, POWERSHELL_STARTUP_UNPROVEN_REASON: "startup is unproven" }));

const nativeChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const ORIGINAL_PLATFORM = process.platform;
const CHILD_ENTRY_POINTS = ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"] as const;
const READ_COMMANDS = [
  "git log", "git log --oneline -n 3", "git log --max-count=0", "git log --max-count 2 HEAD", "git log 'HEAD'", "git log main...HEAD",
  "git show --no-patch", "git show --no-patch HEAD", "git show --no-patch 'HEAD~1'",
  "git diff main HEAD --name-only", "git diff main HEAD --raw", "git diff main HEAD --name-status", "git diff 'HEAD~1' HEAD --raw",
  "git rev-parse --show-toplevel", "git rev-parse --show-prefix", "git rev-parse --git-dir", "git rev-parse --absolute-git-dir",
  "git rev-parse --is-inside-work-tree", "git rev-parse --is-bare-repository", "git rev-parse --verify HEAD", "git rev-parse --verify --quiet refs/heads/main",
  "git branch --list", "git branch -a --list", "git branch --list --all", "git branch --list -r", "git branch --remotes --list",
] as const;
let root: string;
let environment: NodeJS.ProcessEnv;
let serial = 0;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "repository-read-boundary-")));
  const home = join(root, "home");
  mkdirSync(home);
  environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_|^(?:HOME|XDG_CONFIG_HOME|EMAIL)$/i.test(key)));
  Object.assign(environment, {
    HOME: home, XDG_CONFIG_HOME: home, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Boundary Author", GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Boundary Author", GIT_COMMITTER_EMAIL: "author@example.invalid",
  });
  vi.stubEnv("AVE_HOME", join(root, "state"));
  // Installation trust is mocked; native engine controls are a separate assertion.
  vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: "/verified/system/git" });
  vi.mocked(childProcess.execFileSync).mockReturnValue("git version 2.54.0\n");
});

afterEach(() => {
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function nativeGit(cwd: string, args: readonly string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  return nativeChildProcess.spawnSync("git", ["-c", "core.hooksPath=" + devNull, "-C", cwd, ...args], {
    encoding: "utf8", env: { ...environment, ...extraEnvironment }, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
}

function git(cwd: string, args: readonly string[]): string {
  const result = nativeGit(cwd, args);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function repository(name: string, subject = "synthetic repository commit"): string {
  const cwd = join(root, name);
  mkdirSync(cwd);
  git(cwd, ["init", "--initial-branch=main"]);
  git(cwd, ["-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", subject]);
  return cwd;
}

function configure(cwd: string, key: string, value: string): void {
  git(cwd, ["config", "--local", key, value]);
}

function assertRefused(cwd: string, commands: readonly string[], marker?: string): void {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    setProcessPlatform(platform);
    for (const dialect of ["bash", "powershell"] as const) {
      for (const command of commands) {
        const manager = new PermissionManager(join(root, `permissions-${serial++}.json`));
        manager.setMode("allow");
        const kind = dialect === "bash" ? "Bash" : "PowerShell";
        manager.setRules([
          { pattern: dialect, action: "allow" },
          withCurrentShellRuleVersion({ pattern: `${kind}(git *)`, action: "allow" }),
          withCurrentShellRuleVersion({ pattern: `${kind}(${command})`, action: "allow" }),
        ]);
        for (const entry of CHILD_ENTRY_POINTS) vi.mocked(childProcess[entry]).mockClear();
        vi.mocked(resolveVerifiedExecutable).mockClear();
        const identity = { command, dialect, cwd };
        const handle = prepareVerifiedShellCommand(identity);
        expect.soft(handle).toBeUndefined();
        expect.soft(verifiedShellExecution(handle, identity)).toBeUndefined();
        const card = buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle);
        expect.soft(card.exactRule).toBeNull();
        expect.soft(card.persistentAllowed).toBe(false);
        for (const runsSandboxed of [false, true]) {
          const check = (headless: boolean) => manager.checkDetailed(dialect, "builtin", "shell", null, {
            ruleSubject: { kind: "shell", dialect, command, cwd }, shellExecution: { runsSandboxed }, headless,
            ...(handle === undefined ? {} : { verifiedShellCommand: handle }),
          });
          expect.soft(check(false)).toMatchObject({ decision: "ask", layer: 2, forceModal: true });
          expect.soft(check(true)).toMatchObject({ decision: "deny", layer: 2 });
        }
        expect.soft(resolveVerifiedExecutable).not.toHaveBeenCalled();
        for (const entry of CHILD_ENTRY_POINTS) expect.soft(childProcess[entry]).not.toHaveBeenCalled();
        if (marker !== undefined) expect.soft(existsSync(marker)).toBe(false);
      }
    }
  }
  setProcessPlatform(ORIGINAL_PLATFORM);
}

describe("implicit repository file reads", () => {
  it.each([false, true])("consumes an outside malformed include when conditional=%s", (conditional) => {
    const cwd = repository("workspace");
    const outside = join(root, "outside-config");
    writeFileSync(outside, "[malformed\n");
    if (conditional) configure(cwd, `includeIf.gitdir:${join(cwd, ".git").replaceAll("\\", "/")}.path`, outside);
    else configure(cwd, "include.path", outside);
    const control = nativeGit(cwd, ["log", "-n", "1"]);
    expect(control.error).toBeUndefined();
    expect(control.status).not.toBe(0);
    expect(control.stderr).toContain(outside);
    expect(control.stderr).toMatch(/bad config|invalid config/i);
    assertRefused(cwd, ["git log", "git rev-parse --verify HEAD", "git branch --list"]);
  });

  it("uses an outside mailmap for synthetic private contact output", () => {
    const cwd = repository("workspace");
    const outside = join(root, "outside-mailmap");
    writeFileSync(outside, "Private Synthetic Contact <private@example.invalid> Boundary Author <author@example.invalid>\n");
    configure(cwd, "mailmap.file", outside);
    configure(cwd, "log.mailmap", "true");
    for (const args of [["log", "-n", "1"], ["show", "--no-patch", "HEAD"]]) {
      const output = git(cwd, args);
      expect(output).toContain("Private Synthetic Contact <private@example.invalid>");
      expect(output).not.toContain("Boundary Author <author@example.invalid>");
    }
    assertRefused(cwd, ["git log -n 1", "git show --no-patch HEAD"]);
  });

  it("takes both cached and revision diff ordering from an outside order file", () => {
    const cwd = repository("workspace");
    for (const name of ["alpha.txt", "zeta.txt"]) writeFileSync(join(cwd, name), "base\n");
    git(cwd, ["add", "."]);
    git(cwd, ["-c", "commit.gpgSign=false", "commit", "-m", "initial paths"]);
    for (const name of ["alpha.txt", "zeta.txt"]) writeFileSync(join(cwd, name), "changed\n");
    git(cwd, ["add", "."]);
    expect(git(cwd, ["diff", "--cached", "--name-only"]).trim().split(/\r?\n/)).toEqual(["alpha.txt", "zeta.txt"]);
    const outside = join(root, "outside-order");
    writeFileSync(outside, "zeta.txt\nalpha.txt\n");
    configure(cwd, "diff.orderFile", outside);
    expect(git(cwd, ["diff", "--cached", "--name-only"]).trim().split(/\r?\n/)).toEqual(["zeta.txt", "alpha.txt"]);
    git(cwd, ["-c", "commit.gpgSign=false", "commit", "-m", "changed paths"]);
    expect(git(cwd, ["diff", "HEAD~1", "HEAD", "--name-only"]).trim().split(/\r?\n/)).toEqual(["zeta.txt", "alpha.txt"]);
    assertRefused(cwd, ["git diff --cached --name-only", "git diff 'HEAD~1' HEAD --name-only"]);
  });

  it("follows a gitfile to another repository identity", () => {
    const outside = repository("outside-repository", "outside repository identity");
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    writeFileSync(join(cwd, ".git"), `gitdir: ${join(outside, ".git").replaceAll("\\", "/")}\n`);
    expect(realpathSync(git(cwd, ["rev-parse", "--absolute-git-dir"]).trim())).toBe(join(outside, ".git"));
    expect(git(cwd, ["log", "-n", "1"])).toContain("outside repository identity");
    assertRefused(cwd, ["git log", "git rev-parse --absolute-git-dir"]);
  });

  it("follows a linked worktree commondir outside the working directory", () => {
    const outside = repository("outside-repository", "shared metadata identity");
    const cwd = join(root, "linked-worktree");
    git(outside, ["worktree", "add", "--detach", cwd, "HEAD"]);
    const gitfile = readFileSync(join(cwd, ".git"), "utf8").trim();
    expect(gitfile.startsWith("gitdir: ")).toBe(true);
    const metadata = resolve(cwd, gitfile.slice("gitdir: ".length));
    const common = readFileSync(join(metadata, "commondir"), "utf8").trim();
    expect(realpathSync(resolve(metadata, common))).toBe(join(outside, ".git"));
    expect(git(cwd, ["log", "-n", "1"])).toContain("shared metadata identity");
    assertRefused(cwd, ["git log", "git rev-parse --git-dir"]);
  });

  it("loads a commit exclusively from an outside object alternate", () => {
    const outside = repository("outside-repository", "alternate object identity");
    const object = git(outside, ["rev-parse", "HEAD"]).trim();
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    git(cwd, ["init", "--initial-branch=main"]);
    expect(nativeGit(cwd, ["cat-file", "-e", object]).status).not.toBe(0);
    const alternate = join(cwd, ".git", "objects", "info", "alternates");
    mkdirSync(dirname(alternate), { recursive: true });
    writeFileSync(alternate, join(outside, ".git", "objects").replaceAll("\\", "/") + "\n");
    git(cwd, ["update-ref", "refs/heads/main", object]);
    expect(git(cwd, ["show", "--no-patch", "HEAD"])).toContain("alternate object identity");
    assertRefused(cwd, ["git log", "git show --no-patch HEAD", "git rev-parse --verify HEAD"]);
  });
});

it("admits checked reads without starting an available libexec helper", () => {
  const cwd = repository("workspace");
  const libexec = join(root, "outside-libexec");
  mkdirSync(libexec);
  const marker = join(root, "helper-marker");
  const helper = join(libexec, "git-boundary-probe");
  writeFileSync(helper, '#!/bin/sh\nprintf "helper-ran\\n" > "$BOUNDARY_HELPER_MARKER"\n');
  chmodSync(helper, 0o755);
  const control = nativeGit(cwd, ["boundary-probe"], { GIT_EXEC_PATH: libexec, BOUNDARY_HELPER_MARKER: marker.replaceAll("\\", "/") });
  expect(control.error).toBeUndefined();
  expect(control.status, control.stderr).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("helper-ran\n");
  rmSync(marker);
  vi.stubEnv("GIT_EXEC_PATH", libexec);
  vi.stubEnv("BOUNDARY_HELPER_MARKER", marker);
  const nativePath = nativeChildProcess.execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8", env: environment }).trim();
  vi.mocked(resolveVerifiedExecutable).mockReturnValue({ executable: nativePath });
  for (const dialect of ["bash", "powershell"] as const) {
    for (const command of READ_COMMANDS) {
      const identity = { command, dialect, cwd };
      const handle = prepareVerifiedShellCommand(identity);
      expect(handle, command).toBeDefined();
      const execution = verifiedShellExecution(handle, identity);
      expect(execution?.executable).toBe(nativePath);
      const childEnvironment = verifiedShellEnvironment(handle, identity, {
        ...Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        GIT_EXEC_PATH: libexec, BOUNDARY_HELPER_MARKER: marker,
      });
      expect(childEnvironment.GIT_EXEC_PATH).toBeUndefined();
      expect(childEnvironment.GIT_REFERENCE_BACKEND).toBe("files");
      expect(buildShellRuleApproval(dialect, command, cwd, { allow: true, deny: true }, undefined, handle).exactRule).not.toBeNull();
      if (dialect === "bash") {
        const result = nativeChildProcess.spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", execution!.command], {
          cwd, encoding: "utf8", env: childEnvironment, timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        // This fixture has one commit, so its parent cannot resolve.
        expect(result.status, result.stderr).toBe(command.includes("HEAD~1") ? 128 : 0);
      }
      expect(existsSync(marker)).toBe(false);
    }
  }
});
