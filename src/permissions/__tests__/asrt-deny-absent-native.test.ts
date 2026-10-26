import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { initializeRequiredSandbox } from "../../__tests__/support/native-sandbox.js";
import { checkAsrtDependencies, getVendoredSrtWinExePath, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { windowsSandboxCanSpawn } from "./test-helpers.js";
import { holdWindowsFilesystemGrant } from "../windows-acl-grant-holder.js";
import { win32SystemBinary } from "../../shared/ave-home.js";
import { windowsPowerShellEnv } from "../../shared/windows-powershell-env.js";
import { configureHostResources } from "../../main/host-resources.js";
import { prepareSrtWinExecutable, srtWinPrivateDirectories, sweepStaleSrtWinDirectories } from "../srt-win-integrity.js";
import { restoreWindowsAcl, stampWindowsAcl } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { readWindowsDenyAcls } from "../windows-deny-acl.js";

useVerifiedAveHomePrivacy();

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

describe.runIf(process.platform === "win32")("Windows absent deny native enforcement", () => {
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
        rmSync(container, { recursive: true, force: true });
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

  it("protects an earlier native wrap while a later worker grant permits a sibling write", async () => {
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
    try {
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeDefined();
      const allowed = await wrapToolCommand(`echo allowed > "${sibling}"`, { commandId: TEST_COMMAND_ID });
      execFileSync(allowed.argv[0]!, allowed.argv.slice(1), { env: { ...process.env, ...allowed.env }, cwd: root, windowsHide: true });
      expect(readFileSync(sibling, "utf8")).toContain("allowed");
      expect(() => execFileSync(earlier.argv[0]!, earlier.argv.slice(1), {
        env: { ...process.env, ...earlier.env }, cwd: root, windowsHide: true,
      })).toThrow();
      expect(readFileSync(target, "utf8")).not.toContain("unsafe");
    } finally {
      held.release();
    }
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

  it("refuses a dropped native placeholder when its fixture parent denies owner creation", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target], denyWrite: [target] });
    const command = `$ErrorActionPreference='Stop'; $path='${workspace.replace(/'/g, "''")}';
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
      $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]3, 'Deny');
      $acl=Get-Acl -LiteralPath $path; $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl;`;
    const run = (script: string) => execFileSync(win32SystemBinary("WindowsPowerShell/v1.0/powershell"),
      ["-NoProfile", "-NonInteractive", "-Command", script], {
        env: windowsPowerShellEnv(), windowsHide: true,
      });
    run(command);
    try {
      expect(() => writeFileSync(target, "owner cannot create")).toThrow();
      await expect(holdWindowsFilesystemGrant({ label: "dropped-deny-native", allowRead: [], allowWrite: [workspace] }).then(held => { held.release(); }))
        .rejects.toThrow(/verif|DACL/i);
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    } finally {
      run(command.replace("$acl.AddAccessRule($rule)", "$acl.RemoveAccessRuleSpecific($rule)"));
    }
  }, 60_000);

  it("preserves a directory placeholder and verifies its inherited deny", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "private");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target + sep], denyWrite: [target + sep] });
    const held = await holdWindowsFilesystemGrant({ label: "directory-deny-native", allowRead: [], allowWrite: [workspace] });
    try { expect(lstatSync(target).isDirectory()).toBe(true); }
    finally { held.release(); }
  }, 60_000);
});

describe.runIf(process.platform === "win32")("Windows private helper deny lifetime", () => {
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
      rmSync(container, { recursive: true, force: true });
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
});
