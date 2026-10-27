// Drive classification accepts only X:, follows substituted drives and fails closed on unmapped drives.
// Output must contain only the resolved mapping.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (process.platform !== "win32") throw new Error("This test requires Windows");
const helper = resolve(`resources/windows-path-kind/${process.arch}/ave-path-kind.exe`);

function run(...args) {
  const result = spawnSync(helper, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const systemDirectoryResult = run("--system-directory");
assert.equal(systemDirectoryResult.code, 0, systemDirectoryResult.stderr);
assert.equal(systemDirectoryResult.stderr, "");
assert.match(systemDirectoryResult.stdout, /^[a-z]:\\[^\r\n]+\r?\n$/iu);
const systemDirectory = systemDirectoryResult.stdout.replace(/\r?\n$/u, "");
const spoofedDirectory = spawnSync(helper, ["--system-directory"], {
  encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000,
  env: { SystemRoot: "Z:\\untrusted-root", WINDIR: "Y:\\untrusted-root", PATH: "X:\\untrusted-path" },
});
assert.ifError(spoofedDirectory.error);
assert.equal(spoofedDirectory.status, 0, spoofedDirectory.stderr);
assert.equal(spoofedDirectory.stdout, systemDirectoryResult.stdout, "parent system variables cannot change the OS directory answer");
const runtimeSystemDirectory = execFileSync(join(systemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"),
  ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.Write([Environment]::SystemDirectory)"],
  { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000,
    env: { SystemRoot: dirname(systemDirectory), WINDIR: dirname(systemDirectory), PATH: systemDirectory } });
assert.equal(systemDirectory.toLowerCase(), runtimeSystemDirectory.toLowerCase(), "native and runtime OS system-directory APIs agree");
assert.equal(run("--system-directory", "unexpected").code, 2);
console.log(`OS system directory: ${systemDirectory}; spoofed environment ignored`);

function unusedDrives() {
  const unused = [];
  for (const letter of "ZYXWVUTSRQPONMLKJIHGFED") {
    if (run(`${letter}:`).code === 1) unused.push(`${letter}:`);
  }
  return unused;
}

const system = (process.env.SystemDrive ?? "C:").toUpperCase();
const local = run(system);
assert.equal(local.code, 0, local.stderr);
assert.match(local.stdout, /^\\Device\\HarddiskVolume\d+\r?\n$/u, `the system drive maps to a volume: ${JSON.stringify(local.stdout)}`);
assert.equal(local.stdout.split("\n").filter(Boolean).length, 1, "one line only");
console.log(`${system} -> ${local.stdout.trim()}`);

assert.equal(run(system.toLowerCase()).stdout, local.stdout);

for (const bad of ["C", "C:\\", "CC:", "1:", "\\\\server\\share", ""]) {
  const refused = run(bad);
  assert.equal(refused.code, 2, `"${bad}" is refused as usage`);
  assert.equal(refused.stdout, "");
}
assert.equal(run().code, 2, "no argument is usage");
assert.equal(run("C:", "D:").code, 2, "two arguments are usage");

const [free, second] = unusedDrives();
assert.ok(free && second, "two unused drive letters are available");

const missing = run(free);
assert.equal(missing.code, 1);
assert.equal(missing.stdout, "");
assert.match(missing.stderr, /QueryDosDeviceW failed: \d+/u);
console.log(`${free} (unmapped) -> exit 1`);

// Substituted drives return a native path whose drive must be classified in turn.
const target = mkdtempSync(join(tmpdir(), "ave path kind "));
try {
  execFileSync("subst", [free, target], { windowsHide: true });
  try {
    const subst = run(free);
    assert.equal(subst.code, 0, subst.stderr);
    assert.equal(subst.stdout.trim().toLowerCase(), `\\??\\${target}`.toLowerCase(), `subst maps to its target: ${JSON.stringify(subst.stdout)}`);
    console.log(`${free} (subst) -> ${subst.stdout.trim()}`);
    execFileSync("subst", [second, `${free}\\`], { windowsHide: true });
    try {
      const chained = run(second);
      assert.equal(chained.code, 0, chained.stderr);
      // Substituted drive roots are reported without a trailing separator.
      assert.equal(chained.stdout.trim().toLowerCase(), `\\??\\${free}`.toLowerCase());
      console.log(`${second} (subst of ${free}) -> ${chained.stdout.trim()}`);
    } finally {
      execFileSync("subst", [second, "/D"], { windowsHide: true });
    }
  } finally {
    execFileSync("subst", [free, "/D"], { windowsHide: true });
  }
  assert.equal(run(free).code, 1);
} finally {
  rmSync(target, { recursive: true, force: true });
}
console.log("windows-path-kind: ok");

const fixture = mkdtempSync(join(tmpdir(), "ave-path-facts-"));
try {
  console.log(execFileSync(join(tmpdir(), "ave-path-pin-test.exe"), [fixture], { windowsHide: true, encoding: "utf8" }).trim());
  console.log("native pin: deterministic retag and swapped ancestor checks passed");
  const directory = join(fixture, "directory");
  mkdirSync(directory);
  const file = join(directory, "file");
  writeFileSync(file, "pinned bytes");
  const link = join(fixture, "junction");
  symlinkSync(directory, link, "junction");
  const paths = [file, directory, join(directory, "missing"), link, join(link, "file"), join(link, "nested", "unopened")];
  const pins = run("--pin", ...paths);
  assert.equal(pins.code, 0, pins.stderr);
  const rows = JSON.parse(pins.stdout);
  assert.equal(rows.length, paths.length);
  for (const row of rows.flatMap(row => [row, ...row.ancestors])) {
    if (row.exists === true) assert.match(row.changeTime, /^0x[0-9a-f]{16}$/u, "changeTime is a hex-64 string");
    else assert.equal(row.changeTime, null, "missing and uninspected objects have null changeTime");
  }
  assert.equal(JSON.parse(run("--pin", file).stdout)[0].changeTime, rows[0].changeTime, "unchanged pins have stable changeTime");
  for (const [index, path] of paths.slice(0, 2).entries()) {
    const stat = lstatSync(path, { bigint: true });
    assert.equal(BigInt(rows[index].volumeSerialNumber), stat.dev, "Node dev is the legacy 32-bit volume serial");
    assert.equal(BigInt(rows[index].fileIndex), stat.ino, "Node ino is the legacy 64-bit file index");
    assert.match(rows[index].fileId, /^0x[0-9a-f]{32}$/u);
    assert.match(rows[index].volumeSerial, /^0x[0-9a-f]{16}$/u);
    assert.equal(rows[index].canonical.toLowerCase(), `\\\\?\\${path}`.toLowerCase());
    assert.ok(rows[index].ancestors.length > 1);
    assert.ok(rows[index].ancestors.every(ancestor => ancestor.exists));
  }
  const descriptor = openSync(file, "r");
  try {
    assert.equal(BigInt(rows[0].fileIndex), fstatSync(descriptor, { bigint: true }).ino);
    assert.equal(BigInt(rows[0].volumeSerialNumber), fstatSync(descriptor, { bigint: true }).dev);
  } finally { closeSync(descriptor); }
  assert.equal(rows[2].exists, false);
  assert.equal(rows[3].reparseTag, 0xa0000003);
  assert.equal(rows[3].reparseTarget.toLowerCase(), directory.toLowerCase(), "the retained junction handle supplies the target");
  assert.equal(rows[4].exists, null, "a reparse ancestor prevents opening the target");
  assert.equal(rows[5].ancestors.at(-1).exists, null);
  // A GUID-owned tag has no link semantics known to the filesystem runtime.
  const unfamiliar = join(fixture, "unfamiliar");
  writeFileSync(unfamiliar, "");
  execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FixtureReparse {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int length, IntPtr output, int size, out int returned, IntPtr overlapped);
  public static void Set(string path) {
    using(var handle=CreateFile(path,0x40000000,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      var data=new byte[24]; data[0]=0x42;
      new Guid("db26d866-5321-4f43-977f-4591ca0bf0ee").ToByteArray().CopyTo(data,8);
      int returned;
      if(!DeviceIoControl(handle,0x900a4,data,data.Length,IntPtr.Zero,0,out returned,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@; [FixtureReparse]::Set('${unfamiliar.replaceAll("'", "''")}')`,
  ], { windowsHide: true });
  let classification;
  try { classification = lstatSync(unfamiliar).isSymbolicLink(); }
  catch (error) { classification = error.code; assert.ok(["EACCES", "EINVAL"].includes(error.code)); }
  assert.notEqual(classification, true, "an unfamiliar tag cannot be admitted by a symbolic-link predicate");
  const unfamiliarPin = run("--pin", unfamiliar);
  assert.equal(unfamiliarPin.code, 0, unfamiliarPin.stderr);
  const [unfamiliarFacts] = JSON.parse(unfamiliarPin.stdout);
  assert.equal(unfamiliarFacts.reparseTag, 0x42);
  assert.equal(unfamiliarFacts.attributes & 0x400, 0x400);
  const unfamiliarDacl = run("--dacl", unfamiliar);
  assert.equal(unfamiliarDacl.code, 0, unfamiliarDacl.stderr);
  assert.equal(JSON.parse(unfamiliarDacl.stdout)[0].reparseTag, 0x42);
  console.log(`unfamiliar reparse tag: lstat=${classification}; native reparseTag=66`);
  const dacls = run("--dacl", "--parent", "--content", file);
  assert.equal(dacls.code, 0, dacls.stderr);
  const [dacl] = JSON.parse(dacls.stdout);
  assert.equal(dacl.changeTime, rows[0].changeTime, "DACL facts carry the pinned changeTime");
  assert.deepEqual(dacl.identity, { volumeSerial: rows[0].volumeSerial, fileId: rows[0].fileId });
  assert.equal(Buffer.from(dacl.contentHex, "hex").toString(), "pinned bytes");
  assert.equal(typeof dacl.owner, "string");
  assert.ok(Array.isArray(dacl.aces));
  assert.ok(dacl.parent);
  const writer = openSync(file, "r+");
  try {
    const locked = run("--dacl", "--parent", "--content", file);
    assert.equal(locked.code, 4, "a concurrent write handle prevents a policy snapshot");
    assert.equal(locked.stdout, "");
  } finally { closeSync(writer); }
  assert.equal(JSON.parse(run("--dacl", paths[2]).stdout)[0].exists, false);
  for (const mode of ["--pin", "--dacl"]) {
    const failed = run(mode, file, join(fixture, "invalid|target"));
    assert.equal(failed.code, 4);
    assert.equal(failed.stdout, "", "failed batches emit no partial data");
    assert.equal(run(mode).code, 2);
    assert.notEqual(run(mode, "relative").code, 0);
  }
  console.log("windows-path-facts: pin, DACL, content, reparse, missing and Node identity checks passed");
} finally { rmSync(fixture, { recursive: true, force: true }); }
