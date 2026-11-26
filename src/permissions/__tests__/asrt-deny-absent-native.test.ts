import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasNativeSrtWinBuildReceipt } from "../../__tests__/support/srt-win-build-receipts.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { initializeRequiredSandbox } from "../../__tests__/support/native-sandbox.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { checkAsrtDependencies, getVendoredSrtWinExePath, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { windowsSandboxCanSpawn } from "./test-helpers.js";
import { holdWindowsFilesystemGrant } from "../windows-acl-grant-holder.js";
import { win32SystemBinary } from "../../shared/ave-home.js";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { configureHostResources } from "../../main/host-resources.js";
import { prepareSrtWinExecutable, srtWinConfinementStatePaths, srtWinPrivateDirectories, sweepStaleSrtWinDirectories } from "../srt-win-integrity.js";
import { recoverWindowsAcl, restoreWindowsAcl, stampWindowsAcl } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { readWindowsDenyAcls } from "../windows-deny-acl.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { isHostGitWorkspaceAvailable } from "../../shared/host-git.js";
import { listWatchedQuarantine, WATCHED_ROW_VIOLATION, watchedProtectedRows } from "../windows-watched-rows.js";

useVerifiedAveHomePrivacy();

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

describe.runIf(process.platform === "win32" && hasNativeSrtWinBuildReceipt())("Windows absent deny native enforcement", () => {
  let root: string;
  let container: string;
  let ancestorAces: string | undefined;

  function readAncestorAces(): string {
    const ancestors: string[] = [];
    for (let path = dirname(container); ; path = dirname(path)) {
      ancestors.push(path);
      if (dirname(path) === path) break;
    }
    const sid = runtime.getWindowsSandboxUserStatus({ srtWin: runtime.resolveSrtWin({ path: getVendoredSrtWinExePath() }) }).sid;
    if (!sid) throw new Error("Sandbox SID is required for ancestor verification");
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; foreach($p in @(${ancestors.map(path => `'${path.replace(/'/g, "''")}'`).join(",")})) {
        $acl=Get-Acl -LiteralPath $p;
        foreach($ace in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
          if($ace.IdentityReference.Value -eq '${sid}') { $p; $ace.ToString(); [string]$ace.FileSystemRights; [string]$ace.InheritanceFlags; [string]$ace.PropagationFlags; [string]$ace.IsInherited }
        }
      }`], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true });
  }

  // Quarantine moves are same-volume renames; the per-run Ave home may sit on another volume than the fixture.
  function sameVolumeAveHome(): string {
    const home = join(container, "quarantine-home");
    mkdirSync(home, { recursive: true });
    return home;
  }

  function entriesBelow(dir: string): string[] {
    return (readdirSync(dir, { recursive: true }) as string[]).map(entry => entry.replace(/\\/g, "/")).sort();
  }

  async function grantedWorkspace() {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    await initializeRequiredSandbox({ allowRead: [root] });
    const held = await holdWindowsFilesystemGrant({ label: "watched-tasks-native", allowRead: [], allowWrite: [workspace] });
    expect(lstatSync(join(workspace, ".vscode"), { throwIfNoEntry: false })).toBeUndefined();
    expect(watchedProtectedRows()).toContain(join(workspace, ".vscode"));
    return { workspace, held };
  }

  // Adds an owner deny ACE for `rights` to the fixture folder; returns its removal.
  function denyOwner(path: string, rights: number): () => void {
    const command = `$ErrorActionPreference='Stop'; $path='${path.replace(/'/g, "''")}';
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]${rights}, 'Deny');
      $acl=Get-Acl -LiteralPath $path; $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;`;
    const run = (script: string) => execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
      ["-NoProfile", "-NonInteractive", "-Command", script], { env: windowsPowerShellEnv(), windowsHide: true });
    run(command);
    return () => { run(command.replace("$acl.AddAccessRule($rule)", "$acl.RemoveAccessRuleSpecific($rule)")); };
  }

  async function runPlantingTasks(workspace: string) {
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: workspace, approvalSurface: "unavailable" } });
    const vscode = join(workspace, ".vscode");
    const wrapped = await wrapToolCommand(`mkdir "${vscode}" & echo planted > "${join(vscode, "tasks.json")}" & echo allowed > "${join(workspace, "allowed")}"`,
      { commandId: invocation.token });
    spawnSync(wrapped.argv[0] ?? "", wrapped.argv.slice(1), { env: { ...process.env, ...wrapped.env }, cwd: root, windowsHide: true, stdio: "ignore" });
    expect(readFileSync(join(vscode, "tasks.json"), "utf8")).toContain("planted");
    expect(wrapped.cleanupCompleted).toBeDefined();
    return { wrapped, invocation };
  }

  beforeEach(async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    container = mkdtempSync(join(os.tmpdir(), "deny-absent-native-"));
    root = join(container, "root");
    mkdirSync(root);
    ancestorAces = undefined;
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: root });
    const dependencies = await checkAsrtDependencies();
    if (dependencies.errors.length > 0) {
      const reason = `Native Windows sandbox unavailable: ${dependencies.errors.join("; ")}`;
      console.warn(reason);
      if (process.env.CI) throw new Error(reason);
      context.skip(reason);
    }
    if (!(await windowsSandboxCanSpawn())) {
      if (process.env.CI) throw new Error("Native Windows sandbox cannot spawn on the provisioned runner");
      context.skip("Native Windows sandbox cannot spawn on this host; see capability warning");
    }
    ancestorAces = readAncestorAces();
    const manager = runtime.SandboxManager;
    const initialize = manager.initialize.bind(manager);
    const wrap = manager.wrapWithSandboxArgv.bind(manager);
    const inside = (entry: runtime.FilesystemPathEntry) => {
      const path = typeof entry === "string" ? entry : entry.path;
      const rel = relative(root, path);
      return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
    };
    vi.spyOn(manager, "wrapWithSandboxArgv").mockImplementation((command, shell, custom, ...rest) =>
      wrap(command, shell, custom?.filesystem ? { ...custom, filesystem: { ...custom.filesystem,
        denyRead: custom.filesystem.denyRead?.filter(inside), denyWrite: custom.filesystem.denyWrite?.filter(inside),
      } } : custom, ...rest));
    vi.spyOn(manager, "initialize").mockImplementation(async (next, ask, monitor) => {
      await initialize({ ...next, filesystem: { ...next.filesystem,
        denyRead: next.filesystem.denyRead.filter(inside), denyWrite: next.filesystem.denyWrite.filter(inside),
      } }, ask, monitor);
    });
  });

  afterEach(async () => {
    try {
      // Check while session stamps are still live, as well as after teardown.
      if (ancestorAces !== undefined) expect(readAncestorAces()).toBe(ancestorAces);
    } finally {
      try {
        if (isAsrtSandboxActive()) await resetAsrtSandbox();
        if (ancestorAces !== undefined) expect(readAncestorAces()).toBe(ancestorAces);
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        await cleanupTmpDir(container);
      }
    }
  });

  it("does not materialize a missing git leaf outside write grants during native initialization and reset", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    await initializeRequiredSandbox({ denyWrite: [join(workspace, ".git")] });
    await resetAsrtSandbox();
    expect(lstatSync(join(workspace, ".git"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(workspace, ".git", "modules"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(workspace, ".git", "worktrees"), { throwIfNoEntry: false })).toBeUndefined();
  }, 60_000);

  it("does not create an absent deny target during native initialization or execution", async () => {
    const absent = join(root, "absent", "secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [absent], denyWrite: [absent] });
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
    const wrapped = await wrapToolCommand("echo fixture-ok", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: [absent], denyWrite: [absent] } });
    execFileSync(wrapped.argv[0]!, wrapped.argv.slice(1), { env: { ...process.env, ...wrapped.env }, cwd: root, windowsHide: true });
    await resetAsrtSandbox();
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(root, "absent"), { throwIfNoEntry: false })).toBeUndefined();
  }, 60_000);

  it("watches an absent row under a later worker grant and quarantines what an earlier wrap wrote there when the grant ends", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    const sibling = join(workspace, "allowed");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target], denyWrite: [target] });
    const earlier = await wrapToolCommand(`echo unsafe > "${target}"`, { commandId: TEST_COMMAND_ID });
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    const started = performance.now();
    const held = await holdWindowsFilesystemGrant({ label: "absent-deny-native", allowRead: [], allowWrite: [workspace] });
    console.log(`GRANT_LATENCY_MS=${(performance.now() - started).toFixed(2)}`);
    let released = false;
    try {
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
      expect(watchedProtectedRows()).toContain(target);
      const allowed = await wrapToolCommand(`echo allowed > "${sibling}"`, { commandId: TEST_COMMAND_ID });
      execFileSync(allowed.argv[0]!, allowed.argv.slice(1), { env: { ...process.env, ...allowed.env }, cwd: root, windowsHide: true });
      expect(readFileSync(sibling, "utf8")).toContain("allowed");
      // The earlier wrap is a writer whose end Ave does not observe; its write is caught when the grant that reached the row ends.
      execFileSync(earlier.argv[0] ?? "", earlier.argv.slice(1), { env: { ...process.env, ...earlier.env }, cwd: root, windowsHide: true });
      expect(readFileSync(target, "utf8")).toContain("unsafe");
      expect(isHostGitWorkspaceAvailable(workspace)).toBe(false);
      vi.stubEnv("AVE_HOME", sameVolumeAveHome());
      released = true;
      held.release();
      await vi.waitFor(() => expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined(), { timeout: 15_000 });
      const [entry, ...rest] = listWatchedQuarantine();
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ original: target, row: target });
      expect(readFileSync(entry?.quarantined ?? "", "utf8")).toContain("unsafe");
      expect(isHostGitWorkspaceAvailable(workspace)).toBe(true);
    } finally {
      if (!released) held.release();
    }
  }, 60_000);

  it("creates nothing for a fresh git workspace grant or a refused home-root grant, and git status stays clean", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=alice", "-c", "user.email=alice@example.com", ...args],
      { cwd: workspace, encoding: "utf8", windowsHide: true });
    git("init", "-q");
    writeFileSync(join(workspace, "README.md"), "fixture\n");
    git("add", "README.md");
    git("commit", "-q", "-m", "fixture");
    const before = entriesBelow(root);
    await initializeRequiredSandbox({ allowRead: [root] });
    const held = await holdWindowsFilesystemGrant({ label: "watched-fresh-native", allowRead: [], allowWrite: [workspace] });
    try {
      expect(entriesBelow(root)).toEqual(before);
      expect(watchedProtectedRows()).toContain(join(workspace, ".vscode"));
    } finally { held.release(); }
    // The profile root holds the helper's default ledger, so a write grant on it is refused before anything is stamped.
    expect(srtWinConfinementStatePaths()).toContain(join(root, "AppData", "Local", "sandbox-runtime"));
    await expect(holdWindowsFilesystemGrant({ label: "watched-fresh-native", allowRead: [], allowWrite: [root] }))
      .rejects.toMatchObject({ code: "confinement-state-write-grant", reason: "helper-ledger", path: root });
    expect(entriesBelow(root)).toEqual(before);
    await resetAsrtSandbox();
    expect(entriesBelow(root)).toEqual(before);
    expect(git("status", "--porcelain")).toBe("");
  }, 120_000);

  it("quarantines a .vscode\\tasks.json a command created under a worker grant when the command ends", async () => {
    const { workspace, held } = await grantedWorkspace();
    try {
      const { wrapped, invocation } = await runPlantingTasks(workspace);
      expect(isHostGitWorkspaceAvailable(workspace)).toBe(false);
      vi.stubEnv("AVE_HOME", sameVolumeAveHome());
      invocation.release();
      const outcome = await wrapped.cleanupCompleted;
      expect(outcome?.failure).toBeUndefined();
      expect(outcome?.notice).toContain(WATCHED_ROW_VIOLATION);
      expect(lstatSync(join(workspace, ".vscode"), { throwIfNoEntry: false })).toBeUndefined();
      const [entry, ...rest] = listWatchedQuarantine();
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ original: join(workspace, ".vscode"), row: join(workspace, ".vscode"), commandId: invocation.token });
      expect(readFileSync(join(entry?.quarantined ?? "", "tasks.json"), "utf8")).toContain("planted");
      expect(readFileSync(join(workspace, "allowed"), "utf8")).toContain("allowed");
      expect(isHostGitWorkspaceAvailable(workspace)).toBe(true);
    } finally { held.release(); }
  }, 60_000);

  it("fails closed and moves nothing when the created row cannot be quarantined", async () => {
    const { workspace, held } = await grantedWorkspace();
    try {
      const { wrapped, invocation } = await runPlantingTasks(workspace);
      const home = sameVolumeAveHome();
      writeFileSync(join(home, "sandbox-quarantine"), "");
      vi.stubEnv("AVE_HOME", home);
      invocation.release();
      const outcome = await wrapped.cleanupCompleted;
      expect(outcome?.notice).toBeUndefined();
      expect(outcome?.failure).toContain(JSON.stringify(join(workspace, ".vscode")));
      expect(readFileSync(join(workspace, ".vscode", "tasks.json"), "utf8")).toContain("planted");
      expect(isHostGitWorkspaceAvailable(workspace)).toBe(false);
      rmSync(join(workspace, ".vscode"), { recursive: true });
      expect(isHostGitWorkspaceAvailable(workspace)).toBe(true);
    } finally { held.release(); }
  }, 60_000);

  it("keeps a machine file unreadable after its parent receives a write grant", async () => {
    const machine = join(root, "machine");
    const workspace = join(machine, "Ave");
    mkdirSync(workspace, { recursive: true });
    vi.stubEnv("ProgramData", machine);
    const target = join(workspace, "secret");
    writeFileSync(target, "secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target], denyWrite: [target] });
    const earlier = await wrapToolCommand(`type "${target}"`, { commandId: TEST_COMMAND_ID });
    const held = await holdWindowsFilesystemGrant({ label: "machine-deny-native", allowRead: [], allowWrite: [workspace] });
    try {
      expect(() => execFileSync(earlier.argv[0]!, earlier.argv.slice(1), {
        env: { ...process.env, ...earlier.env }, cwd: root, windowsHide: true,
      })).toThrow();
    } finally { held.release(); }
  }, 60_000);

  it("refuses a native write grant beneath an initially unmatched deny glob", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const pattern = join(workspace, "*.secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [pattern], denyWrite: [pattern] });
    writeFileSync(join(workspace, "new.secret"), "secret");
    await expect(holdWindowsFilesystemGrant({ label: "glob-deny-native", allowRead: [], allowWrite: [workspace] }).then(held => { held.release(); }))
      .rejects.toThrow(/glob/i);
  }, 60_000);

  it("watches an absent row whose fixture parent denies owner creation without creating it", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target], denyWrite: [target] });
    const restore = denyOwner(workspace, 2);
    try {
      expect(() => writeFileSync(target, "owner cannot create")).toThrow();
      const held = await holdWindowsFilesystemGrant({ label: "dropped-deny-native", allowRead: [], allowWrite: [workspace] });
      try { expect(watchedProtectedRows()).toContain(target); }
      finally { held.release(); }
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    } finally { restore(); }
  }, 60_000);

  it("refuses a worker grant whose write-root floor cannot list the workspace and creates nothing", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target], denyWrite: [target] });
    const restore = denyOwner(workspace, 3);
    try {
      expect(() => writeFileSync(target, "owner cannot create")).toThrow();
      await expect(holdWindowsFilesystemGrant({ label: "unlisted-deny-native", allowRead: [], allowWrite: [workspace] }).then(held => { held.release(); }))
        .rejects.toThrow(/floor could not cover/);
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    } finally { restore(); }
  }, 60_000);

  it("watches an absent directory row instead of creating it", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "private");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target + sep], denyWrite: [target + sep] });
    const held = await holdWindowsFilesystemGrant({ label: "directory-deny-native", allowRead: [], allowWrite: [workspace] });
    try {
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
      expect(watchedProtectedRows()).toContain(target);
    } finally { held.release(); }
  }, 60_000);
});

describe.runIf(process.platform === "win32" && hasNativeSrtWinBuildReceipt())("Windows private helper deny lifetime", () => {
  let container: string;

  beforeEach(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    container = mkdtempSync(join(os.tmpdir(), "helper-deny-native-"));
    vi.stubEnv("TEMP", container);
    vi.stubEnv("TMP", container);
  });

  afterEach(async () => {
    try { await runtime.SandboxManager.reset(); }
    finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await cleanupTmpDir(container);
    }
  });

  function helper(): { executable: string; directory: string; sid: string; srtWin: runtime.SrtWinSpawn } {
    const source = join(container, "source.exe");
    copyFileSync(getVendoredSrtWinExePath(), source);
    const executable = prepareSrtWinExecutable(source);
    const srtWin = runtime.resolveSrtWin({ path: executable });
    const sid = runtime.getWindowsSandboxUserStatus({ srtWin }).sid;
    if (!sid) throw new Error("Sandbox SID is required for private helper verification");
    const directory = dirname(executable);
    expect(srtWinPrivateDirectories()).toContain(directory);
    return { executable, directory, sid, srtWin };
  }

  function descriptor(path: string): string {
    return execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile", "-NonInteractive", "-Command",
      `[System.IO.Directory]::GetAccessControl('${path.replace(/'/g, "''")}').GetSecurityDescriptorSddlForm('Access')`,
    ], { encoding: "utf8", env: windowsPowerShellEnv(), windowsHide: true }).trim();
  }

  it("keeps the temp root free of sandbox ACEs during a real session and removes the private parent deny on reset", async () => {
    const { executable, directory, sid } = helper();
    expect(descriptor(os.tmpdir())).not.toContain(sid);
    try {
      await runtime.SandboxManager.initialize({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { allowWrite: [], denyRead: [], denyWrite: [directory] },
        windows: { srtWin: { path: executable } },
      });
      expect(readWindowsDenyAcls([directory], sid)[0]?.parentMask).toBe(0x40);
      expect(descriptor(os.tmpdir())).not.toContain(sid);
    } finally { await runtime.SandboxManager.reset(); }
    expect(descriptor(dirname(directory))).not.toContain(sid);
    expect(descriptor(os.tmpdir())).not.toContain(sid);
  }, 60_000);

  it("removes the private parent deny when its native holder is released", () => {
    const { directory, sid, srtWin } = helper();
    try {
      stampWindowsAcl({ sandboxUserSid: sid, srtWin, denyRead: [], denyWrite: [directory] });
      expect(readWindowsDenyAcls([directory], sid)[0]?.parentMask).toBe(0x40);
      expect(descriptor(os.tmpdir())).not.toContain(sid);
    } finally { restoreWindowsAcl({ sandboxUserSid: sid, srtWin }); }
    expect(descriptor(dirname(directory))).not.toContain(sid);
    expect(descriptor(os.tmpdir())).not.toContain(sid);
  }, 60_000);

  it("diagnoses a legacy temp-root ACE without changing that ACL", () => {
    const { sid, srtWin } = helper();
    const legacy = join(container, "ave-srt-win-legacy");
    mkdirSync(legacy);
    const warning = vi.spyOn(console, "warn");
    try {
      stampWindowsAcl({ sandboxUserSid: sid, srtWin, denyRead: [], denyWrite: [legacy] });
      const before = descriptor(os.tmpdir());
      expect(before).toContain(sid);
      sweepStaleSrtWinDirectories();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("[srt-win-temp-root-acl-owner-action-required]"));
      expect(descriptor(os.tmpdir())).toBe(before);
    } finally { restoreWindowsAcl({ sandboxUserSid: sid, srtWin }); }
  }, 60_000);

  it.each(["single-level", "two-level"])("records dead-holder recovery for a %s copy inside a fixture", async (layout) => {
    const { directory, sid, srtWin } = helper();
    const legacyTemp = join(container, "fixture-temp");
    const outer = join(legacyTemp, "ave-srt-win-abandoned");
    const target = layout === "single-level" ? outer : join(outer, "bin");
    mkdirSync(legacyTemp);
    const quote = (path: string) => `'${path.replace(/'/g, "''")}'`;
    execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"), [
      "-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; $acl=[System.IO.Directory]::GetAccessControl(${quote(dirname(directory))});
       [System.IO.Directory]::CreateDirectory(${quote(outer)},$acl) | Out-Null;
       ${layout === "two-level" ? `[System.IO.Directory]::CreateDirectory(${quote(target)},$acl) | Out-Null` : ""}`,
    ], { env: windowsPowerShellEnv(), windowsHide: true });
    const held = spawn(join(process.env.SystemRoot!, "System32", "more.com"), [], { env: windowsPowerShellEnv(), windowsHide: true, stdio: "pipe" });
    const exited = once(held, "exit");
    if (!held.pid) throw new Error("Native holder did not start");
    const holderPid = held.pid;
    try {
      stampWindowsAcl({ sandboxUserSid: sid, srtWin, holderPid, denyRead: [], denyWrite: [target] });
      expect(readWindowsDenyAcls([target], sid)[0]?.parentMask).toBe(0x40);
      held.kill();
      await exited;
      const afterDeath = descriptor(dirname(target));
      const trigger = join(container, "recovery-trigger", "target");
      mkdirSync(trigger, { recursive: true });
      stampWindowsAcl({ sandboxUserSid: sid, srtWin, denyRead: [], denyWrite: [trigger] });
      const afterNextStamp = descriptor(dirname(target));
      console.log(JSON.stringify({ diagnostic: "private-helper-dead-holder", layout, afterDeath, afterNextStamp }));
      expect(afterDeath).toContain(sid);
      expect(afterNextStamp).not.toContain(sid);
      expect(descriptor(os.tmpdir())).not.toContain(sid);
    } finally {
      if (held.exitCode === null && held.signalCode === null) { held.kill(); await exited; }
      restoreWindowsAcl({ sandboxUserSid: sid, srtWin, holderPid });
      restoreWindowsAcl({ sandboxUserSid: sid, srtWin });
    }
  }, 60_000);

  it.each(["moved", "deleted"])("recovers a transient deny after its object is %s", async disposition => {
    const { sid, srtWin } = helper();
    const target = join(container, "lifecycle", "target");
    const moved = join(container, "lifecycle", "moved");
    mkdirSync(target, { recursive: true });
    const held = spawn(win32SystemBinary("more.com"), [], { env: windowsPowerShellEnv(), windowsHide: true, stdio: "pipe" });
    const exited = once(held, "exit");
    if (!held.pid) throw new Error("Native holder did not start");
    const holderPid = held.pid;
    try {
      stampWindowsAcl({ sandboxUserSid: sid, srtWin, holderPid, denyRead: [], denyWrite: [target] });
      expect(readWindowsDenyAcls([target], sid)[0]?.denyMask).not.toBe(0);
      if (disposition === "moved") {
        renameSync(target, moved);
        mkdirSync(target);
        expect(readWindowsDenyAcls([target], sid)[0]?.denyMask).toBe(0);
      } else {
        rmSync(target, { recursive: true });
      }
      held.kill();
      await exited;
      const report = recoverWindowsAcl({ srtWin });
      expect(report.deadBrokers).toBeGreaterThanOrEqual(1);
      expect(report.acesRevoked).toBeGreaterThanOrEqual(2);
      if (disposition === "moved") {
        expect(readWindowsDenyAcls([moved], sid)[0]?.denyMask).not.toBe(0);
        expect(readWindowsDenyAcls([target], sid)[0]?.denyMask).toBe(0);
      } else {
        expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
      }
      expect(descriptor(dirname(target))).not.toContain(sid);
    } finally {
      if (held.exitCode === null && held.signalCode === null) { held.kill(); await exited; }
      restoreWindowsAcl({ sandboxUserSid: sid, srtWin, holderPid });
    }
  }, 60_000);

  it("emits individual native deny timings only while debugging is enabled", () => {
    const { sid, srtWin } = helper();
    const target = join(container, "timing", "target");
    mkdirSync(target, { recursive: true });
    const args = [...srtWin.prependArgs, "acl", "stamp", "--holder-pid", String(process.pid), "--sandbox-user-sid", sid];
    const input = JSON.stringify({ denyRead: [], denyWrite: [target] });
    const records = (stderr: string) => stderr.split("\n").filter(line => line.trim().startsWith("{")).map(line => JSON.parse(line));
    try {
      const enabled = spawnSync(srtWin.exe, args, { input, encoding: "utf8", windowsHide: true, env: { ...process.env, SRT_DEBUG: "1" } });
      expect(enabled.error).toBeUndefined();
      expect(enabled.status).toBe(0);
      const timings = records(enabled.stderr);
      expect(timings).toHaveLength(2);
      expect(timings.map(row => row.kind)).toEqual(["denyWrite", "fdc"]);
      const key = (path: string) => path.replace(/^\\\\\?\\/, "").toLowerCase();
      expect(key(timings[0].path)).toBe(key(target));
      expect(key(timings[0].parent)).toBe(key(dirname(target)));
      expect(key(timings[1].path)).toBe(key(dirname(target)));
      expect(key(timings[1].parent)).toBe(key(dirname(dirname(target))));
      for (const row of timings) {
        expect(Object.keys(row).sort()).toEqual(["elapsedMs", "kind", "parent", "path"]);
        expect(Number.isFinite(row.elapsedMs)).toBe(true);
        expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
      }
      // Independent DACL evidence proves these records came from real effects.
      expect(readWindowsDenyAcls([target], sid)[0]?.denyMask).not.toBe(0);
      expect(readWindowsDenyAcls([target], sid)[0]?.parentMask).toBe(0x40);
      const disabled = spawnSync(srtWin.exe, args, { input, encoding: "utf8", windowsHide: true, env: { ...process.env, SRT_DEBUG: "" } });
      expect(disabled.error).toBeUndefined();
      expect(disabled.status).toBe(0);
      expect(records(disabled.stderr)).toEqual([]);
      expect(readWindowsDenyAcls([target], sid)[0]?.denyMask).not.toBe(0);
    } finally {
      restoreWindowsAcl({ sandboxUserSid: sid, srtWin });
    }
  }, 60_000);
});
