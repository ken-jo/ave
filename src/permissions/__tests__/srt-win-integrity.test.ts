import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { assertSrtWinDigest, assertSrtWinSpawnIntegrity, prepareSrtWinExecutable } from "../srt-win-integrity.js";

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
  copyFileSync(join(vendor, "srt-win", process.arch, "srt-win.exe"), source);
  return { source, bytes: readFileSync(source) };
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Windows helper integrity", () => {
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
    directories.push(dirname(executable));
    const script = [
      "$ErrorActionPreference='Stop'",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl=[System.IO.Directory]::GetAccessControl($env:AVE_SRT_PRIVATE_DIRECTORY)",
      "if (!$acl.AreAccessRulesProtected) { throw 'Inherited grants' }",
      "$readers=@('S-1-5-18','S-1-5-32-544','S-1-5-32-545')",
      "$rx=[System.Security.AccessControl.FileSystemRights]::ReadAndExecute",
      "$full=[System.Security.AccessControl.FileSystemRights]::FullControl",
      "$modify=[System.Security.AccessControl.FileSystemRights]'Write,Delete,DeleteSubdirectoriesAndFiles,ChangePermissions,TakeOwnership'",
      "foreach ($target in @($env:AVE_SRT_PRIVATE_DIRECTORY, (Join-Path $env:AVE_SRT_PRIVATE_DIRECTORY 'srt-win.exe'))) {",
      "$acl=Get-Acl -LiteralPath $target",
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
      "Write-Output 'private-image-protected'",
    ].join("; ");
    const output = execFileSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
      "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], {
      env: { SystemRoot: process.env.SystemRoot, AVE_SRT_PRIVATE_DIRECTORY: dirname(executable) },
      windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs, stdio: "pipe",
    });
    expect(output.trim()).toBe("private-image-protected");
  });

  it("revalidates a cached image and the source instead of trusting a previous check", () => {
    const { source, bytes } = fixture();
    const executable = prepareSrtWinExecutable(source);
    directories.push(dirname(executable));
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
    directories.push(dirname(executable));
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
