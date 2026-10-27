import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { assertSrtWinDigest, assertSrtWinSpawnIntegrity, getSrtWinArchitecture, prepareSrtWinExecutable, sweepStaleSrtWinDirectories } from "../srt-win-integrity.js";

const require = createRequire(import.meta.url);
const { assertSrtWinVendor } = require("../../../scripts/lib/srt-win-integrity.cjs") as {
  assertSrtWinVendor: (path: string, arches?: string[]) => void;
};
const vendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
const directories: string[] = [];
function fixture(): { source: string; bytes: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), "ave-srt-integrity-test-"));
  directories.push(directory);
  const source = join(directory, "srt-win.exe");
  copyFileSync(join(vendor, "srt-win", getSrtWinArchitecture(), "srt-win.exe"), source);
  return { source, bytes: readFileSync(source) };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Windows helper integrity", () => {
  it.each([["ia32", "x64"], ["x64", "x64"], ["arm64", "arm64"]])("maps host architecture %s to %s", (host, expected) => {
    expect(getSrtWinArchitecture(host)).toBe(expected);
  });

  it("excludes the pinned helper from signing while preserving application signing", () => {
    const { build } = require("../../../package.json");
    expect(build.win.signExts).toEqual(["!srt-win.exe"]);
    expect(build.win.signExecutable).not.toBe(false);
    expect(build.win.signAndEditExecutable).not.toBe(false);
    // Exercise the installed packager's filter, without a signing identity.
    require("app-builder-lib");
    const { WinPackager } = require("app-builder-lib/out/winPackager.js");
    const shouldSign = (file: string) => WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: build.win }, file);
    expect(shouldSign(join("app.asar.unpacked", "vendor", "srt-win", "x64", "srt-win.exe"))).toBe(false);
    expect(shouldSign(join("app.asar.unpacked", "vendor", "srt-win", "arm64", "srt-win.exe"))).toBe(false);
    expect(shouldSign("Ave.exe")).toBe(true);
    expect(shouldSign("other-helper.exe")).toBe(true);
  });

  // Owner SID and image sharing checks require the native filesystem APIs.
  describe.skipIf(process.platform !== "win32")("stale private image cleanup", () => {
    function stage(layout: "single-level" | "two-level" = "two-level"): string {
      const { source } = fixture();
      const imageDirectory = dirname(prepareSrtWinExecutable(source));
      const original = basename(imageDirectory) === "bin" ? dirname(imageDirectory) : imageDirectory;
      // Model another host's abandoned copy, outside this host's cache.
      const directory = `${original}-abandoned`;
      renameSync(original, directory);
      directories.push(directory);
      const staged = basename(imageDirectory) === "bin" ? join(directory, "bin") : directory;
      const target = layout === "two-level" ? join(directory, "bin") : directory;
      if (staged !== target) {
        if (layout === "two-level") {
          const script = `$ErrorActionPreference='Stop'; $acl=[System.IO.Directory]::GetAccessControl('${directory.replace(/'/g, "''")}'); [System.IO.Directory]::CreateDirectory('${target.replace(/'/g, "''")}',$acl) | Out-Null`;
          execFileSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
            "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
          ], { env: process.env, windowsHide: true, stdio: "pipe" });
        }
        for (const name of ["srt-win.exe", "owner.json"]) renameSync(join(staged, name), join(target, name));
        if (staged !== directory) rmdirSync(staged);
      }
      return target;
    }

    function isolateTemp(): void {
      const root = mkdtempSync(join(tmpdir(), "srt-sweep-test-"));
      directories.push(root);
      vi.stubEnv("TEMP", root);
      vi.stubEnv("TMP", root);
    }

    function abandon(directory: string): void {
      writeFileSync(join(directory, "owner.json"), JSON.stringify({ pid: 2147483647, started: "1" }));
    }

    it.each(["single-level", "two-level"] as const)("removes only a verified stale %s copy", (layout) => {
      isolateTemp();
      const directory = stage(layout);
      abandon(directory);
      const outer = layout === "two-level" ? dirname(directory) : directory;
      sweepStaleSrtWinDirectories();
      expect(existsSync(outer)).toBe(false);
    });

    it("removes a dead owner's image but retains the current process even with a reused PID marker", () => {
      isolateTemp();
      const stale = stage();
      abandon(stale);
      const current = stage();
      const { source } = fixture();
      const cached = dirname(prepareSrtWinExecutable(source));
      directories.push(cached);
      abandon(cached);
      expect(JSON.parse(readFileSync(join(current, "owner.json"), "utf8"))).toMatchObject({ pid: process.pid, started: expect.any(String) });
      writeFileSync(join(current, "owner.json"), JSON.stringify({ pid: process.pid, started: "1" }));
      sweepStaleSrtWinDirectories();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(current)).toBe(true);
      expect(existsSync(cached)).toBe(true);
    });

    it.each(["missing marker", "invalid marker", "unexpected file", "nested directory"])("retains an uncertain directory with %s", (kind) => {
      isolateTemp();
      const directory = stage();
      abandon(directory);
      if (kind === "missing marker") rmSync(join(directory, "owner.json"));
      if (kind === "invalid marker") writeFileSync(join(directory, "owner.json"), "{}");
      if (kind === "unexpected file") writeFileSync(join(directory, "extra"), "keep");
      if (kind === "nested directory") mkdirSync(join(directory, "nested"));
      sweepStaleSrtWinDirectories();
      expect(existsSync(join(directory, "srt-win.exe"))).toBe(true);
    });

    it("never traverses a junction or a linked directory entry", (context) => {
      isolateTemp();
      const target = stage();
      abandon(target);
      const link = join(tmpdir(), "ave-srt-win-link");
      try { symlinkSync(target, link, "junction"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("Directory links require a capability this host does not grant");
        throw error;
      }
      // An extra entry makes the target ineligible independently of the link.
      mkdirSync(join(target, "keep"));
      const nested = stage();
      abandon(nested);
      rmSync(join(nested, "srt-win.exe"));
      symlinkSync(target, join(nested, "srt-win.exe"), "junction");
      sweepStaleSrtWinDirectories();
      expect(existsSync(link)).toBe(true);
      expect(existsSync(join(nested, "owner.json"))).toBe(true);
      expect(existsSync(join(target, "srt-win.exe"))).toBe(true);
    });

    it("retains a linked bin without reading its marker or deleting its target", () => {
      isolateTemp();
      const target = stage();
      abandon(target);
      mkdirSync(join(target, "keep"));
      const directory = stage();
      abandon(directory);
      rmSync(join(directory, "srt-win.exe"));
      rmSync(join(directory, "owner.json"));
      rmdirSync(directory);
      symlinkSync(target, directory, "junction");
      sweepStaleSrtWinDirectories();
      expect(existsSync(join(directory, "owner.json"))).toBe(true);
      expect(existsSync(join(target, "srt-win.exe"))).toBe(true);
      rmdirSync(directory);
    });

    it("leaves a foreign-owned protected directory alone", (context) => {
      isolateTemp();
      const directory = join(tmpdir(), "ave-srt-win-foreign");
      const script = [
        "$ErrorActionPreference='Stop'",
        "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$acl=New-Object System.Security.AccessControl.DirectorySecurity",
        "$acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')))",
        "$acl.SetAccessRuleProtection($true,$false)",
        "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))",
        `try { [System.IO.Directory]::CreateDirectory('${directory.replace(/'/g, "''")}',$acl) | Out-Null } catch [System.UnauthorizedAccessException], [System.Security.AccessControl.PrivilegeNotHeldException] { exit 3 } catch [System.IO.IOException] { if (($_.Exception.HResult -band 0xffff) -eq 1307) { exit 3 }; throw }`,
        `if ([System.IO.Directory]::GetAccessControl('${directory.replace(/'/g, "''")}').GetOwner([System.Security.Principal.SecurityIdentifier]) -eq $sid) { throw 'Foreign directory fixture retained the current owner' }`,
      ].join("; ");
      const result = spawnSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ], { env: process.env, windowsHide: true, encoding: "utf8" });
      if (result.status === 3) return context.skip("Token cannot create a directory with a different owner");
      expect(result.status, result.stderr).toBe(0);
      writeFileSync(join(directory, "srt-win.exe"), "fixture");
      abandon(directory);
      sweepStaleSrtWinDirectories();
      expect(existsSync(join(directory, "srt-win.exe"))).toBe(true);
      expect(existsSync(join(directory, "owner.json"))).toBe(true);
    });

    it("keeps a live owner, rejects PID reuse, and keeps a dead owner's image while another process holds it", async () => {
      isolateTemp();
      const live = stage();
      const reused = stage();
      const held = stage();
      abandon(held);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$handle = [System.IO.File]::Open($env:AVE_SRT_TEST_IMAGE, 'Open', 'Read', 'Read')",
        "$p = [System.Diagnostics.Process]::GetCurrentProcess()",
        // Built without ConvertTo-Json: autoloading its module in this minimal environment took tens of seconds on the hosted runner.
        "[Console]::Out.WriteLine('{\"pid\":' + $p.Id + ',\"started\":\"' + $p.StartTime.ToUniversalTime().Ticks.ToString() + '\"}')",
        "try { [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }",
      ].join("; ");
      const child = spawn(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ], {
        env: { SystemRoot: process.env.SystemRoot, AVE_SRT_TEST_IMAGE: join(held, "srt-win.exe") },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      const exited = once(child, "exit");
      try {
        const [output] = await once(child.stdout, "data");
        const marker = JSON.parse(String(output));
        writeFileSync(join(live, "owner.json"), JSON.stringify(marker));
        writeFileSync(join(reused, "owner.json"), JSON.stringify({ ...marker, started: "1" }));
        sweepStaleSrtWinDirectories();
        expect(existsSync(live)).toBe(true);
        expect(existsSync(reused)).toBe(false);
        expect(existsSync(join(held, "srt-win.exe"))).toBe(true);
        expect(existsSync(join(held, "owner.json"))).toBe(true);
      } finally {
        child.stdin.end("\n");
        await exited;
      }
      sweepStaleSrtWinDirectories();
      expect(existsSync(live)).toBe(false);
      expect(existsSync(held)).toBe(false);
    });

    it("retains a directory with inherited modification grants", () => {
      isolateTemp();
      const directory = stage();
      abandon(directory);
      const script = "$ErrorActionPreference = 'Stop'; $acl = [System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY); $acl.SetAccessRuleProtection($false, $true); [System.IO.Directory]::SetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY, $acl)";
      execFileSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ], { env: { SystemRoot: process.env.SystemRoot, AVE_SRT_PRIVATE_DIRECTORY: directory }, windowsHide: true, stdio: "pipe", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs });
      sweepStaleSrtWinDirectories();
      expect(existsSync(join(directory, "srt-win.exe"))).toBe(true);
    });
  });
  it.each(["x64", "arm64"])("pins the shipped %s bytes in both runtime and packaging verifiers", (arch) => {
    const path = join(vendor, "srt-win", arch, "srt-win.exe");
    expect(() => assertSrtWinDigest(readFileSync(path), arch)).not.toThrow();
    expect(() => assertSrtWinVendor(vendor, [arch])).not.toThrow();
  });

  it.each(["bitflip", "same-size garbage"])("rejects %s with an integrity code before staging", (kind) => {
    const { source, bytes } = fixture();
    if (kind === "bitflip") bytes[0x20] ^= 1;
    else bytes.fill(0x41);
    writeFileSync(source, bytes);
    expect(() => prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
    const packaged = join(dirname(source), "vendor", "srt-win", process.arch);
    mkdirSync(packaged, { recursive: true });
    writeFileSync(join(packaged, "srt-win.exe"), bytes);
    expect(() => assertSrtWinVendor(join(dirname(source), "vendor"), [process.arch])).toThrow("srt-win-integrity-mismatch");
  });

  it("retains the missing-file code and refuses unpinned architectures", () => {
    const { source, bytes } = fixture();
    expect(() => prepareSrtWinExecutable(`${source}.missing`)).toThrow(expect.objectContaining({ code: "srt-win-not-found" }));
    for (const arch of ["ia32", "__proto__", "constructor"]) {
      expect(() => assertSrtWinDigest(bytes, arch)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
    }
  });

  it("checks every shipped architecture and rejects an unexpected architecture", () => {
    expect(() => assertSrtWinVendor(vendor)).not.toThrow();
    expect(() => assertSrtWinVendor(vendor, ["unknown"])).toThrow();
  });

  it("checks the final unpacked images after signing and fails the build on a changed image", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-srt-package-test-"));
    directories.push(directory);
    const outputVendor = join(directory, "resources", "app.asar.unpacked", "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor");
    for (const arch of ["x64", "arm64"]) {
      const target = join(outputVendor, "srt-win", arch);
      mkdirSync(target, { recursive: true });
      copyFileSync(join(vendor, "srt-win", arch, "srt-win.exe"), join(target, "srt-win.exe"));
    }
    const afterSign = require("../../../scripts/electron-after-sign.cjs") as (context: { electronPlatformName: string; appOutDir: string }) => Promise<void>;
    await expect(afterSign({ electronPlatformName: "win32", appOutDir: directory })).resolves.toBeUndefined();
    const target = join(outputVendor, "srt-win", "arm64", "srt-win.exe");
    const bytes = readFileSync(target);
    bytes[0x20] ^= 1;
    writeFileSync(target, bytes);
    await expect(afterSign({ electronPlatformName: "win32", appOutDir: directory })).rejects.toThrow("srt-win-integrity-mismatch");
    await expect(afterSign({ electronPlatformName: "linux", appOutDir: "unused" })).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== "win32")("allows runner read and execute access while keeping the host the sole image modifier", () => {
    const { source } = fixture();
    const executable = prepareSrtWinExecutable(source);
    directories.push(dirname(dirname(executable)));
    // Core cmdlets and.NET only. In this minimal environment a Utility cmdlet such as Write-Output would make PowerShell scan every installed module first, which took 40 s or more on the hosted runner.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$PSModuleAutoLoadingPreference='None'",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl=[System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY)",
      "if (!$acl.AreAccessRulesProtected) { throw 'Inherited grants' }",
      "$readers=@('S-1-5-18','S-1-5-32-544','S-1-5-32-545')",
      "$rx=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
      "$full=[System.Security.AccessControl.FileSystemRights]::FullControl",
      "$modify=[System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
      "$image=[System.IO.Path]::Combine($env:AVE_SRT_PRIVATE_DIRECTORY, 'srt-win.exe')",
      "foreach ($acl in @([System.IO.Directory]::GetAccessControl([System.IO.Path]::GetDirectoryName($env:AVE_SRT_PRIVATE_DIRECTORY)), [System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY), [System.IO.File]::GetAccessControl($image))) {",
      "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Wrong owner' }",
      "if (@($acl.Access).Count -ne 4) { throw 'Unexpected grants' }",
      "foreach ($entry in $acl.Access) {",
      "$id=$entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier])",
      "if ($entry.AccessControlType -ne 'Allow') { throw 'Unexpected deny' }",
      "if ($id -eq $sid -and ($entry.FileSystemRights -band $full) -ne $full) { throw 'Host lacks control' }",
      "if ($id -ne $sid -and ($id.Value -notin $readers -or ($entry.FileSystemRights -band $modify) -ne 0)) { throw 'Non-host modification grant' }",
      "}",
      "foreach ($id in $readers) {",
      "$grants=@($acl.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $id })",
      "if ($grants.Count -ne 1 -or ($grants[0].FileSystemRights -band $rx) -ne $rx) { throw 'Missing runner or consent access' }",
      "}",
      "}",
      "[Console]::Out.WriteLine('private-image-protected')",
    ].join("; ");
    const output = execFileSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], {
      env: { SystemRoot: process.env.SystemRoot, AVE_SRT_PRIVATE_DIRECTORY: dirname(executable) },
      windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs, stdio: "pipe",
    });
    expect(output.trim()).toBe("private-image-protected");
  });

  // The two PowerShell steps as `prepareSrtWinExecutable` sends them, captured on any host: the stale-copy sweep, then the private-directory step.
  async function captureScripts(): Promise<string[]> {
    const scripts: string[] = [];
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), type: () => "Windows_NT" }));
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...await importOriginal<typeof import("node:child_process")>(),
      execFileSync: (_command: string, args: readonly string[], options: { env: Record<string, string> }) => {
        scripts.push(Buffer.from(args.at(-1)!, "base64").toString("utf16le"));
        // Stand in for the private-directory step, which creates the directory and the empty image itself: nothing may exist at its path before.
        const directory = options.env.AVE_SRT_PRIVATE_DIRECTORY;
        if (directory) {
          expect(existsSync(directory)).toBe(false);
          mkdirSync(directory);
          mkdirSync(join(directory, "bin"));
          writeFileSync(join(directory, "bin", "srt-win.exe"), "");
        }
        return Buffer.alloc(0);
      },
    }));
    vi.stubEnv("SystemRoot", process.env.SystemRoot ?? "C:\\Windows");
    try {
      const integrity = await import("../srt-win-integrity.js");
      directories.push(dirname(dirname(integrity.prepareSrtWinExecutable(fixture().source))));
    } finally {
      vi.doUnmock("node:os");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
    expect(scripts).toHaveLength(2);
    return scripts;
  }

  it("names every module its PowerShell steps use", async () => {
    const scripts = await captureScripts();
    const modules: Record<string, string> = {
      "Import-Module": "Core", "Where-Object": "Core",
      "New-Object": "Utility", "ConvertTo-Json": "Utility", "ConvertFrom-Json": "Utility",
    };
    for (const script of scripts) {
      expect(script.split("; ").slice(0, 3)).toEqual([
        "$ErrorActionPreference = 'Stop'",
        "$PSModuleAutoLoadingPreference = 'None'",
        String.raw`Import-Module ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')`,
      ]);
      const cmdlets = [...new Set(script.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g))];
      expect(cmdlets.length).toBeGreaterThan(1);
      for (const cmdlet of cmdlets) expect(modules, cmdlet).toHaveProperty([cmdlet]);
    }
  });

  it("creates the private copy with its final descriptor and never changes an existing object's", async () => {
    const [, script] = await captureScripts();
    // No step sets an owner or a DACL on a path: only new descriptors get an owner.
    expect(script).not.toMatch(/SetAccessControl\(/);
    expect(script.match(/\$\w+\.SetOwner\(/g)).toEqual(["$security.SetOwner(", "$fileSecurity.SetOwner("]);
    // Anything already at the path refuses creation, before the create call.
    const refusal = script!.indexOf("throw 'Private directory already exists'");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(script!.indexOf("[System.IO.Directory]::CreateDirectory($outer, $security)"));
    expect(script).toContain("[System.IO.FileMode]::CreateNew");
    expect(script).toContain("$fileSecurity)");
    expect(script).toContain("$stream.GetAccessControl().GetOwner(");
  });

  // Run the captured step against a path that already holds something: it must refuse, and leave that object's owner and DACL exactly as they were.
  it.runIf(process.platform === "win32").for(["Administrators-owned directory", "SYSTEM-owned directory", "junction"])(
    "refuses a private path that is already a %s and changes nothing",
    async (kind, context) => {
      const [, script] = await captureScripts();
      const parent = mkdtempSync(join(tmpdir(), "ave-srt-existing-"));
      directories.push(parent);
      const target = join(parent, "target");
      if (kind !== "junction") {
        const ownerSid = kind === "Administrators-owned directory" ? "S-1-5-32-544" : "S-1-5-18";
        const ownership = spawnSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
          "-NoProfile", "-NonInteractive", "-Command",
          [
            "$ErrorActionPreference='Stop'",
            "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
            "$acl=[System.Security.AccessControl.DirectorySecurity]::new()",
            `$acl.SetOwner([System.Security.Principal.SecurityIdentifier]::new('${ownerSid}'))`,
            "$acl.SetAccessRuleProtection($true,$false)",
            "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))",
            `try { [System.IO.Directory]::CreateDirectory('${target.replace(/'/g, "''")}',$acl) | Out-Null } catch [System.UnauthorizedAccessException], [System.Security.AccessControl.PrivilegeNotHeldException] { exit 3 } catch [System.IO.IOException] { if (($_.Exception.HResult -band 0xffff) -eq 1307) { exit 3 }; throw }`,
            `if ([System.IO.Directory]::GetAccessControl('${target.replace(/'/g, "''")}').GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne '${ownerSid}') { throw 'Foreign directory fixture retained the wrong owner' }`,
          ].join("; "),
        ], { windowsHide: true, encoding: "utf8" });
        if (ownership.status === 3) return context.skip("Token cannot create a directory with a different owner");
        expect(ownership.error).toBeUndefined();
        expect(ownership.status, ownership.stderr).toBe(0);
      } else {
        mkdirSync(target);
      }
      const path = kind === "junction" ? join(parent, "link") : target;
      if (kind === "junction") symlinkSync(target, path, "junction");
      const descriptor = () => execFileSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-Command",
        "[System.IO.Directory]::GetAccessControl($env:AVE_TEST_TARGET).GetSecurityDescriptorSddlForm('Owner, Access')",
      ], { env: { ...process.env, AVE_TEST_TARGET: target }, windowsHide: true, encoding: "utf8", stdio: "pipe" }).trim();
      const before = descriptor();
      try {
        const run = spawnSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script!, "utf16le").toString("base64"),
        ], {
          env: { SystemRoot: process.env.SystemRoot, AVE_SRT_OWNER_PID: String(process.pid), AVE_SRT_PRIVATE_DIRECTORY: path },
          windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
        });
        expect(run.status, run.stderr).not.toBe(0);
        expect(run.stderr).toContain("Private directory already exists");
        expect(descriptor()).toBe(before);
        expect(existsSync(path)).toBe(true);
        expect(existsSync(join(target, "srt-win.exe"))).toBe(false);
        expect(existsSync(join(target, "owner.json"))).toBe(false);
      } finally {
        // Remove the link itself first, so the recursive cleanup never walks it.
        if (kind === "junction") rmdirSync(path);
      }
    },
  );

  it("revalidates a cached image and the source instead of trusting a previous check", () => {
    const { source, bytes } = fixture();
    const executable = prepareSrtWinExecutable(source);
    directories.push(dirname(dirname(executable)));
    expect(executable).not.toBe(source);
    expect(readFileSync(executable)).toEqual(bytes);
    writeFileSync(executable, Buffer.alloc(bytes.length));
    expect(() => prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
    if (process.platform === "win32") {
      expect(() => assertSrtWinSpawnIntegrity(executable)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
      expect(() => assertSrtWinSpawnIntegrity(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
    }
  });

  it.skipIf(process.platform !== "win32")("executes the private snapshot when the checked source is swapped before spawn", () => {
    const { source, bytes } = fixture();
    const executable = prepareSrtWinExecutable(source);
    directories.push(dirname(dirname(executable)));
    writeFileSync(source, Buffer.alloc(bytes.length));
    assertSrtWinSpawnIntegrity(executable);
    const result = spawnSync(executable, ["--srt-win", "--help"], {
      windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(readFileSync(executable)).toEqual(bytes);
    expect(() => prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
  });
});
