import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { cleanupWindowsJobRoot, hardenWindowsJobRoot, isolationAssignments, validateJobHomeRoot } from "../../.github/scripts/isolate-job-home.mjs";

describe("job home isolation", () => {
  it("places Windows fixtures on the system volume instead of the runner temp volume", () => {
    const create = mock.fn(() => "C:\\ave-ci-abc123");
    const values = isolationAssignments({ platform: "win32", runnerTemp: "D:\\a\\_temp", systemRoot: "C:\\Windows" }, create, mock.fn());
    assert.deepEqual(create.mock.calls.map(call => call.arguments), [["C:\\ave-ci-"]]);
    assert.deepEqual(values, {
      HOME: "C:\\ave-ci-abc123\\home", USERPROFILE: "C:\\ave-ci-abc123\\home",
      AVE_HOME: "C:\\ave-ci-abc123\\home\\.ave", TMPDIR: "C:\\ave-ci-abc123\\tmp",
      TEMP: "C:\\ave-ci-abc123\\tmp", TMP: "C:\\ave-ci-abc123\\tmp",
      AVE_TEST_TMP_ROOT: "C:\\ave-ci-abc123\\home\\.ave-test-tmp",
      LOCALAPPDATA: "C:\\ave-ci-abc123\\home\\local-app-data", APPDATA: "C:\\ave-ci-abc123\\home\\app-data",
      AVE_CI_JOB_ROOT: "C:\\ave-ci-abc123",
    });
  });
  it("leaves room for socket paths before publishing environment changes", () => {
    assert.throws(() => isolationAssignments({ platform: "darwin", runnerTemp: "/".padEnd(81, "a") }), /socket path/);
  });
  it("keeps non-Windows homes under runner temp", () => {
    const create = mock.fn();
    const home = "/runner/temp/home";
    assert.deepEqual(isolationAssignments({ platform: "linux", runnerTemp: "/runner/temp" }, create), {
      HOME: home, USERPROFILE: home, AVE_HOME: `${home}/.ave`,
      TMPDIR: "/runner/temp/tmp", TEMP: "/runner/temp/tmp", TMP: "/runner/temp/tmp",
    });
    assert.equal(create.mock.callCount(), 0);
  });
  for (const systemRoot of [undefined, "Windows", "\\\\host\\share\\Windows"]) {
    it(`refuses an invalid system directory before creating a root: ${systemRoot}`, () => {
      const create = mock.fn();
      assert.throws(() => isolationAssignments({ platform: "win32", runnerTemp: "D:\\a\\_temp", systemRoot }, create), /local system volume/);
      assert.equal(create.mock.callCount(), 0);
    });
  }
  it("accepts only an isolated job directory directly on the system volume for cleanup", () => {
    assert.equal(validateJobHomeRoot("C:\\ave-ci-abc123", "C:\\Windows"), "C:\\ave-ci-abc123");
    for (const root of ["C:\\", "C:\\Users\\alice", "C:\\ave-ci-abc123\\home", "D:\\ave-ci-abc123", "C:\\other", "C:\\ave-ci-abc123\\..\\other"]) {
      assert.throws(() => validateJobHomeRoot(root, "C:\\Windows"), /isolated job root/);
    }
  });
});

function blockedRemoval() {
  return Object.assign(new Error("Removal blocked"), { code: "EPERM", syscall: "unlink" });
}
function entryFacts(type = "file", readOnly = false) {
  return {
    mode: readOnly ? 0o444 : 0o666,
    isDirectory: () => type === "dir", isSymbolicLink: () => type === "link",
  };
}
function cleanupSeams(error = blockedRemoval()) {
  return {
    remove: mock.fn(() => { throw error; }),
    readDirectory: mock.fn(() => []), stat: mock.fn(() => entryFacts("dir")),
    run: mock.fn(() => "[]"), diagnostic: mock.fn(),
  };
}
function output(seams) {
  return seams.diagnostic.mock.calls.map(call => call.arguments[0]).join("\n");
}
function assertReadOnlyCommands(seams) {
  for (const call of seams.run.mock.calls) {
    const [command, args] = call.arguments;
    assert.equal(command, "powershell.exe");
    const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
    assert.doesNotMatch(`${command}\n${script}`, /icacls|takeown|attrib|Get-Acl|Set-Acl|Stop-Process|CommandLine|Environment/i);
    assert.match(script, /Get-Process/);
  }
}

