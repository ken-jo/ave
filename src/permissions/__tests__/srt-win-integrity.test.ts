import { tsxChildEnv } from "../../__tests__/support/tsx-child-env.js";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { hasNativeSrtWinBuildReceipt, readSrtWinTestInput, selectSrtWinTestReceipts } from "../../__tests__/support/srt-win-build-receipts.js";
import BUILD_RECEIPTS from "../generated/srt-win-build-receipts.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { retireSrtWinAllocation, srtWinAllocations } from "../srt-win-allocation-ledger.js";
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

function recordMockCreation(journal: string, claim: string, path: string): void {
  const stat = lstatSync(path, { bigint: true });
  appendFileSync(journal, `${claim} ${stat.dev}:${stat.ino}:${stat.birthtimeNs}\n`);
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Windows helper integrity", () => {
  it("retains an exact-format tombstone without an allocation record", () => {
    const { source } = fixture();
    const root = dirname(source);
    for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, root);
    const tombstone = join(root, `ave-srt-win-${"a".repeat(32)}.delete-${"b".repeat(32)}`);
    mkdirSync(tombstone, { mode: 0o700 });
    const sentinel = join(tombstone, "keep");
    writeFileSync(sentinel, "unowned");

    sweepStaleSrtWinDirectories();
    expect(existsSync(sentinel)).toBe(true);
  });

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

    it.each(["single-level", "two-level"] as const)("retains an unrecorded legacy %s copy even with a stale marker", (layout) => {
      isolateTemp();
      const directory = stage(layout);
      abandon(directory);
      const outer = layout === "two-level" ? dirname(directory) : directory;
      sweepStaleSrtWinDirectories();
      expect(existsSync(outer)).toBe(true);
    });

    it("neither claims an unrecorded image nor trusts a changed marker over a live allocation", () => {
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
      expect(existsSync(stale)).toBe(true);
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

    it("retains exact-format unrecorded tombstones with the same protected descriptors as owned copies", () => {
      isolateTemp();
      const bin = stage();
      const original = dirname(bin);
      const stem = basename(original).replace(/-abandoned$/, "");
      const tombstone = join(tmpdir(), `${stem}.delete-${"a".repeat(32)}`);
      const lookalike = join(tmpdir(), `${stem}.delete-${"b".repeat(32)}`);
      const target = join(tmpdir(), "outside-tombstone");
      mkdirSync(target);
      writeFileSync(join(target, "sentinel"), "keep");
      rmSync(join(bin, "owner.json"));
      mkdirSync(join(bin, "extra"));
      symlinkSync(target, join(bin, "extra", "alias"), "junction");
      renameSync(original, tombstone);
      const unrelated = stage();
      rmSync(join(unrelated, "owner.json"));
      renameSync(dirname(unrelated), lookalike);

      sweepStaleSrtWinDirectories();
      expect(existsSync(tombstone)).toBe(true);
      expect(existsSync(lookalike)).toBe(true);
      expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("keep");
      rmdirSync(join(tombstone, "bin", "extra", "alias"));
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

    it("reclaims a recorded tombstone after a native image handle closes", async () => {
      isolateTemp();
      const { source } = fixture();
      const executable = prepareSrtWinExecutable(source);
      const original = dirname(dirname(executable));
      const record = srtWinAllocations().find((allocation) => allocation.path === original);
      assert(record);
      retireSrtWinAllocation(record);
      renameSync(original, record.retired);
      const image = join(record.retired, "bin", "srt-win.exe");
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$handle = [System.IO.File]::Open($env:AVE_SRT_TEST_IMAGE, 'Open', 'Read', 'Read')",
        "[Console]::Out.WriteLine('ready')",
        "try { [Console]::ReadLine() | Out-Null } finally { $handle.Dispose() }",
      ].join("; ");
      const child = spawn(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ], {
        env: { SystemRoot: process.env.SystemRoot, AVE_SRT_TEST_IMAGE: image },
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"], timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      const exited = once(child, "exit");
      try {
        const [output] = await once(child.stdout, "data");
        expect(String(output).trim()).toBe("ready");
        sweepStaleSrtWinDirectories();
        expect(existsSync(image)).toBe(true);
        expect(existsSync(record.record)).toBe(true);
      } finally {
        child.stdin.end("\n");
        await exited;
      }
      sweepStaleSrtWinDirectories();
      expect(existsSync(record.retired)).toBe(false);
      expect(existsSync(record.record)).toBe(false);
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
  async function captureScripts(): Promise<string[]> {
    const scripts: string[] = [];
    let hostType = "Windows_NT";
    vi.resetModules();
    vi.doMock("node:os", async (importOriginal) => ({ ...await importOriginal<typeof import("node:os")>(), type: () => hostType }));
    vi.doMock("node:child_process", async (importOriginal) => ({
      ...await importOriginal<typeof import("node:child_process")>(),
      execFileSync: (_command: string, _args: readonly string[], options: { input: string; env: Record<string, string> }) => {
        scripts.push(options.input);
        // Stand in for the private-directory step, which creates the directory and the empty image itself: nothing may exist at its path before.
        const directory = options.env.AVE_SRT_PRIVATE_DIRECTORY;
        if (directory) {
          const journal = options.env.AVE_SRT_ALLOCATION_RECORD;
          assert(journal);
          expect(existsSync(directory)).toBe(false);
          mkdirSync(directory, { mode: 0o700 });
          recordMockCreation(journal, "outer", directory);
          const bin = join(directory, "bin");
          mkdirSync(bin, { mode: 0o700 });
          recordMockCreation(journal, "bin", bin);
          for (const [claim, name] of [["image", "srt-win.exe"], ["marker", "owner.json"]] as const) {
            const path = join(bin, name);
            writeFileSync(path, "");
            recordMockCreation(journal, claim, path);
          }
          hostType = "Darwin";
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
      "Add-Type": "Utility", "New-Object": "Utility", "ConvertTo-Json": "Utility", "ConvertFrom-Json": "Utility",
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
    assert(script);
    // No step sets an owner or a DACL on a path: only new descriptors get an owner.
    expect(script).not.toMatch(/SetAccessControl\(/);
    expect(script.match(/\$\w+\.SetOwner\(/g)).toEqual(["$security.SetOwner(", "$fileSecurity.SetOwner("]);
    // Anything already at the path refuses creation, before the create call.
    const refusal = script.indexOf("throw 'Private directory already exists'");
    expect(refusal).toBeGreaterThan(-1);
    const create = script.indexOf("[PrivateDirectory]::Create($outer, $descriptor)");
    expect(create).toBeGreaterThan(refusal);
    expect(script).toContain("if (!CreateDirectoryW(ExtendedPath(path), ref attributes)) throw new Win32Exception");
    const receipt = script.indexOf("[PrivateDirectory]::Record($env:AVE_SRT_ALLOCATION_RECORD, 'outer', $outerHandle)");
    expect(receipt).toBeGreaterThan(create);
    expect(receipt).toBeLessThan(script.indexOf("[PrivateDirectory]::Create($bin, $descriptor)"));
    expect(script).toContain("[System.IO.FileMode]::CreateNew");
    expect(script).toContain("$fileSecurity)");
    expect(script).toContain("$stream.GetAccessControl().GetOwner(");
  });

  // Run the captured step against a path that already holds something: it must refuse, and leave that object's owner and DACL exactly as they were.
  it.runIf(process.platform === "win32").for(["Administrators-owned directory", "SYSTEM-owned directory", "junction"])(
    "refuses a private path that is already a %s and changes nothing",
    async (kind, context) => {
      const [, script] = await captureScripts();
      assert(script);
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
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "& ([ScriptBlock]::Create([Console]::In.ReadToEnd()))",
        ], {
          env: { SystemRoot: process.env.SystemRoot, AVE_SRT_OWNER_PID: String(process.pid), AVE_SRT_PRIVATE_DIRECTORY: path },
          input: script, windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
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

  it.each(["srt-win.exe", "owner.json", "bin"])("recovers the private copy after exit hits a lock on %s", async (leaf) => {
    const { source } = fixture();
    const root = join(dirname(source), "copies");
    mkdirSync(root);
    const earlierExitHandlers = new Set(process.listeners("exit"));
    const lock = Object.assign(new Error("Entry is locked"), { code: "EPERM" });
    const failures: string[] = [];
    const failOnce = (entry: unknown) => {
      if (failures.length === 0 && basename(String(entry)) === leaf) {
        failures.push(String(entry));
        throw lock;
      }
    };
    vi.resetModules();
    vi.doMock("node:os", async (original) => ({
      ...await original<typeof import("node:os")>(), type: () => "Darwin", tmpdir: () => root,
    }));
    vi.doMock("node:fs", async (original) => {
      const fs = await original<typeof import("node:fs")>();
      return {
        ...fs,
        rmSync: (...args: Parameters<typeof fs.rmSync>) => { failOnce(args[0]); fs.rmSync(...args); },
        rmdirSync: (...args: Parameters<typeof fs.rmdirSync>) => { failOnce(args[0]); fs.rmdirSync(...args); },
      };
    });
    try {
      const integrity = await import("../srt-win-integrity.js");
      const handlers = process.listeners("exit").filter((handler) => !earlierExitHandlers.has(handler));
      expect(handlers).toHaveLength(1);
      const [onExit] = handlers;
      assert(onExit);
      process.removeListener("exit", onExit);
      const executable = integrity.prepareSrtWinExecutable(source);
      writeFileSync(join(dirname(executable), "owner.json"), JSON.stringify({ pid: 2147483647, started: "1" }));

      onExit(0);
      expect(failures).toHaveLength(1);
      const interrupted = readdirSync(root);
      expect(interrupted).toHaveLength(1);
      integrity.sweepStaleSrtWinDirectories();
      expect(readdirSync(root)).toEqual([]);
      expect(interrupted[0]).toMatch(/^ave-srt-win-[a-f0-9]{32}\.delete-[a-f0-9]{32}$/);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });

  it("removes an incomplete copy at exit if its immediate rollback fails", async () => {
    const { source } = fixture();
    const earlierExitHandlers = new Set(process.listeners("exit"));
    const writeError = new Error("Image write failed");
    const retire = vi.fn(renameSync).mockImplementationOnce(() => { throw new Error("Directory was busy"); });
    const write = vi.fn<typeof writeFileSync>().mockImplementation(() => { throw writeError; });
    vi.resetModules();
    vi.doMock("node:os", async (original) => ({
      ...await original<typeof import("node:os")>(), type: () => "Darwin", tmpdir: () => dirname(source),
    }));
    vi.doMock("node:fs", async (original) => ({
      ...await original<typeof import("node:fs")>(), writeFileSync: write, renameSync: retire,
    }));
    try {
      const integrity = await import("../srt-win-integrity.js");
      const exitHandlers = process.listeners("exit").filter((handler) => !earlierExitHandlers.has(handler));
      expect(exitHandlers).toHaveLength(1);
      const [onExit] = exitHandlers;
      assert(onExit);
      process.removeListener("exit", onExit);

      expect(() => integrity.prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ cause: writeError }));
      expect(retire).toHaveBeenCalledTimes(1);
      const executable = write.mock.calls[0]?.[0];
      assert(typeof executable === "string");
      const directory = dirname(dirname(executable));
      expect(existsSync(directory)).toBe(true);
      onExit(0);
      expect(existsSync(directory)).toBe(false);
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });

  it("recovers a partial allocation after rollback and exit both fail to retire it", async () => {
    const { source } = fixture();
    const root = join(dirname(source), "copies");
    mkdirSync(root);
    const earlierExitHandlers = new Set(process.listeners("exit"));
    const creationFailure = new Error("Bin creation failed");
    const retire = vi.fn(renameSync).mockImplementation(() => {
      throw Object.assign(new Error("Directory is locked"), { code: "EPERM" });
    });
    vi.resetModules();
    vi.doMock("node:os", async (original) => ({
      ...await original<typeof import("node:os")>(), type: () => "Darwin", tmpdir: () => root,
    }));
    vi.doMock("node:fs", async (original) => {
      const fs = await original<typeof import("node:fs")>();
      const mkdir: typeof mkdirSync = (path, options) => {
        if (basename(String(path)) === "bin") throw creationFailure;
        return fs.mkdirSync(path, options);
      };
      return { ...fs, mkdirSync: mkdir, renameSync: retire };
    });
    try {
      const integrity = await import("../srt-win-integrity.js");
      const [onExit] = process.listeners("exit").filter((handler) => !earlierExitHandlers.has(handler));
      assert(onExit);
      process.removeListener("exit", onExit);

      expect(() => integrity.prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ cause: creationFailure }));
      expect(retire).toHaveBeenCalledTimes(1);
      onExit(0);
      expect(retire).toHaveBeenCalledTimes(2);
      const [name] = readdirSync(root);
      assert(name);
      expect(name).toMatch(/^ave-srt-win-[a-f0-9]{32}$/);
      expect(readdirSync(join(root, name))).toEqual([]);

      // The new module only has the journal, and rename remains unavailable.
      vi.resetModules();
      const restarted = await import("../srt-win-integrity.js");
      restarted.sweepStaleSrtWinDirectories();
      expect(readdirSync(root)).toEqual([]);
      expect(srtWinAllocations().some((allocation) => allocation.path === join(root, name))).toBe(false);
      expect(retire).toHaveBeenCalledTimes(2);
    } finally {
      for (const handler of process.listeners("exit")) {
        if (!earlierExitHandlers.has(handler)) process.removeListener("exit", handler);
      }
      vi.doUnmock("node:fs");
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });

  it.each(["EPERM", "ETIMEDOUT", "EEXIST"])("handles protected provisioning failure %s without claiming an unconfirmed directory", async (code) => {
    const { source } = fixture();
    const root = join(dirname(source), "copies");
    mkdirSync(root);
    const confirmed = code !== "EEXIST";
    const error = Object.assign(new Error(`Provisioning failed: ${code}`), { code });
    let allocated: string | undefined;
    let hostType = "Windows_NT";
    const retire = vi.fn(renameSync);
    vi.stubEnv("SystemRoot", process.env.SystemRoot ?? "C:\\Windows");
    vi.resetModules();
    vi.doMock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), renameSync: retire }));
    vi.doMock("node:os", async (original) => ({
      ...await original<typeof import("node:os")>(), type: () => hostType, tmpdir: () => root,
    }));
    vi.doMock("node:child_process", async (original) => ({
      ...await original<typeof import("node:child_process")>(),
      execFileSync: (_: string, _args: string[], options: { env: Record<string, string> }) => {
        allocated = options.env.AVE_SRT_PRIVATE_DIRECTORY;
        if (!allocated) return Buffer.alloc(0);
        const journal = options.env.AVE_SRT_ALLOCATION_RECORD;
        assert(journal);
        mkdirSync(allocated, { mode: 0o700 });
        if (confirmed) recordMockCreation(journal, "outer", allocated);
        if (code === "EPERM") {
          const bin = join(allocated, "bin");
          mkdirSync(bin, { mode: 0o700 });
          recordMockCreation(journal, "bin", bin);
          const marker = join(bin, "owner.json");
          writeFileSync(marker, "partial marker");
          recordMockCreation(journal, "marker", marker);
        }
        if (!confirmed) writeFileSync(join(allocated, "sentinel"), "keep");
        hostType = "Darwin";
        throw error;
      },
    }));
    try {
      const integrity = await import("../srt-win-integrity.js");
      expect(() => integrity.prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ cause: error }));
      assert(allocated);
      if (confirmed) {
        expect(readdirSync(root)).toEqual([]);
        expect(retire).toHaveBeenCalledExactlyOnceWith(allocated, expect.stringMatching(/\.delete-[a-f0-9]{32}$/));
      } else {
        expect(retire).not.toHaveBeenCalled();
        expect(readFileSync(join(allocated, "sentinel"), "utf8")).toBe("keep");
      }
    } finally {
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:fs");
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });

  it.each(["directory", "link"])("preserves a pre-existing bin %s after the outer creation receipt", async (kind) => {
    const { source } = fixture();
    const root = join(dirname(source), "copies");
    const target = join(dirname(source), "outside");
    mkdirSync(root);
    mkdirSync(target);
    let allocated: string | undefined;
    let hostType = "Windows_NT";
    const collision = Object.assign(new Error("Second exclusive create failed"), { code: "EEXIST" });
    vi.stubEnv("SystemRoot", process.env.SystemRoot ?? "C:\\Windows");
    vi.resetModules();
    vi.doMock("node:os", async (original) => ({
      ...await original<typeof import("node:os")>(), type: () => hostType, tmpdir: () => root,
    }));
    vi.doMock("node:child_process", async (original) => ({
      ...await original<typeof import("node:child_process")>(),
      execFileSync: (_: string, _args: string[], options: { env: Record<string, string> }) => {
        allocated = options.env.AVE_SRT_PRIVATE_DIRECTORY;
        if (!allocated) return Buffer.alloc(0);
        mkdirSync(allocated, { mode: 0o700 });
        const journal = options.env.AVE_SRT_ALLOCATION_RECORD;
        assert(journal);
        recordMockCreation(journal, "outer", allocated);
        const bin = join(allocated, "bin");
        if (kind === "link") symlinkSync(target, bin, "junction");
        else mkdirSync(bin);
        const contents = kind === "link" ? target : bin;
        writeFileSync(join(contents, "srt-win.exe"), "foreign image");
        writeFileSync(join(contents, "owner.json"), "foreign marker");
        hostType = "Darwin";
        throw collision;
      },
    }));
    try {
      const integrity = await import("../srt-win-integrity.js");
      expect(() => integrity.prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ cause: collision }));
      assert(allocated);
      const bin = join(allocated, "bin");
      expect(lstatSync(bin, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(kind === "link");
      integrity.sweepStaleSrtWinDirectories();
      expect(readFileSync(join(bin, "srt-win.exe"), "utf8")).toBe("foreign image");
      expect(readFileSync(join(bin, "owner.json"), "utf8")).toBe("foreign marker");
    } finally {
      if (kind === "link" && allocated !== undefined) {
        const bin = join(allocated, "bin");
        if (lstatSync(bin, { throwIfNoEntry: false })?.isSymbolicLink()) {
          if (process.platform === "win32") rmdirSync(bin); else rmSync(bin);
        }
      }
      vi.doUnmock("node:child_process");
      vi.doUnmock("node:os");
      vi.resetModules();
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
    function runChild(mode: "runtime-pending" | "runtime-reset" | "no-runtime"): { executable: string; presentAtRuntimeRelease?: boolean; stderr: string } {
      const { source } = fixture();
      const resultPath = join(dirname(source), "result.json");
      const child = spawnSync(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath, ["--import=tsx", exitOrderChild, source, resultPath, mode], {
        cwd: repoRoot, env: tsxChildEnv({ AVE_TEST_SRT_RECEIPTS: JSON.stringify(BUILD_RECEIPTS) }), encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as { executable: string; presentAtRuntimeRelease?: boolean };
      directories.push(dirname(dirname(result.executable)));
      return { ...result, stderr: child.stderr };
    }

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
