import { tsxChildEnv } from "../../__tests__/support/tsx-child-env.js";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { hasNativeSrtWinBuildReceipt, readSrtWinTestInput, selectSrtWinTestReceipts } from "../../__tests__/support/srt-win-build-receipts.js";
import BUILD_RECEIPTS from "../generated/srt-win-build-receipts.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { assertSrtWinDigest, assertSrtWinSpawnIntegrity, getSrtWinArchitecture, prepareSrtWinExecutable, sweepStaleSrtWinDirectories } from "../srt-win-integrity.js";

const require = createRequire(import.meta.url);
const { assertSrtWinVendor: assertVendor, readUpstreamSrtWinInput } = require("../../../scripts/lib/srt-win-integrity.cjs") as {
  assertSrtWinVendor: (path: string, arches: string[] | undefined, receipts: typeof BUILD_RECEIPTS) => void;
  readUpstreamSrtWinInput: (path: string, arch: string) => Buffer;
};
const originalVendor = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")), "vendor");
const vendor = mkdtempSync(join(tmpdir(), "ave-srt-vendor-fixture-"));
for (const arch of ["x64", "arm64"]) {
  const directory = join(vendor, "srt-win", arch);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "srt-win.exe"), readSrtWinTestInput(arch));
  writeFileSync(join(directory, "build-receipt.json"), JSON.stringify(BUILD_RECEIPTS[arch]));
}
const assertSrtWinVendor = (path: string, arches?: string[]): void => assertVendor(path, arches, BUILD_RECEIPTS);
afterAll(() => rmSync(vendor, { recursive: true, force: true }));
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
  it("selects generated receipts before adjacent receipts and verifies their bytes", () => {
    expect(selectSrtWinTestReceipts(BUILD_RECEIPTS, vendor)).toEqual(BUILD_RECEIPTS);
    expect(() => selectSrtWinTestReceipts({
      ...BUILD_RECEIPTS, x64: { ...BUILD_RECEIPTS.x64, binarySha256: "0".repeat(64) },
    }, vendor)).toThrow("Test helper receipt does not match installed bytes: x64");
  });

  it("uses validated adjacent receipts when generated entries are absent", () => {
    expect(selectSrtWinTestReceipts({}, vendor)).toEqual(BUILD_RECEIPTS);
    const path = join(vendor, "srt-win", "x64", "build-receipt.json");
    const receipt = readFileSync(path);
    try {
      writeFileSync(path, JSON.stringify({ ...BUILD_RECEIPTS.x64, nativePatchSha256: "0".repeat(64) }));
      expect(() => selectSrtWinTestReceipts({}, vendor)).toThrow("srt-win-integrity-mismatch");
      expect(selectSrtWinTestReceipts(BUILD_RECEIPTS, vendor)).toEqual(BUILD_RECEIPTS);
    } finally { writeFileSync(path, receipt); }
  });

  it("pairs missing receipts with upstream bytes and refuses changed bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-srt-upstream-test-"));
    directories.push(directory);
    for (const arch of ["x64", "arm64"]) {
      const target = join(directory, "srt-win", arch);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "srt-win.exe"), readUpstreamSrtWinInput(originalVendor, arch));
    }
    const selected = selectSrtWinTestReceipts({}, directory);
    for (const arch of ["x64", "arm64"]) {
      expect(selected[arch].binarySha256).toBe(require("../srt-win-pins.json").sha256[arch]);
    }
    writeFileSync(join(directory, "srt-win", "x64", "srt-win.exe"), "changed");
    expect(() => selectSrtWinTestReceipts({}, directory)).toThrow("Test helper receipt does not match installed bytes: x64");
  });

  it("refuses upstream bytes when the compiled receipt map is empty", async () => {
    vi.resetModules();
    vi.doMock("../generated/srt-win-build-receipts.js", () => ({ default: {} }));
    try {
      const { assertSrtWinDigest: assertUnbuiltDigest } = await import("../srt-win-integrity.js");
      for (const arch of ["x64", "arm64"]) {
        expect(() => assertUnbuiltDigest(readUpstreamSrtWinInput(originalVendor, arch), arch))
          .toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
      }
    } finally {
      vi.doMock("../generated/srt-win-build-receipts.js", () => ({ default: BUILD_RECEIPTS }));
      vi.resetModules();
    }
  });

  it.each([["ia32", "x64"], ["x64", "x64"], ["arm64", "arm64"]])("maps host architecture %s to %s", (host, expected) => {
    expect(getSrtWinArchitecture(host)).toBe(expected);
  });

  it("excludes the pinned helper from signing while preserving application signing", () => {
    const { build } = require("../../../package.json");
    expect(build.win.signExts).toEqual([
      "!srt-win.exe", "!wxc-exec.exe", "!mxc_ffi.dll", "!wslcsdk.dll", "!koffi.node",
      "!OpenConsole.exe", "!winpty-agent.exe", "!conpty.dll", "!winpty.dll",
    ]);
    expect(build.win.signExecutable).not.toBe(false);
    expect(build.win.signAndEditExecutable).not.toBe(false);
    const cache = mkdtempSync(join(tmpdir(), "ave-packager-cache-test-"));
    directories.push(cache);
    // The cache flag is boolean; its directory comes from the process temp root.
    vi.stubEnv("JITI_FS_CACHE", "true");
    for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, cache);
    // Exercise the installed packager's filter, without a signing identity.
    require("app-builder-lib");
    expect(existsSync(join(cache, "jiti"))).toBe(true);
    const { WinPackager } = require("app-builder-lib/out/winPackager.js");
    const shouldSign = (file: string) => WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: build.win }, file);
    expect(shouldSign(join("app.asar.unpacked", "vendor", "srt-win", "x64", "srt-win.exe"))).toBe(false);
    expect(shouldSign(join("app.asar.unpacked", "vendor", "srt-win", "arm64", "srt-win.exe"))).toBe(false);
    expect(shouldSign("Ave.exe")).toBe(true);
    expect(shouldSign("other-helper.exe")).toBe(true);
    expect(shouldSign("srt-win-renamed.exe")).toBe(true);
  });

  // Owner SID and image sharing checks require the native filesystem APIs.
  describe.skipIf(process.platform !== "win32")("stale private image cleanup", () => {
    function stage(layout: "single-level" | "two-level" = "two-level"): string {
      const { source } = fixture();
      const original = dirname(dirname(prepareSrtWinExecutable(source)));
      // Stage the earlier layouts outside this host's cache.
      const directory = `${original}-abandoned`;
      renameSync(original, directory);
      directories.push(directory);
      const bin = join(directory, "bin");
      if (layout === "two-level") {
        renameSync(join(directory, "owner.json"), join(bin, "owner.json"));
        return bin;
      }
      renameSync(join(bin, "srt-win.exe"), join(directory, "srt-win.exe"));
      rmdirSync(bin);
      return directory;
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
      abandon(dirname(cached));
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

  it("checks the final unpacked images after signing and fails the build on a changed image", () => {
    const directory = mkdtempSync(join(tmpdir(), "ave-srt-package-test-"));
    directories.push(directory);
    const outputVendor = join(directory, "resources", "app.asar.unpacked", "node_modules", "@anthropic-ai", "sandbox-runtime", "vendor");
    for (const arch of ["x64", "arm64"]) {
      const target = join(outputVendor, "srt-win", arch);
      mkdirSync(target, { recursive: true });
      copyFileSync(join(vendor, "srt-win", arch, "srt-win.exe"), join(target, "srt-win.exe"));
      copyFileSync(join(vendor, "srt-win", arch, "build-receipt.json"), join(target, "build-receipt.json"));
    }
    // Isolate the separate SDK boundary; the actual signing hook and helper
    // verifier still read the final unpacked images in this subprocess.
    const script = `
      import { registerHooks, createRequire } from 'node:module';
      const calls = [];
      globalThis.sdkCalls = calls;
      registerHooks({ load(url, context, nextLoad) {
        if (url.endsWith('/scripts/lib/mxc-sdk-packaging.mjs')) return {
          format: 'module', shortCircuit: true,
          source: 'export function recordMxcSupervisorRuntime(...args) { globalThis.sdkCalls.push(["record", ...args]); }'
            + 'export function assertPackagedMxcSdk(...args) { globalThis.sdkCalls.push(["verify", ...args]); }',
        };
        return nextLoad(url, context);
      }});
      const require = createRequire(import.meta.url);
      const verifier = require(process.argv[4]);
      const verify = verifier.assertSrtWinVendor;
      verifier.assertSrtWinVendor = (vendor, arches) => verify(vendor, arches, JSON.parse(process.env.AVE_TEST_SRT_RECEIPTS));
      const afterSign = require(process.argv[3]);
      try {
        await afterSign({ electronPlatformName: process.argv[2], appOutDir: process.argv[1],
          arch: 1, packager: { appInfo: { productFilename: 'Ave' } } });
        console.log(JSON.stringify(calls));
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const afterSign = (platform: string, output: string) => spawnSync(process.execPath, ["--input-type=module", "-e", script, output, platform,
      require.resolve("../../../scripts/electron-after-sign.cjs"), require.resolve("../../../scripts/lib/srt-win-integrity.cjs")], {
      cwd: resolve("."),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AVE_TEST_SRT_RECEIPTS: JSON.stringify(BUILD_RECEIPTS) }, encoding: "utf8",
    });
    const valid = afterSign("win32", directory);
    expect(valid.error).toBeUndefined();
    expect(valid.status, valid.stderr).toBe(0);
    expect(JSON.parse(valid.stdout)).toEqual([
      ["record", join(directory, "resources"), "x64", join(directory, "Ave.exe")],
      ["verify", join(directory, "resources"), "x64"],
    ]);
    const target = join(outputVendor, "srt-win", "arm64", "srt-win.exe");
    const bytes = readFileSync(target);
    bytes[0x20] ^= 1;
    writeFileSync(target, bytes);
    const changed = afterSign("win32", directory);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("srt-win-integrity-mismatch");
    const linux = afterSign("linux", "unused");
    expect(linux.status, linux.stderr).toBe(0);
    expect(JSON.parse(linux.stdout)).toEqual([]);
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
  let capturedScripts: string[] | undefined;
  async function captureScripts(): Promise<string[]> {
    if (capturedScripts) return capturedScripts;
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
    capturedScripts = scripts;
    return capturedScripts;
  }

  function runFixturePowerShell(script: string, env: NodeJS.ProcessEnv = {}): string | undefined {
    const executable = process.platform === "win32" ? win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : process.env.AVE_TEST_PWSH ?? "pwsh";
    const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
    if (executable === "pwsh" && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return undefined;
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  // Linux StartTime adds a wall-clock boot estimate sampled independently in each runtime. Use the kernel's boot-relative field 22 on both sides.
  const linuxOwnerStart = "$stat = [System.IO.File]::ReadAllText('/proc/' + $process.Id + '/stat'); $stat.Substring($stat.LastIndexOf(')') + 2).Split(' ')[19]";

  async function sweepFixture(root: string, protectedAcl = true): Promise<boolean> {
    const [sweep] = await captureScripts();
    if (!sweep) throw new Error("The helper sweep was not captured");
    const fixtureSweep = process.platform === "linux" ? sweep.replace(/\$readOwnerStart = \{[^}]+\}/, `$readOwnerStart = { param($process); ${linuxOwnerStart} }`) : sweep;
    // Use the actual decisions and filesystem. On POSIX, simulate Windows ACLs and the Windows PowerShell JSON integer type.
    const script = process.platform === "win32" ? sweep : [
      "function Get-FixtureAcl {",
      "  $acl = [pscustomobject]@{ AreAccessRulesProtected = $env:AVE_TEST_ACL -eq 'protected'; Access = @() }",
      "  Add-Member -InputObject $acl -MemberType ScriptMethod -Name GetOwner -Value { param($type) 'fixture-user' }",
      "  return $acl",
      "}",
      fixtureSweep.replace("[System.Security.Principal.WindowsIdentity]::GetCurrent().User", "'fixture-user'")
        .replace(/\[System\.IO\.Directory\]::GetAccessControl\(\$(?:directory|imageDirectory)\)/g, "Get-FixtureAcl")
        .replaceAll("\\Modules\\Microsoft.PowerShell.Utility\\", "/Modules/Microsoft.PowerShell.Utility/")
        .replace("::ReadAllText($marker) | ConvertFrom-Json;", "::ReadAllText($marker) | ConvertFrom-Json; if ($owner.pid -is [long] -and $owner.pid -le [int]::MaxValue -and $owner.pid -ge [int]::MinValue) { $owner.pid = [int]$owner.pid };"),
    ].join("\n");
    // The sweep represents a different process from the fixture's owner.
    return runFixturePowerShell(script, {
      TEMP: root, TMP: root, TMPDIR: root, AVE_SRT_TEMP_ROOT: root, AVE_SRT_OWNER_PID: "0",
      AVE_SRT_OWN_DIRECTORIES: "[]", AVE_TEST_ACL: protectedAcl ? "protected" : "inherited",
    }) !== undefined;
  }

  function createSweepDirectory(directory: string): void {
    if (process.platform !== "win32") {
      mkdirSync(directory);
      return;
    }
    runFixturePowerShell([
      "$ErrorActionPreference = 'Stop'",
      "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
      "$acl.SetOwner($sid)",
      "$acl.SetAccessRuleProtection($true, $false)",
      "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'None', 'None', 'Allow')))",
      "$null = [System.IO.Directory]::CreateDirectory($env:AVE_TEST_COPY, $acl)",
    ].join("; "), { AVE_TEST_COPY: directory });
  }

  it.for(["no marker", "empty bin without a marker", "live marker"])("keeps a paused allocation with %s", async (shape, context) => {
    const root = dirname(fixture().source);
    const copy = join(root, `ave-srt-win-${"a".repeat(32)}`);
    const marker = join(copy, "owner.json");
    const bin = join(copy, "bin");
    if (process.platform === "win32") {
      const [, allocation] = await captureScripts();
      if (!allocation) throw new Error("The helper allocation script was not captured");
      const checkpoint = shape === "no marker" ? "& $verifyDirectory $outer" :
        shape === "live marker" ? "$createdMarker = $true" : "& $verifyDirectory $bin";
      expect(allocation).toContain(checkpoint);
      runFixturePowerShell(allocation.replace(checkpoint, `${checkpoint}; return`), {
        AVE_SRT_PRIVATE_DIRECTORY: copy, AVE_SRT_OWNER_PID: String(process.pid),
      });
      if (shape === "empty bin without a marker") rmSync(marker);
    } else {
      mkdirSync(copy);
      if (shape === "empty bin without a marker") mkdirSync(bin);
      if (shape === "live marker") {
        const readStarted = process.platform === "linux" ? linuxOwnerStart : "$process.StartTime.ToUniversalTime().Ticks";
        const started = runFixturePowerShell([
          "$process = [System.Diagnostics.Process]::GetProcessById([int]$env:AVE_SRT_OWNER_PID)",
          `[Console]::WriteLine((& { ${readStarted} }))`,
        ].join("; "), {
          AVE_SRT_OWNER_PID: String(process.pid),
        });
        if (started === undefined) return context.skip("PowerShell unavailable");
        writeFileSync(marker, JSON.stringify({ pid: process.pid, started: started.trim() }));
      }
    }
    expect(existsSync(marker)).toBe(shape === "live marker");
    expect(existsSync(bin)).toBe(shape === "empty bin without a marker");
    if (!await sweepFixture(root)) return context.skip("PowerShell unavailable");
    expect(existsSync(copy)).toBe(true);
    if (shape === "live marker") {
      const owner = JSON.parse(readFileSync(marker, "utf8")) as { pid: number; started: string };
      // A different creation stamp must establish PID reuse even when the stamps are only one tick apart.
      writeFileSync(marker, JSON.stringify({ ...owner, started: (BigInt(owner.started) + 1n).toString() }));
      await sweepFixture(root);
      expect(existsSync(copy)).toBe(false);
    }
  });

  it("keeps a partial copy with an unprotected DACL", async (context) => {
    const root = join(dirname(fixture().source), "sweep");
    // The fixture parent has no inheritable rules, so enabling inheritance adds no ACEs.
    createSweepDirectory(root);
    const copy = join(root, `ave-srt-win-${"a".repeat(32)}`);
    createSweepDirectory(copy);
    const marker = join(copy, "owner.json");
    writeFileSync(marker, JSON.stringify({ pid: 2147483647, started: "1" }));
    const setProtection = (protectedAcl: boolean): string | undefined => runFixturePowerShell([
      "$ErrorActionPreference = 'Stop'",
      "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$protected = $env:AVE_TEST_PROTECTED -eq 'true'",
      "$path = $env:AVE_TEST_COPY",
      "$acl = [System.IO.Directory]::GetAccessControl($path)",
      "$acl.SetAccessRuleProtection($protected, $true)",
      "[System.IO.Directory]::SetAccessControl($path, $acl)",
      "$actual = [System.IO.Directory]::GetAccessControl($path)",
      "if ($actual.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or $actual.AreAccessRulesProtected -ne $protected) { throw 'Unexpected fixture owner or protection' }",
      "$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
      "if ($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl' -or $rules[0].InheritanceFlags -ne 'None' -or $rules[0].PropagationFlags -ne 'None' -or $rules[0].IsInherited) { throw 'Unexpected fixture access rules' }",
      "[Console]::WriteLine($actual.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]'Owner,Group'))",
    ].join("; "), { AVE_TEST_COPY: copy, AVE_TEST_PROTECTED: String(protectedAcl) });
    const windows = process.platform === "win32";
    const ownerAndGroup = windows ? setProtection(false) : undefined;
    if (!await sweepFixture(root, false)) return context.skip("PowerShell unavailable");
    expect(existsSync(marker)).toBe(true);
    if (windows) {
      expect(ownerAndGroup?.trim()).toBeTruthy();
      expect(setProtection(true)).toBe(ownerAndGroup);
    }
    await sweepFixture(root);
    expect(existsSync(copy)).toBe(false);
  });

  it.for(["a", "a".repeat(33)])("requires a generated name for a partial copy with suffix %s", async (suffix, context) => {
    const root = dirname(fixture().source);
    const copy = join(root, `ave-srt-win-${suffix}`);
    createSweepDirectory(copy);
    const marker = join(copy, "owner.json");
    writeFileSync(marker, JSON.stringify({ pid: 2147483647, started: "1" }));
    if (!await sweepFixture(root)) return context.skip("PowerShell unavailable");
    expect(existsSync(marker)).toBe(true);
    writeFileSync(join(copy, "srt-win.exe"), "image");
    await sweepFixture(root);
    expect(existsSync(copy)).toBe(false);
  });

  it.for([["a".repeat(31), "flat"], ["a".repeat(33), "nested"]] as const)(
    "requires a generated name for the marker-first layout with suffix %s and keeps %s compatibility",
    async ([suffix, legacyLayout], context) => {
      const root = dirname(fixture().source);
      const copy = join(root, `ave-srt-win-${suffix}`);
      const bin = join(copy, "bin");
      createSweepDirectory(copy);
      createSweepDirectory(bin);
      const marker = join(copy, "owner.json");
      const image = join(bin, "srt-win.exe");
      writeFileSync(marker, JSON.stringify({ pid: 2147483647, started: "1" }));
      writeFileSync(image, "image");

      if (!await sweepFixture(root)) return context.skip("PowerShell unavailable");
      expect(existsSync(marker)).toBe(true);
      expect(existsSync(image)).toBe(true);

      if (legacyLayout === "flat") {
        renameSync(image, join(copy, "srt-win.exe"));
        rmdirSync(bin);
      } else {
        renameSync(marker, join(bin, "owner.json"));
      }
      await sweepFixture(root);
      expect(existsSync(copy)).toBe(false);
    },
  );

  it("keeps a partial copy whose marker has another hard link", async (context) => {
    const root = dirname(fixture().source);
    const copy = join(root, `ave-srt-win-${"a".repeat(32)}`);
    createSweepDirectory(copy);
    const outside = join(root, "outside.json");
    const contents = JSON.stringify({ pid: 2147483647, started: "1" });
    const marker = join(copy, "owner.json");
    writeFileSync(outside, contents);
    linkSync(outside, marker);
    expect(lstatSync(marker).nlink).toBe(2);
    if (!await sweepFixture(root)) return context.skip("PowerShell unavailable");
    expect(readFileSync(marker, "utf8")).toBe(contents);
    expect(lstatSync(outside).nlink).toBe(2);

    // The same partial copy becomes eligible when its marker has just one link.
    rmSync(outside);
    await sweepFixture(root);
    expect(existsSync(copy)).toBe(false);
  });

  it.for(["owner.json", "srt-win.exe"])("keeps a complete marker-first copy with a hard-linked %s", async (entry, context) => {
    const root = dirname(fixture().source);
    const copy = join(root, `ave-srt-win-${"a".repeat(32)}`);
    const bin = join(copy, "bin");
    createSweepDirectory(copy);
    createSweepDirectory(bin);
    const marker = join(copy, "owner.json");
    const image = join(bin, "srt-win.exe");
    writeFileSync(marker, JSON.stringify({ pid: 2147483647, started: "1" }));
    writeFileSync(image, "image");
    const linked = entry === "owner.json" ? marker : image;
    const outside = join(root, "outside");
    linkSync(linked, outside);
    expect(lstatSync(linked).nlink).toBe(2);

    if (!await sweepFixture(root)) return context.skip("PowerShell unavailable");
    expect(existsSync(marker)).toBe(true);
    expect(existsSync(image)).toBe(true);
    expect(lstatSync(outside).nlink).toBe(2);

    rmSync(outside);
    await sweepFixture(root);
    expect(existsSync(copy)).toBe(false);
  });

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

  it("parses the exact copy scripts", async (context) => {
    for (const script of await captureScripts()) {
      const result = runFixturePowerShell([
        "$tokens = $null; $errors = $null",
        "$null = [System.Management.Automation.Language.Parser]::ParseInput($env:AVE_TEST_SCRIPT, [ref]$tokens, [ref]$errors)",
        "if ($errors.Count) { [Console]::Error.WriteLine(($errors -join [Environment]::NewLine)); exit 1 }",
      ].join("; "), { AVE_TEST_SCRIPT: script });
      if (result === undefined) return context.skip("PowerShell unavailable");
    }
  });

  it("reads the same creation stamp when writing and checking the marker", async () => {
    const [sweep, allocation] = await captureScripts();
    const reader = allocation?.match(/\$readOwnerStart = \{[^}]+\}/)?.[0];
    expect(reader).toBeDefined();
    expect(sweep).toContain(reader);
    expect(allocation).toContain("$started = & $readOwnerStart $owner");
    expect(sweep).toContain("[string]::Equals($owner.started, (& $readOwnerStart $p), [StringComparison]::Ordinal)");
  });

  it("creates the private copy with its final descriptor and never changes an existing object's", async () => {
    const [, script] = await captureScripts();
    if (!script) throw new Error("The helper allocation script was not captured");
    // No step sets an owner or a DACL on a path: only new descriptors get an owner.
    expect(script).not.toMatch(/SetAccessControl\(/);
    expect(script.match(/\$\w+\.SetOwner\(/g)).toEqual(["$security.SetOwner(", "$fileSecurity.SetOwner("]);
    // Anything already at the path refuses creation, before the create call.
    const refusal = script.indexOf("throw 'Private directory already exists'");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(script.indexOf("[System.IO.Directory]::CreateDirectory($outer, $security)"));
    expect(script).toContain("[System.IO.FileMode]::CreateNew");
    expect(script).toContain("$fileSecurity)");
    expect(script).toContain("$stream.GetAccessControl().GetOwner(");
    const markerWrite = script.indexOf("& $writeNewFile $markerPath");
    const binCreate = script.indexOf("::CreateDirectory($bin, $security)");
    expect(markerWrite).toBeGreaterThan(refusal);
    expect(markerWrite).toBeLessThan(binCreate);
    expect(binCreate).toBeLessThan(script.indexOf("& $writeNewFile $imagePath"));
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

  it.skipIf(process.platform !== "win32" || !hasNativeSrtWinBuildReceipt())("executes the private snapshot when the checked source is swapped before spawn", () => {
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

  describe("exit order with the sandbox runtime's release", () => {
    const exitOrderChild = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/srt-win-exit-order-child.ts");
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    function runChild(mode: "runtime-pending" | "runtime-reset" | "no-runtime", lockedEntry?: string): {
      executable: string; presentAtRuntimeRelease?: boolean; lockAttempts?: number; stderr: string;
    } {
      const { source } = fixture();
      const temp = dirname(source);
      const resultPath = join(temp, "result.json");
      const child = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, ["--import=tsx", exitOrderChild, source, resultPath, mode, ...(lockedEntry ? [lockedEntry] : [])], {
        cwd: repoRoot, env: tsxChildEnv({ TEMP: temp, TMP: temp, TMPDIR: temp, AVE_TEST_SRT_RECEIPTS: JSON.stringify(BUILD_RECEIPTS) }),
        encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as { executable: string; presentAtRuntimeRelease?: boolean; lockAttempts?: number };
      return { ...result, stderr: child.stderr };
    }

    it.for(["image", "bin", "marker", "outer"])("sweeps exit remnants with a dead owner's marker after EPERM on %s", async (entry, context) => {
      const { executable, lockAttempts } = runChild("no-runtime", entry);
      const bin = dirname(executable);
      const copy = dirname(bin);
      expect(lockAttempts).toBe(1);
      expect(existsSync(copy)).toBe(true);
      expect(existsSync(executable)).toBe(entry === "image");
      expect(existsSync(bin)).toBe(entry === "image" || entry === "bin");
      expect(existsSync(join(copy, "owner.json"))).toBe(entry !== "outer");
      if (!await sweepFixture(dirname(copy))) return context.skip("PowerShell unavailable");
      expect(existsSync(copy)).toBe(entry === "outer");
    });

    it("keeps the private copy for a runtime release still pending at exit, which runs after this module's handler", () => {
      const { executable, presentAtRuntimeRelease, stderr } = runChild("runtime-pending");
      expect(presentAtRuntimeRelease).toBe(true);
      // Written synchronously: the file log is closed by the time 'exit' handlers run.
      expect(stderr).toContain("ave: srt-win: sandbox session was not released before exit");
      // Left for the next boot's stale-copy sweep.
      expect(existsSync(executable)).toBe(true);
    });

    it("removes the private copy at exit once the quit sequence has reset the runtime", () => {
      const { executable, stderr } = runChild("runtime-reset");
      expect(existsSync(dirname(dirname(executable)))).toBe(false);
      expect(stderr).not.toContain("srt-win: sandbox session");
    });

    it("removes the private copy at exit when no runtime was initialized", () => {
      expect(existsSync(dirname(dirname(runChild("no-runtime").executable)))).toBe(false);
    });
  });
});
