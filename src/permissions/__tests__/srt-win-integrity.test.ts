import { tsxChildEnv } from "../../__tests__/support/tsx-child-env.js";
import { randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const windowsPowerShell = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

function nativePowerShell(script: string, env: NodeJS.ProcessEnv): string {
  return execFileSync(windowsPowerShell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64"),
  ], { env: { ...process.env, ...env }, windowsHide: true, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs, stdio: "pipe" });
}

function useTemp(root: string): void {
  for (const name of ["TEMP", "TMP", "TMPDIR"]) vi.stubEnv(name, root);
}
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
  it.skipIf(process.platform === "win32").each(["loose", "linked"])(
    "refuses a %s private parent without changing its contents",
    (kind) => {
      const { source } = fixture();
      const temp = dirname(source);
      useTemp(temp);
      const parent = join(temp, `ave-srt-win.${process.geteuid!()}`);
      const target = kind === "loose" ? parent : join(temp, "unrelated");
      mkdirSync(target);
      if (kind === "loose") chmodSync(parent, 0o777);
      else symlinkSync(target, parent, "dir");
      const sentinel = join(target, "keep");
      writeFileSync(sentinel, "original");
      const before = lstatSync(parent);

      sweepStaleSrtWinDirectories();
      expect(() => prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
      expect(lstatSync(parent)).toMatchObject({ mode: before.mode, ino: before.ino });
      expect(readFileSync(sentinel, "utf8")).toBe("original");
      expect(readdirSync(target)).toEqual(["keep"]);
    },
  );

  it.skipIf(process.platform !== "darwin").each(["parent", "temp ancestor"])(
    "refuses a macOS %s with an extended access grant",
    (kind) => {
      const { source } = fixture();
      const temp = dirname(source);
      useTemp(temp);
      const parent = join(temp, `ave-srt-win.${process.geteuid!()}`);
      mkdirSync(parent, { mode: 0o700 });
      const sentinel = join(parent, "keep");
      writeFileSync(sentinel, "original");
      const target = kind === "parent" ? parent : temp;
      const mode = lstatSync(target).mode;
      execFileSync("/bin/chmod", ["+a", "everyone allow search,add_file,delete_child", target]);
      const describeAcl = () => execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8" });
      try {
        expect(lstatSync(target).mode).toBe(mode);
        const before = describeAcl();
        expect(before).toMatch(/ allow .*delete_child/);
        sweepStaleSrtWinDirectories();
        expect(existsSync(sentinel)).toBe(true);
        expect(readFileSync(sentinel, "utf8")).toBe("original");
        expect(() => prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
        expect(describeAcl()).toBe(before);
        expect(readdirSync(parent)).toEqual(["keep"]);
      } finally {
        execFileSync("/bin/chmod", ["-N", target]);
      }
    },
  );

  it.skipIf(process.platform !== "darwin")("strips inherited ACLs from a newly created macOS parent", () => {
    const { source } = fixture();
    const temp = dirname(source);
    useTemp(temp);
    const parent = join(temp, `ave-srt-win.${process.geteuid!()}`);
    const probe = join(temp, "inheritance-probe");
    execFileSync("/bin/chmod", ["+a", "everyone deny delete,file_inherit,directory_inherit", temp]);
    try {
      mkdirSync(probe, { mode: 0o700 });
      expect(execFileSync("/bin/ls", ["-lde", probe], { encoding: "utf8" })).toMatch(/ inherited deny delete/);
      expect(existsSync(prepareSrtWinExecutable(source))).toBe(true);
      expect(execFileSync("/bin/ls", ["-lde", parent], { encoding: "utf8" })).not.toMatch(/^ \d+:/m);
      expect(execFileSync("/bin/ls", ["-lde", temp], { encoding: "utf8" })).toMatch(/ deny delete/);
    } finally {
      execFileSync("/bin/chmod", ["-RN", temp]);
    }
  });

  it.skipIf(process.platform === "win32")("preserves a pre-existing empty allocation destination", async () => {
    const { source } = fixture();
    const temp = dirname(source);
    useTemp(temp);
    const parent = join(temp, `ave-srt-win.${process.geteuid!()}`);
    mkdirSync(parent, { mode: 0o700 });
    const destination = join(parent, `copy-${process.pid}-${"a".repeat(32)}`);
    mkdirSync(destination);
    const inode = lstatSync(destination).ino;
    vi.resetModules();
    vi.doMock("node:crypto", async (load) => ({ ...await load<typeof import("node:crypto")>(), randomBytes: () => Buffer.alloc(16, 0xaa) }));
    try {
      const { prepareSrtWinExecutable: prepare } = await import("../srt-win-integrity.js");
      expect(() => prepare(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
      expect(lstatSync(destination).ino).toBe(inode);
      expect(readdirSync(destination)).toEqual([]);
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });

  it.skipIf(process.platform === "win32")("sweeps partial entries under a verified parent and keeps a live copy", () => {
    const { source } = fixture();
    const temp = dirname(source);
    useTemp(temp);
    const executable = prepareSrtWinExecutable(source);
    const parent = join(temp, `ave-srt-win.${process.geteuid!()}`);
    mkdirSync(parent, { mode: 0o700, recursive: true });
    const partial = join(parent, "interrupted-copy");
    mkdirSync(partial);
    writeFileSync(join(partial, "incomplete"), "partial data");

    sweepStaleSrtWinDirectories();
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(executable)).toBe(true);
  });

  it("parses the generated PowerShell and checks the exact parent ACL and independent sweeps", async (context) => {
    const programs: string[] = [];
    vi.resetModules();
    vi.doMock("node:child_process", async (load) => ({
      ...await load<typeof import("node:child_process")>(),
      execFileSync: (_path: string, args: readonly string[], options: { input: string }) => {
        programs.push(Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le"));
        programs.push(options.input.split("\n").slice(1).join("\n"));
        return "";
      },
    }));
    vi.stubEnv("SystemRoot", process.env.SystemRoot ?? "C:\\Windows");
    try {
      const { runWindowsSrtWinParent } = await import("../srt-win-private-parent.js");
      for (const action of ["allocate", "verify", "dispose", "sweep"] as const) {
        runWindowsSrtWinParent(action, "C:\\Owner's TEMP", { bytes: Buffer.from("image") });
      }
    } finally {
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
    expect(programs).toHaveLength(8);
    expect(programs.join("\n")).not.toContain("Owner's TEMP");
    expect(programs.join("\n")).not.toMatch(/\b(?:Add-Type|csc(?:\.exe)?)\b/i);
    const parserTemp = mkdtempSync(join(tmpdir(), "ave-srt-parser-"));
    directories.push(parserTemp);
    const parser = process.platform === "win32" ? windowsPowerShell : process.env.AVE_TEST_PWSH ?? "pwsh";
    const result = spawnSync(parser, [
      "-NoProfile", "-NonInteractive", "-Command", [
        "$programs = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())",
        "foreach ($program in $programs) {",
        "  $errors = $null; $null = [System.Management.Automation.Language.Parser]::ParseInput($program, [ref]$null, [ref]$errors)",
        "  if ($errors.Count) { [Console]::Error.WriteLine(($errors -join [Environment]::NewLine)); exit 1 }",
        "}",
        "$program = [System.Management.Automation.Language.Parser]::ParseInput($programs[1], [ref]$null, [ref]$null)",
        "$definition = $program.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PrivateParentSddl' }, $false)",
        "if (!$definition) { throw 'Expected the parent descriptor function in the generated program' }",
        "Invoke-Expression $definition.Extent.Text",
        "[Console]::WriteLine((Get-PrivateParentSddl 'S-1-5-21-1-2-3-1001'))",
        "[Console]::WriteLine((Get-PrivateParentSddl 'S-1-5-18'))",
        "$ancestorCheck = $program.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-TempAncestor' }, $false)",
        "Invoke-Expression $ancestorCheck.Extent.Text",
        "$ace = [pscustomobject]@{ AceType = 'AccessAllowed'; AceFlags = 0; SecurityIdentifier = @{ Value = 'S-1-5-32-545' }; AccessMask = 4 }",
        "$ancestor = [pscustomobject]@{ Owner = @{ Value = 'S-1-5-18' }; DiscretionaryAcl = @($ace) }",
        "Assert-TempAncestor $ancestor 'S-1-5-21-1-2-3-1001'",
        "try { Assert-TempAncestor $ancestor 'S-1-5-21-1-2-3-1001' $true; [Console]::WriteLine('allowed planting') } catch { [Console]::WriteLine($_.Exception.Message) }",
        "$ace.AccessMask = 0x40",
        "try { Assert-TempAncestor $ancestor 'S-1-5-21-1-2-3-1001'; [Console]::WriteLine('allowed replacement') } catch { [Console]::WriteLine($_.Exception.Message) }",
        "$sweep = [System.Management.Automation.Language.Parser]::ParseInput($programs[7], [ref]$null, [ref]$null)",
        "$legacy = $sweep.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-LegacySweep' }, $false)",
        "if (!$legacy) { throw 'Expected an independent legacy sweep in the generated program' }",
        "$dispatch = [ScriptBlock]::Create($programs[7].Substring($legacy.Extent.EndOffset))",
        "function Invoke-LegacySweep { [Console]::WriteLine('legacy sweep'); [Console]::WriteLine('temp-root diagnostic') }",
        "function Invoke-PrivateParent { throw 'Private parent refused' }",
        "& $dispatch",
        "function Invoke-LegacySweep { throw 'Legacy sweep refused' }",
        "function Invoke-PrivateParent { [Console]::WriteLine('private sweep') }",
        "& $dispatch",
      ].join("\n"),
    ], {
      env: { ...process.env, TEMP: parserTemp, TMP: parserTemp, TMPDIR: parserTemp },
      input: JSON.stringify(programs), encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
    if (parser === "pwsh" && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return context.skip("PowerShell parser unavailable");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      "O:S-1-5-21-1-2-3-1001D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1001)(A;;0x20;;;S-1-5-18)(A;;0x20;;;S-1-5-32-544)(A;;0x20;;;S-1-5-32-545)",
      "O:S-1-5-18D:P(A;OICI;FA;;;S-1-5-18)(A;;0x20;;;S-1-5-32-544)(A;;0x20;;;S-1-5-32-545)",
      "Temporary ancestor grants replacement rights",
      "Temporary ancestor grants replacement rights",
      "legacy sweep", "temp-root diagnostic", "private sweep",
    ]);
  });

  it("keeps a legacy tombstone without the two-file shape", () => {
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
  describe.skipIf(process.platform !== "win32")("legacy image migration", () => {
    function stage(layout: "single-level" | "two-level" = "two-level"): string {
      const directory = join(tmpdir(), `ave-srt-win-${randomBytes(16).toString("hex")}`);
      const target = layout === "two-level" ? join(directory, "bin") : directory;
      nativePowerShell([
        "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
        "$acl = [System.Security.AccessControl.DirectorySecurity]::new()",
        "$acl.SetOwner($sid)",
        "$acl.SetAccessRuleProtection($true, $false)",
        "$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))",
        "$null = [System.IO.Directory]::CreateDirectory($env:AVE_TEST_OUTER, $acl)",
        "if ($env:AVE_TEST_IMAGE_DIR -ne $env:AVE_TEST_OUTER) { $null = [System.IO.Directory]::CreateDirectory($env:AVE_TEST_IMAGE_DIR, $acl) }",
      ].join("\n"), { AVE_TEST_OUTER: directory, AVE_TEST_IMAGE_DIR: target });
      writeFileSync(join(target, "srt-win.exe"), "legacy image");
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

    it("reclaims an eligible legacy copy when the private parent is refused", () => {
      isolateTemp();
      const directory = stage();
      abandon(directory);
      const sid = nativePowerShell("[Console]::WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)", {}).trim();
      const parent = join(tmpdir(), `ave-srt-win.${sid}`);
      // Ordinary mkdir inherits a DACL that the private-parent verifier refuses.
      mkdirSync(parent);
      const sentinel = join(parent, "keep");
      writeFileSync(sentinel, "original");
      const describeAcl = () => nativePowerShell("[Console]::WriteLine([System.IO.Directory]::GetAccessControl($env:AVE_TEST_PARENT).GetSecurityDescriptorSddlForm('Owner, Access'))", { AVE_TEST_PARENT: parent });
      const before = describeAcl();

      sweepStaleSrtWinDirectories();
      expect(existsSync(dirname(directory))).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("original");
      expect(describeAcl()).toBe(before);
    });

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
      writeFileSync(join(current, "owner.json"), JSON.stringify({ pid: process.pid, started: "1" }));
      sweepStaleSrtWinDirectories();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(current)).toBe(true);
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
        "try { [System.IO.Directory]::CreateDirectory($env:AVE_TEST_TARGET, $acl) | Out-Null } catch [System.UnauthorizedAccessException], [System.Security.AccessControl.PrivilegeNotHeldException] { exit 3 } catch [System.IO.IOException] { if (($_.Exception.HResult -band 0xffff) -eq 1307) { exit 3 }; throw }",
        "if ([System.IO.Directory]::GetAccessControl($env:AVE_TEST_TARGET).GetOwner([System.Security.Principal.SecurityIdentifier]) -eq $sid) { throw 'Foreign directory fixture retained the current owner' }",
      ].join("; ");
      const result = spawnSync(win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
        "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
      ], { env: { ...process.env, AVE_TEST_TARGET: directory }, windowsHide: true, encoding: "utf8" });
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
      "$parent=[System.IO.Path]::GetDirectoryName([System.IO.Path]::GetDirectoryName($env:AVE_SRT_PRIVATE_DIRECTORY))",
      "$raw=[System.Security.AccessControl.RawSecurityDescriptor]::new([System.IO.Directory]::GetAccessControl($parent).GetSecurityDescriptorBinaryForm(), 0)",
      "if ($raw.Owner -ne $sid -or !($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected)) { throw 'Unprotected parent' }",
      "$traversers=@($readers | Where-Object { $_ -ne $sid.Value })",
      "if ($raw.DiscretionaryAcl.Count -ne 1 + $traversers.Count) { throw 'Unexpected parent grants' }",
      "foreach ($ace in $raw.DiscretionaryAcl) { if ($ace.AceType -ne 'AccessAllowed') { throw 'Unexpected parent ACE' }; if ($ace.SecurityIdentifier -eq $sid) { if ($ace.AccessMask -ne 0x1f01ff -or [int]$ace.AceFlags -ne 3) { throw 'Wrong parent owner grant' } } elseif ($ace.SecurityIdentifier.Value -notin $traversers -or $ace.AccessMask -ne 0x20 -or [int]$ace.AceFlags -ne 0) { throw 'Parent grants more than traversal' } }",
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

  it.runIf(process.platform === "win32").for(["unprotected", "foreign-owned", "junction"])(
    "refuses an existing %s Windows parent and leaves it untouched",
    (kind, context) => {
      const { source } = fixture();
      const temp = dirname(source);
      useTemp(temp);
      const sid = nativePowerShell("[Console]::WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)", {}).trim();
      const parent = join(temp, `ave-srt-win.${sid}`);
      const target = kind === "junction" ? join(temp, "target") : parent;
      if (kind === "foreign-owned") {
        const result = nativePowerShell([
          "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
          "$raw = [System.Security.AccessControl.RawSecurityDescriptor]::new('O:BAD:P(A;OICI;FA;;;' + $sid + ')(A;OICI;FA;;;SY)')",
          "$bytes = [byte[]]::new($raw.BinaryLength); $raw.GetBinaryForm($bytes, 0)",
          "$acl = [System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetSecurityDescriptorBinaryForm($bytes)",
          "try { $null = [System.IO.Directory]::CreateDirectory($env:AVE_TEST_PARENT, $acl) } catch [System.UnauthorizedAccessException], [System.Security.AccessControl.PrivilegeNotHeldException] { return } catch [System.IO.IOException] { if (($_.Exception.HResult -band 0xffff) -eq 1307) { return }; throw }",
          "$owner = [System.IO.Directory]::GetAccessControl($env:AVE_TEST_PARENT).GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
          "if ($owner -ne $sid) { [Console]::WriteLine('foreign') }",
        ].join("\n"), { AVE_TEST_PARENT: parent });
        if (result.trim() !== "foreign") return context.skip("Token cannot create a directory with a different owner");
      } else {
        mkdirSync(target);
        if (kind === "junction") symlinkSync(target, parent, "junction");
      }
      const descriptor = () => nativePowerShell("[Console]::WriteLine([System.IO.Directory]::GetAccessControl($env:AVE_TEST_PARENT).GetSecurityDescriptorSddlForm('Owner, Access'))", { AVE_TEST_PARENT: target });
      const before = descriptor();
      writeFileSync(join(target, "keep"), "original");
      try {
        sweepStaleSrtWinDirectories();
        expect(() => prepareSrtWinExecutable(source)).toThrow(expect.objectContaining({ code: "srt-win-integrity-mismatch" }));
        expect(descriptor()).toBe(before);
        expect(readFileSync(join(target, "keep"), "utf8")).toBe("original");
        expect(readdirSync(target)).toEqual(["keep"]);
      } finally {
        if (kind === "junction") rmdirSync(parent);
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
    const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    function childEnv(temp: string): NodeJS.ProcessEnv {
      return tsxChildEnv({ TEMP: temp, TMP: temp, TMPDIR: temp, AVE_TEST_SRT_RECEIPTS: JSON.stringify(BUILD_RECEIPTS) });
    }
    function runChild(mode: "runtime-pending" | "runtime-reset" | "no-runtime" | "simulate-lock", source = fixture().source): {
      executable: string; presentAtRuntimeRelease?: boolean; lockAttempts?: number; stderr: string;
    } {
      const resultPath = join(dirname(source), "result.json");
      const child = spawnSync(node, ["--import=tsx", exitOrderChild, source, resultPath, mode], {
        cwd: repoRoot, env: childEnv(dirname(source)), encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as { executable: string; presentAtRuntimeRelease?: boolean; lockAttempts?: number };
      return { ...result, stderr: child.stderr };
    }

    it.skipIf(process.platform === "win32")("reclaims a partial copy on next start after one quit attempt hits a lock", () => {
      const { source } = fixture();
      const first = runChild("simulate-lock", source);
      expect(first.lockAttempts).toBe(1);
      expect(existsSync(first.executable)).toBe(true);
      const outer = dirname(dirname(first.executable));
      const outside = join(dirname(source), "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "keep"), "sentinel");
      symlinkSync(outside, join(outer, "linked"), "dir");
      runChild("no-runtime", source);
      expect(existsSync(outer)).toBe(false);
      expect(readFileSync(join(outside, "keep"), "utf8")).toBe("sentinel");
    });

    it.skipIf(process.platform !== "win32")("recovers a copy at next startup after a Windows lock blocks its quit disposer", async () => {
      const { source } = fixture();
      const temp = dirname(source);
      useTemp(temp);
      const resultPath = join(temp, "result.json");
      const ave = spawn(node, ["--import=tsx", exitOrderChild, source, resultPath, "await-quit"], {
        cwd: repoRoot, env: childEnv(temp), windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      const aveExit = once(ave, "exit");
      try {
        expect(String((await once(ave.stdout, "data"))[0]).trim()).toBe("ready");
        const { executable } = JSON.parse(readFileSync(resultPath, "utf8")) as { executable: string };
        const outer = dirname(dirname(executable));
        sweepStaleSrtWinDirectories();
        expect(existsSync(executable)).toBe(true);
        const holder = spawn(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command", [
          "$ErrorActionPreference = 'Stop'",
          "$handle = [System.IO.File]::Open($env:AVE_TEST_IMAGE, 'Open', 'Read', 'Read')",
          "[Console]::Out.WriteLine('held')",
          "try { $null = [Console]::ReadLine() } finally { $handle.Dispose() }",
        ].join("\n")], {
          env: { SystemRoot: process.env.SystemRoot, AVE_TEST_IMAGE: executable },
          windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
        });
        const holderExit = once(holder, "exit");
        try {
          expect(String((await once(holder.stdout, "data"))[0]).trim()).toBe("held");
          ave.stdin.end("\n");
          expect((await aveExit)[0]).toBe(0);
          expect(existsSync(executable)).toBe(true);
        } finally {
          holder.stdin.end("\n");
          await holderExit;
        }
        const outside = join(temp, "outside");
        mkdirSync(outside);
        writeFileSync(join(outside, "keep"), "sentinel");
        const link = join(outer, "linked");
        symlinkSync(outside, link, "junction");
        try {
          runChild("no-runtime", source);
          expect(existsSync(outer)).toBe(false);
          expect(readFileSync(join(outside, "keep"), "utf8")).toBe("sentinel");
        } finally { if (existsSync(link)) rmdirSync(link); }
      } finally {
        if (!ave.stdin.writableEnded) ave.stdin.end("\n");
        await aveExit;
      }
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