describe("Windows job root cleanup diagnostics", () => {
  const root = join(tmpdir(), "ave-job-diagnostic");
  it("removes once without diagnostics on first-try success", () => {
    const seams = cleanupSeams();
    seams.remove = mock.fn();
    cleanupWindowsJobRoot(root, seams);
    assert.deepEqual(seams.remove.mock.calls.map(call => call.arguments), [[root, { recursive: true, force: true }]]);
    for (const seam of [seams.readDirectory, seams.stat, seams.run, seams.diagnostic]) assert.equal(seam.mock.callCount(), 0);
  });
  it("lists remaining entries breadth-first with types and read-only bits and rethrows the original error", () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    seams.readDirectory = mock.fn(path => (path === root ? ["child", "held.txt"] : ["nested.txt"]).map(name => ({ name })));
    seams.stat = mock.fn(path => entryFacts(path === root || path === join(root, "child") ? "dir" : "file", path.endsWith("held.txt")));
    assert.throws(() => cleanupWindowsJobRoot(root, seams), caught => caught === error);
    const lines = output(seams).split("\n");
    assert.deepEqual(lines, [
      'Job root cleanup failed: code="EPERM" syscall="unlink"',
      'entry "child" type=dir read-only=false',
      'entry "held.txt" type=file read-only=true',
      `entry ${JSON.stringify(join("child", "nested.txt"))} type=file read-only=false`,
    ]);
    assert.equal(seams.remove.mock.callCount(), 1);
    assertReadOnlyCommands(seams);
  });
  it("bounds a wide listing at 50 and does not enumerate queued children after the limit", () => {
    const seams = cleanupSeams();
    seams.readDirectory = mock.fn(() => Array.from({ length: 80 }, (_, index) => ({ name: `child-${index}` })));
    assert.throws(() => cleanupWindowsJobRoot(root, seams));
    assert.equal(output(seams).split("\n").filter(line => line.startsWith("entry ")).length, 50);
    assert.match(output(seams), /limited to 50/);
    assert.equal(seams.readDirectory.mock.callCount(), 1);
    assertReadOnlyCommands(seams);
  });
  for (const name of ["symlink", "junction"]) {
    it(`does not descend into a ${name} even with stale directory information`, () => {
      const seams = cleanupSeams();
      seams.readDirectory = mock.fn(() => [{ name, isDirectory: () => true, isSymbolicLink: () => false }]);
      seams.stat = mock.fn(path => entryFacts(path === root ? "dir" : "link"));
      assert.throws(() => cleanupWindowsJobRoot(root, seams));
      assert.match(output(seams), /type=symlink\/junction/);
      assert.equal(seams.readDirectory.mock.callCount(), 1);
      assertReadOnlyCommands(seams);
    });
  }
  it("rechecks queued routes before enumeration after a directory becomes a junction", () => {
    const seams = cleanupSeams();
    let childChecks = 0;
    seams.readDirectory = mock.fn(path => { assert.equal(path, root); return [{ name: "child" }]; });
    seams.stat = mock.fn(path => entryFacts(path === root || ++childChecks === 1 ? "dir" : "link"));
    assert.throws(() => cleanupWindowsJobRoot(root, seams));
    assert.match(output(seams), /Cleanup entry listing failed/);
    assert.equal(seams.readDirectory.mock.callCount(), 1);
  });
  it("prints only PID and image name for at most 20 processes without arguments or environment", () => {
    const seams = cleanupSeams();
    seams.run = mock.fn(() => JSON.stringify(Array.from({ length: 25 }, (_, index) => ({
      pid: 4000 + index, image: join(root, "holder.exe"),
      CommandLine: "holder.exe --token=SYNTHETIC FOO=bar", env: { FOO: "bar" },
    }))));
    assert.throws(() => cleanupWindowsJobRoot(root, seams));
    const lines = output(seams);
    assert.match(lines, /process pid=4000 image="holder.exe"/);
    assert.equal(lines.split("\n").filter(line => line.startsWith("process ")).length, 20);
    assert.doesNotMatch(lines, /--token|SYNTHETIC|FOO|bar|CommandLine|env/);
    assertReadOnlyCommands(seams);
  });
  for (const failure of ["query", "parse", "listing", "output"]) {
    it(`preserves the original removal error after a ${failure} failure`, () => {
      const error = blockedRemoval();
      const seams = cleanupSeams(error);
      if (failure === "query") seams.run = mock.fn(() => { throw new Error("query unavailable"); });
      if (failure === "parse") seams.run = mock.fn(() => "invalid JSON");
      if (failure === "listing") seams.readDirectory = mock.fn(() => { throw new Error("access denied"); });
      if (failure === "output") seams.diagnostic = mock.fn(() => { throw new Error("closed stderr"); });
      assert.throws(() => cleanupWindowsJobRoot(root, seams), caught => caught === error);
      if (failure !== "output") assert.match(output(seams), failure === "listing" ? /Cleanup entry listing failed/ : /Cleanup process query failed/);
      assertReadOnlyCommands(seams);
    });
  }
  it("does not enumerate a real Windows junction target", { skip: process.platform !== "win32" }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-junction-"));
    const root = join(fixture, "root");
    const target = join(fixture, "target");
    const junction = join(root, "junction");
    mkdirSync(root);
    mkdirSync(target);
    writeFileSync(join(target, "outside-sentinel.txt"), "preserve");
    symlinkSync(target, junction, "junction");
    try {
      const error = blockedRemoval();
      const seams = cleanupSeams(error);
      seams.stat = lstatSync;
      seams.readDirectory = mock.fn((...args) => readdirSync(...args));
      assert.throws(() => cleanupWindowsJobRoot(root, seams), caught => caught === error);
      assert.match(output(seams), /junction.*type=symlink\/junction/);
      assert.doesNotMatch(output(seams), /outside-sentinel/);
      assert.deepEqual(seams.readDirectory.mock.calls.map(call => call.arguments[0]), [root]);
      assert.equal(existsSync(join(target, "outside-sentinel.txt")), true);
      assertReadOnlyCommands(seams);
    } finally {
      unlinkSync(junction);
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("reports a real file held without delete sharing and its process, then cleans up after exit", { skip: process.platform !== "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-held-"));
    let holder;
    let exited;
    try {
      hardenWindowsJobRoot(root);
      const image = join(root, "holder.exe");
      const file = join(root, "held.txt");
      writeFileSync(file, "held fixture");
      const source = 'using System; using System.IO; public class Holder { public static void Main(string[] args) { using (new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.Read)) { Console.WriteLine("ready"); Console.ReadLine(); } } }';
      const script = `Add-Type -TypeDefinition '${source}' -OutputAssembly '${image.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
      execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, stdio: "pipe" });
      holder = spawn(image, [file, "--token=SYNTHETIC", "FOO=bar"], { windowsHide: true, stdio: "pipe" });
      exited = once(holder, "exit");
      const [ready] = await Promise.race([once(holder.stdout, "data"), exited.then(() => { throw new Error("Holder exited before opening the file"); })]);
      assert.equal(ready.toString().trim(), "ready");
      const diagnostic = mock.fn();
      assert.throws(() => cleanupWindowsJobRoot(root, { diagnostic }), error => error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES");
      const lines = output({ diagnostic });
      assert.match(lines, /entry "held.txt" type=file read-only=false/);
      assert.ok(lines.includes(`process pid=${holder.pid} image="holder.exe"`), lines);
      assert.doesNotMatch(lines, /Cleanup process query failed|SYNTHETIC|FOO|--token/);
      holder.stdin.end("\n");
      const [code] = await exited;
      assert.equal(code, 0);
      cleanupWindowsJobRoot(root);
      assert.equal(existsSync(root), false);
    } finally {
      if (holder && holder.exitCode === null) {
        holder.stdin.end("\n");
        await exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});


const CURRENT_SID = "S-1-5-21-100-200-300-1001";
const PRINCIPALS = [CURRENT_SID, "S-1-5-18", "S-1-5-32-544"];
function privateDacl() {
  return { protected: true, rules: PRINCIPALS.map(sid => ({
    sid, rights: 0x1f01ff, type: 0, inherited: false, inheritance: 3, propagation: 0,
  })) };
}
function commandRunner(acl = privateDacl(), sid = CURRENT_SID) {
  return mock.fn((command) => command === "whoami.exe"
    ? `"example\\runner","${sid}"\n` : command === "powershell.exe" ? JSON.stringify(acl) : "");
}
describe("Windows job root hardening", () => {
  it("removes existing grants and inheritance, then grants only SID-based full control", () => {
    const run = commandRunner();
    hardenWindowsJobRoot("C:\\ave-ci-abc123", run);
    assert.deepEqual(run.mock.calls.map(({ arguments: [command, args] }) => [command, args]).slice(0, 3), [
      ["whoami.exe", ["/user", "/fo", "csv", "/nh"]],
      ["icacls.exe", ["C:\\ave-ci-abc123", "/reset"]],
      ["icacls.exe", ["C:\\ave-ci-abc123", "/inheritance:r", "/grant:r",
        ...PRINCIPALS.map(sid => `*${sid}:(OI)(CI)F`)]],
    ]);
    assert.equal(run.mock.calls[3].arguments[0], "powershell.exe");
  });
  for (const [name, alter] of [
    ["a foreign ACE", acl => acl.rules.push({ ...acl.rules[0], sid: "S-1-5-11" })],
    ["an unprotected DACL", acl => { acl.protected = false; }],
    ["a missing principal", acl => acl.rules.pop()],
    ["a duplicate principal", acl => { acl.rules[2].sid = CURRENT_SID; }],
    ["a deny rule", acl => { acl.rules[0].type = 1; }],
    ["inherited access", acl => { acl.rules[0].inherited = true; }],
    ["partial control", acl => { acl.rules[0].rights = 0x1301bf; }],
    ["missing child inheritance", acl => { acl.rules[0].inheritance = 0; }],
    ["inherit-only access", acl => { acl.rules[0].propagation = 2; }],
  ]) {
    it(`refuses readback with ${name}`, () => {
      const acl = privateDacl();
      alter(acl);
      assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", commandRunner(acl)), /protected DACL/);
    });
  }
  for (const sid of ["S-1-5-11", "S-1-5-21-bad", "S-1-5-21-100-200-300-1001 /grant", "S-1-5-21-1--2"]) {
    it(`refuses an invalid account SID before changing permissions: ${sid}`, () => {
      const run = commandRunner(privateDacl(), sid);
      assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", run), /valid current account SID/);
      assert.equal(run.mock.callCount(), 1);
    });
  }
  it("hardens the new root while it is empty before returning child paths", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-order-"));
    try {
      const harden = mock.fn(path => {
        assert.equal(path, root);
        assert.deepEqual(readdirSync(root), []);
      });
      isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" }, () => root, harden);
      assert.equal(harden.mock.callCount(), 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("removes the half-made root when hardening fails", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-failed-"));
    assert.throws(() => isolationAssignments({ platform: "win32", systemRoot: "C:\\Windows" }, () => root,
      () => { throw new Error("DACL readback failed"); }), /DACL readback failed/);
    assert.equal(existsSync(root), false);
  });
  it("propagates command failures and malformed readback", () => {
    for (const run of [() => { throw new Error("command failed"); }, () => "invalid JSON"]) {
      assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", run));
    }
    const run = commandRunner();
    assert.throws(() => hardenWindowsJobRoot("C:\\ave-ci-abc123", (command, ...args) =>
      command === "powershell.exe" ? "invalid JSON" : run(command, ...args)), SyntaxError);
  });
  it("protects a real root and limits directory and file inheritance to three principals", { skip: process.platform !== "win32" }, () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-acl-"));
    const readAcl = path => {
      const script = `$acl = Get-Acl -LiteralPath '${path.replaceAll("'", "''")}'; @{ protected = $acl.AreAccessRulesProtected; sids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); inherited = @($acl.Access | ForEach-Object { $_.IsInherited }) } | ConvertTo-Json -Compress`;
      return JSON.parse(execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true }));
    };
    try {
      execFileSync(join(process.env.SystemRoot, "System32", "icacls.exe"), [root, "/grant", "*S-1-5-11:(OI)(CI)M"], { stdio: "pipe", windowsHide: true });
      assert.ok(readAcl(root).sids.includes("S-1-5-11"));
      hardenWindowsJobRoot(root);
      const acl = readAcl(root);
      assert.equal(acl.protected, true);
      assert.equal(acl.sids.length, 3);
      assert.ok(acl.sids.includes("S-1-5-18") && acl.sids.includes("S-1-5-32-544"));
      const directory = join(root, "child");
      const file = join(directory, "file.txt");
      mkdirSync(directory);
      writeFileSync(file, "fixture");
      for (const path of [directory, file]) {
        const child = readAcl(path);
        assert.deepEqual(child.sids.sort(), acl.sids.sort());
        assert.ok(child.inherited.every(value => value === true));
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
