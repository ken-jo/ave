import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { hardenWindowsJobRoot, isolationAssignments, validateJobHomeRoot } from "../../.github/scripts/isolate-job-home.mjs";

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
