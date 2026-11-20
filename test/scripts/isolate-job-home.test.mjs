import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";
import { diagnoseJobRoot } from "../../.github/scripts/job-root-diagnostic.mjs";
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
function cleanupSeams(error = blockedRemoval()) {
  return {
    remove: mock.fn(() => { throw error; }), run: queryResult(), diagnostic: mock.fn(),
  };
}
function queryRecords({
  processes = [], holders = [], entries = [], failed = false, changed = false, limited = false,
  processScanFailed = false, processLimited = false,
} = {}) {
  const rows = [
    ...entries.map(entry => ({ kind: "candidate", ...entry })),
    { kind: "files", failed, changed, limited, empty: entries.length === 0 },
    ...holders,
    { kind: "holders", limited: false },
    ...processes,
    { kind: "processes", failed: processScanFailed, limited: processLimited },
  ];
  return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}
function queryResult(result) {
  return mock.fn((_command, _args, _options, done) => done(null, queryRecords(result)));
}
const QUERY_VARIABLE = "AVE_CI_JOB_ROOT_QUERY";
const PROCESS_DETAILS = {
  kind: "process", pid: 4000, parentPid: 2000, image: "C:\\fixture\\holder.exe", reason: "argument",
  created: "2026-01-02T03:04:05.0000000Z",
};
function output(seams) {
  return seams.diagnostic.mock.calls.map(call => call.arguments[0]).join("\n");
}
function powerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function runFixturePowerShell(script) {
  const command = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`;
  return execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, stdio: "pipe", env: windowsPowerShellEnv() }).trim();
}
function runInjectedQuery(injection) {
  return (command, args, options, done) => {
    const env = { ...options.env, [QUERY_VARIABLE]: `${injection}\n${options.env[QUERY_VARIABLE]}` };
    return execFile(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", command),
      args, { ...options, env }, done);
  };
}
function fixtureAcl(path) {
  return `Get-Acl -LiteralPath ${powerShellLiteral(path)}`;
}
function applyFixtureDenies(rules, savedAcls) {
  const sid = runFixturePowerShell("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
  const sddl = JSON.parse(runFixturePowerShell("ConvertTo-Json -Compress -InputObject @(" +
    rules.map(([path]) => `(${fixtureAcl(path)}).Sddl`).join("; ") + ")"));
  for (const [i, [path]] of rules.entries()) savedAcls.set(path, sddl[i]);
  runFixturePowerShell(rules.map(([path, rights]) => [
    `$acl = ${fixtureAcl(path)}`,
    "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(" +
      "[Security.Principal.SecurityIdentifier]::new('" + sid + "'), '" + rights + "', 'Deny'))",
    `Set-Acl -LiteralPath ${powerShellLiteral(path)} -AclObject $acl`,
  ].join("\n")).join("\n"));
  return sid;
}
function restoreFixtureAcls(savedAcls) {
  if (savedAcls.size === 0) return;
  const restore = [...savedAcls].filter(([path]) => existsSync(path)).map(([path, sddl]) => [
    "try {",
    `  $acl = ${fixtureAcl(path)}`,
    `  $acl.SetSecurityDescriptorSddlForm(${powerShellLiteral(sddl)}, 'Access')`,
    `  Set-Acl -LiteralPath ${powerShellLiteral(path)} -AclObject $acl`,
    "} catch { $restoreError = $_ }",
  ].join("\n"));
  runFixturePowerShell(["$restoreError = $null", ...restore, "if ($restoreError) { throw $restoreError }"].join("\n"));
}
describe("Windows job root cleanup diagnostics", () => {
  const root = join(tmpdir(), "ave-job-diagnostic");
  it("removes once without diagnostics on first-try success", async () => {
    const seams = cleanupSeams();
    seams.remove = mock.fn();
    await cleanupWindowsJobRoot(root, seams);
    assert.deepEqual(seams.remove.mock.calls.map(call => call.arguments), [[root, { recursive: true, force: true }]]);
    for (const seam of [seams.run, seams.diagnostic]) assert.equal(seam.mock.callCount(), 0);
  });
  it("runs the entire diagnostic with exact time and output bounds and preserves the removal error", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    seams.run = queryResult({ processes: [PROCESS_DETAILS] });
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    assert.equal(seams.run.mock.callCount(), 1);
    assert.equal(seams.remove.mock.callCount(), 1);
    const [command, args, options] = seams.run.mock.calls[0].arguments;
    assert.equal(command, "powershell.exe");
    assert.deepEqual(args.slice(0, -1), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    assert.ok(Buffer.from(args.at(-1), "base64").toString("utf16le").includes(QUERY_VARIABLE));
    const { [QUERY_VARIABLE]: script, ...env } = options.env;
    assert.ok(script.includes(root));
    assert.deepEqual({ ...options, env }, { encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, env: windowsPowerShellEnv() });
    assert.match(output(seams), /process pid=4000 parent-pid=2000 image=.*holder\.exe.*match=argument.*created="2026-01-02T03:04:05.0000000Z"/);
    assert.doesNotMatch(output(seams), /diagnostic failed/);
  });
  for (const failure of ["child", "malformed JSON", "invalid entries", "incomplete scan", "output"]) {
    it(`preserves the original removal error on ${failure} failure`, async () => {
      const error = blockedRemoval();
      const seams = cleanupSeams(error);
      if (failure === "child") seams.run = mock.fn((_command, _args, _options, done) => done(new Error("SYNTHETIC PRIVATE DETAILS")));
      if (failure === "malformed JSON") seams.run = mock.fn((_command, _args, _options, done) => done(null, "{SYNTHETIC PRIVATE"));
      if (failure === "invalid entries") seams.run = queryResult({ entries: [{ path: "SYNTHETIC PRIVATE" }] });
      if (failure === "incomplete scan") seams.run = queryResult({ failed: true, processes: [PROCESS_DETAILS] });
      if (failure === "output") seams.diagnostic = mock.fn(() => { throw new Error("closed stderr"); });
      await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
      assert.doesNotMatch(output(seams), /SYNTHETIC PRIVATE/);
      if (failure !== "output") assert.equal(output(seams).split("\n").filter(line => line === "Cleanup diagnostic failed or timed out").length, 1);
      if (failure === "incomplete scan") assert.match(output(seams), /process pid=4000 parent-pid=2000/);
    });
  }
  it("retains valid evidence on both sides of a malformed process record", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    seams.run = queryResult({
      processScanFailed: true,
      processes: [{ ...PROCESS_DETAILS, reason: "SYNTHETIC PRIVATE" }, PROCESS_DETAILS],
      entries: [{ path: root, attributes: "Directory", owner: null, deny: null, parentDeny: null, created: null, lastWrite: null }],
    });
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    assert.match(output(seams), /candidate path=.*created="not determined" last-write="not determined"/);
    assert.match(output(seams), /Cleanup process scan was incomplete/);
    assert.match(output(seams), /process pid=4000.*match=argument/);
    assert.doesNotMatch(output(seams), /SYNTHETIC PRIVATE/);
  });
  it("bounds a stalled diagnostic child and still throws the original removal error", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    seams.run = (_command, _args, options, done) => execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, done);
    const start = performance.now();
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 4500 && elapsed < 6500, `elapsed=${elapsed}`);
    assert.match(output(seams), /Cleanup diagnostic failed or timed out/);
  });
  for (const processQuery of ["native", "unavailable"]) {
    it(`never discloses target metadata when the root is replaced by a junction (${processQuery} process query)`, async () => {
      const fixture = mkdtempSync(join(tmpdir(), "ave-job-root-swap-"));
      const root = join(fixture, "root"), saved = join(fixture, "saved"), target = join(fixture, "target");
      const sentinel = join(target, "SYNTHETIC-OUTSIDE-SENTINEL.txt");
      mkdirSync(root); mkdirSync(target); writeFileSync(sentinel, "preserve");
      const snapshot = () => [target, sentinel].map(path => {
        const facts = lstatSync(path);
        const script = `(Get-Acl -LiteralPath '${path.replaceAll("'", "''")}').Sddl`;
        const acl = process.platform === "win32" ? execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
          ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
          { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv() }) : null;
        return { mode: facts.mode, size: facts.size, mtime: facts.mtimeMs, acl };
      });
      let swapped = false;
      try {
        if (process.platform === "win32") hardenWindowsJobRoot(root);
        assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
        assert.equal(realpathSync.native(root).toLowerCase(), root.toLowerCase());
        const before = snapshot();
        const error = Object.assign(blockedRemoval(), { path: join(root, "blocked-original.txt") });
        const seams = cleanupSeams(error);
        seams.run = mock.fn((command, args, options, done) => {
          renameSync(root, saved); symlinkSync(target, root, "junction"); swapped = true;
          if (processQuery === "unavailable" || process.platform !== "win32") return done(new Error("Query unavailable"));
          return execFile(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", command), args, options, done);
        });
        await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
        assert.equal(swapped, true);
        assert.equal(seams.remove.mock.callCount(), 1);
        assert.equal(seams.run.mock.callCount(), 1);
        const lines = output(seams);
        assert.doesNotMatch(lines, /SYNTHETIC-OUTSIDE|candidate path=/);
        assert.match(lines, /Cleanup diagnostic failed or timed out/);
        assert.ok(lines.includes(`path=${JSON.stringify(error.path)}`), lines);
        assert.deepEqual(readdirSync(target), ["SYNTHETIC-OUTSIDE-SENTINEL.txt"]);
        assert.equal(readFileSync(sentinel, "utf8"), "preserve");
        assert.deepEqual(snapshot(), before);
      } finally {
        if (swapped) unlinkSync(root);
        rmSync(fixture, { recursive: true, force: true });
      }
    });
  }
  it("keeps completed file rows when later child output overflows", async () => {
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    const records = queryRecords({
      entries: [{ path: root, attributes: "Directory", owner: null, deny: null, parentDeny: null, created: null, lastWrite: null }],
    }).split("\n").slice(0, 2);
    const evidence = `${records.join("\n")}\n`;
    seams.run = (_command, _args, options, done) => execFile(process.execPath,
      ["-e", "process.stdout.write(process.env.EXAMPLE_EVIDENCE, () => process.stdout.write('SYNTHETIC'.repeat(20000)))"],
      { ...options, env: { ...options.env, EXAMPLE_EVIDENCE: evidence } }, done);
    await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
    assert.doesNotMatch(output(seams), /SYNTHETIC/);
    assert.match(output(seams), /candidate path=/);
    assert.equal(output(seams).split("\n").filter(line => line === "Cleanup diagnostic failed or timed out").length, 1);
  });
  it("reports an empty surviving Windows root and its parent delete deny", { skip: process.platform !== "win32" }, async () => {
    const parent = mkdtempSync(join(tmpdir(), "ave-job-root-deny-"));
    const root = join(parent, "root");
    const savedAcls = new Map();
    try {
      mkdirSync(root);
      const owner = runFixturePowerShell(`(${fixtureAcl(root)}).GetOwner([Security.Principal.SecurityIdentifier]).Value`);
      const sid = applyFixtureDenies([[parent, "DeleteSubdirectoriesAndFiles"], [root, "Delete"]], savedAcls);
      const deniedAcls = runFixturePowerShell(`(${fixtureAcl(parent)}).Sddl; (${fixtureAcl(root)}).Sddl`);
      const diagnostic = mock.fn();
      let removalError;
      const remove = (...args) => {
        try { rmSync(...args); }
        catch (error) { removalError = error; throw error; }
      };
      await assert.rejects(cleanupWindowsJobRoot(root, { diagnostic, remove }), caught => caught === removalError && caught.code === "EPERM");
      assert.deepEqual(readdirSync(root), []);
      assert.equal(runFixturePowerShell(`(${fixtureAcl(parent)}).Sddl; (${fixtureAcl(root)}).Sddl`), deniedAcls);
      const lines = output({ diagnostic });
      const candidates = lines.split("\n").filter(line => line.startsWith("candidate path="));
      assert.equal(candidates.length, 1, lines);
      assert.ok(candidates[0].startsWith(
        `candidate path=${JSON.stringify(root)} owner=${JSON.stringify(owner)} deny=[{"sid":"${sid}","rights":"Delete"}]` +
        ` parent-deny=[{"sid":"${sid}","rights":"DeleteSubdirectoriesAndFiles"}] attributes="Directory" handle="not determined"`,
      ), lines);
      assert.match(candidates[0], /created="[\d:T.-]+Z" last-write="[\d:T.-]+Z"$/);
      assert.doesNotMatch(lines, /found no surviving entries|Cleanup diagnostic failed or timed out/);
    } finally {
      try { restoreFixtureAcls(savedAcls); }
      finally {
        rmSync(parent, { recursive: true, force: true });
        assert.equal(existsSync(parent), false);
      }
    }
  });
  it("skips a Windows descendant replaced by a junction after the directory entry was read", { skip: process.platform !== "win32" }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-descendant-swap-"));
    const root = join(fixture, "root"), child = join(root, "child"), saved = join(fixture, "saved");
    const target = join(fixture, "target"), staged = join(fixture, "staged");
    const sentinel = join(target, "OUTSIDE-SWAP-SENTINEL.txt");
    const error = blockedRemoval();
    const seams = cleanupSeams(error);
    try {
      mkdirSync(child, { recursive: true });
      mkdirSync(target);
      writeFileSync(sentinel, "preserve");
      symlinkSync(target, staged, "junction");
      seams.run = (command, args, options, done) => {
        const script = options.env[QUERY_VARIABLE];
        const beforeOpen = "    $handle = if ($canList)";
        assert.ok(script.includes(beforeOpen));
        const swap = [
          `    if ($next.path -eq ${powerShellLiteral(child)}) {`,
          `      [IO.Directory]::Move(${powerShellLiteral(child)}, ${powerShellLiteral(saved)})`,
          `      [IO.Directory]::Move(${powerShellLiteral(staged)}, ${powerShellLiteral(child)})`,
          "    }",
        ].join("\n");
        const env = { ...options.env, [QUERY_VARIABLE]: script.replace(beforeOpen, `${swap}\n${beforeOpen}`) };
        return execFile(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", command),
          args, { ...options, env }, done);
      };
      await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
      assert.ok(lstatSync(saved).isDirectory());
      assert.ok(lstatSync(child).isSymbolicLink());
      const lines = output(seams);
      assert.doesNotMatch(lines, /OUTSIDE-SWAP-SENTINEL/);
      assert.match(lines, /Cleanup path scan skipped an entry whose directory or reparse attributes changed/);
      assert.match(lines, /Cleanup diagnostic failed or timed out/);
      assert.equal(readFileSync(sentinel, "utf8"), "preserve");
    } finally {
      for (const path of [child, staged]) {
        if (existsSync(path) && lstatSync(path).isSymbolicLink()) unlinkSync(path);
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("reports surviving Windows paths with delete denies, read-only attributes and junctions", { skip: process.platform !== "win32" }, async () => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-survivors-"));
    const root = join(fixture, "root's [job]"), target = join(fixture, "target");
    const blocked = join(root, "blocked"), readOnly = join(root, "read-only [fixture].txt"), junction = join(root, "junction");
    const sentinel = join(target, "OUTSIDE-JUNCTION-TARGET.txt");
    const rules = [
      [root, "DeleteSubdirectoriesAndFiles"],
      [blocked, "Delete"],
      [readOnly, "Delete, WriteAttributes"],
      [junction, "Delete"],
    ];
    const savedAcls = new Map();
    try {
      mkdirSync(blocked, { recursive: true });
      mkdirSync(target);
      writeFileSync(sentinel, "preserve");
      writeFileSync(readOnly, "fixture");
      symlinkSync(target, junction, "junction");
      const owner = runFixturePowerShell(`(${fixtureAcl(blocked)}).GetOwner([Security.Principal.SecurityIdentifier]).Value`);
      runFixturePowerShell(`[IO.File]::SetAttributes(${powerShellLiteral(readOnly)}, 'ReadOnly, Hidden, System')`);
      const sid = applyFixtureDenies(rules, savedAcls);

      const diagnostic = mock.fn();
      await assert.rejects(cleanupWindowsJobRoot(root, { diagnostic }), error => ["EPERM", "EBUSY", "EACCES"].includes(error.code));
      const lines = output({ diagnostic });
      assert.ok(lines.split("\n").find(line => line.startsWith("candidate path="))?.startsWith(`candidate path=${JSON.stringify(root)} `), lines);
      const candidate = path => {
        const line = lines.split("\n").find(line => line.startsWith(`candidate path=${JSON.stringify(path)} `));
        assert.ok(line, lines);
        assert.ok(line.includes(`owner=${JSON.stringify(owner)}`), line);
        assert.match(line, /handle="not determined"/);
        return line;
      };
      const blockedLine = candidate(blocked);
      assert.ok(blockedLine.includes(`deny=[{"sid":"${sid}","rights":"Delete"}]`), blockedLine);
      assert.ok(blockedLine.includes(`parent-deny=[{"sid":"${sid}","rights":"DeleteSubdirectoriesAndFiles"}]`), blockedLine);
      assert.match(candidate(readOnly), /attributes="[^"]*ReadOnly[^"]*Hidden[^"]*System/);
      const junctionLine = candidate(junction);
      assert.match(junctionLine, /attributes="[^"]*ReparsePoint/);
      assert.ok(junctionLine.includes(`deny=[{"sid":"${sid}","rights":"Delete"}]`), junctionLine);
      assert.doesNotMatch(lines, /OUTSIDE-JUNCTION-TARGET|Cleanup diagnostic failed or timed out/);
      assert.equal(readFileSync(sentinel, "utf8"), "preserve");
    } finally {
      try { restoreFixtureAcls(savedAcls); }
      finally {
        if (existsSync(readOnly)) runFixturePowerShell(`[IO.File]::SetAttributes(${powerShellLiteral(readOnly)}, 'Normal')`);
        if (existsSync(junction)) unlinkSync(junction);
        rmSync(fixture, { recursive: true, force: true });
        assert.equal(existsSync(fixture), false);
      }
    }
  });
  it("reports an outside-root holder that opens a candidate through TEMP", { skip: process.platform !== "win32" }, async (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "ave-job-held-"));
    const root = join(fixture, "root");
    let holder;
    let exited;
    try {
      mkdirSync(root);
      hardenWindowsJobRoot(root);
      const image = join(fixture, "holder.exe");
      const file = join(root, "wmsetup.log");
      writeFileSync(file, "held fixture");
      const lastWrite = new Date("2026-01-02T03:04:05Z");
      utimesSync(file, lastWrite, lastWrite);
      const { birthtimeMs } = statSync(file);
      const source = 'using System; using System.IO; public class Holder { public static void Main() { using (new FileStream(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "wmsetup.log"), FileMode.Open, FileAccess.Read, FileShare.Read)) { Console.WriteLine("ready"); Console.ReadLine(); } } }';
      const script = `Add-Type -TypeDefinition '${source}' -OutputAssembly '${image.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
      execFileSync(join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, stdio: "pipe", env: windowsPowerShellEnv() });
      holder = spawn(image, [], { cwd: fixture, env: { ...process.env, TEMP: root }, windowsHide: true, stdio: "pipe" });
      exited = once(holder, "exit");
      const [ready] = await Promise.race([once(holder.stdout, "data"), exited.then(() => { throw new Error("Holder exited before opening the file"); })]);
      assert.equal(ready.toString().trim(), "ready");
      const diagnostic = mock.fn();
      await assert.rejects(cleanupWindowsJobRoot(root, { diagnostic }), error => error.code === "EPERM" || error.code === "EBUSY" || error.code === "EACCES");
      const lines = output({ diagnostic });
      const candidate = lines.split("\n").find(line => line.startsWith(`candidate path=${JSON.stringify(file)}`));
      assert.ok(candidate, lines);
      assert.equal(Date.parse(candidate.match(/created="([^"]+)"/)?.[1]), Math.trunc(birthtimeMs));
      assert.equal(Date.parse(candidate.match(/last-write="([^"]+)"/)?.[1]), +lastWrite);
      const holderLine = lines.split("\n").find(line => line.startsWith(`holder pid=${holder.pid} `));
      assert.ok(holderLine, lines);
      for (const detail of [`parent-pid=${process.pid}`, `image=${JSON.stringify(image)}`, `path=${JSON.stringify(file)}`]) {
        assert.ok(holderLine.includes(detail), holderLine);
      }
      assert.match(holderLine, /app="holder\.exe".*created="[\d:T.-]+Z"/i);
      assert.ok(lines.indexOf(candidate) < lines.indexOf(holderLine), lines);
      t.diagnostic(holderLine);
      holder.stdin.end("\n");
      const [code] = await exited;
      assert.equal(code, 0);
      await cleanupWindowsJobRoot(root);
      assert.equal(existsSync(root), false);
    } finally {
      if (holder && holder.exitCode === null) {
        holder.stdin.end("\n");
        await exited;
      }
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it("matches current directories and command arguments independently of the image path", { skip: process.platform !== "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-process-"));
    const fixtureCommand = "console.log('ready'); process.stdin.resume();";
    const children = [];
    async function start(cwd, ...args) {
      const child = spawn(process.execPath, ["-e", fixtureCommand, "--", ...args], { cwd, windowsHide: true, stdio: "pipe" });
      const exited = once(child, "exit");
      children.push({ child, exited });
      await Promise.race([once(child.stdout, "data"), exited.then(() => { throw new Error("Process fixture exited early"); })]);
      return child.pid;
    }
    try {
      const fromCwd = await start(root);
      const argument = join(root, "SYNTHETIC-PRIVATE");
      const fromArg = await start(tmpdir(), `--token=${argument}`);
      const nearMiss = await start(tmpdir(), `${root}-other\\outside.txt`, `${root}\\..\\outside.txt`);
      const diagnostic = mock.fn();
      await diagnoseJobRoot(root, diagnostic);
      const lines = output({ diagnostic }).split("\n");
      const lineFor = pid => lines.find(line => line.startsWith(`process pid=${pid} `));
      assert.doesNotMatch(lines.join("\n"), /SYNTHETIC-PRIVATE|--token/);
      assert.ok(lineFor(fromCwd)?.includes("match=cwd"), lines.join("\n"));
      assert.ok(lineFor(fromArg)?.includes("match=argument"), lines.join("\n"));
      assert.equal(lineFor(nearMiss), undefined, lines.join("\n"));
      assert.doesNotMatch(lines.join("\n"), /SYNTHETIC|--token|Cleanup process scan was incomplete/);
    } finally {
      for (const { child } of children) child.stdin.end();
      await Promise.all(children.map(({ exited }) => exited));
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("reports an old named suspect behind newer rows and matches", { skip: process.platform !== "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-job-process-priority-"));
    try {
      const run = runInjectedQuery(`
function Get-CimInstance($Class, $Property, $Filter) {
  $older = (Get-Process -Id ${process.pid}).StartTime
  $newer = [DateTime]::UtcNow
  $suspect = @{ ProcessId = 29999; ParentProcessId = ${process.pid}; Name = 'setup_wm.exe';
    ExecutablePath = 'C:\\Example\\setup_wm.exe'; CreationDate = $older }
  if ($Filter) { if ($Filter -match 'setup_wm') { $suspect }; return }
  foreach ($id in 30000..30539) {
    @{ ProcessId = $id; ParentProcessId = 0; ExecutablePath = ${powerShellLiteral(join(root, "example.exe"))};
      CreationDate = $newer }
  }
  $suspect
}
`);
      const diagnostic = mock.fn();
      await diagnoseJobRoot(root, diagnostic, run);
      const lines = output({ diagnostic });
      assert.match(lines, /suspect pid=29999.*parent-name="node\.exe".*name="setup_wm\.exe".*created="[\d:T.-]+Z"/);
      assert.ok(lines.indexOf("suspect pid=29999") < lines.indexOf("process pid="), lines);
      assert.match(lines, /Cleanup process scan reached its inspection or reporting limit/);
      assert.equal(lines.split("\n").filter(line => line.startsWith("process pid=")).length, 20);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  for (const [mode, action] of [["failed", "throw 'SYNTHETIC-PRIVATE'"], ["stalled", "Start-Sleep -Seconds 30"]]) {
    it(`keeps real file timestamps when the process scan ${mode}`, { skip: process.platform !== "win32" }, async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-job-process-incomplete-"));
      try {
        const file = join(root, "example.txt");
        const lastWrite = new Date("2026-01-02T03:04:05Z");
        writeFileSync(file, "fixture");
        utimesSync(file, lastWrite, lastWrite);
        const { birthtimeMs } = statSync(file);
        const error = blockedRemoval();
        const seams = cleanupSeams(error);
        seams.run = runInjectedQuery(`function Get-CimInstance($Class, $Property, $Filter) { ${action} }`);
        await assert.rejects(cleanupWindowsJobRoot(root, seams), caught => caught === error);
        const lines = output(seams);
        const candidate = lines.split("\n").find(line => line.startsWith(`candidate path=${JSON.stringify(file)} `));
        assert.ok(candidate, lines);
        assert.equal(Date.parse(candidate.match(/created="([^"]+)"/)?.[1]), Math.trunc(birthtimeMs));
        assert.equal(Date.parse(candidate.match(/last-write="([^"]+)"/)?.[1]), +lastWrite);
        assert.match(lines, /Cleanup process scan was incomplete|Cleanup diagnostic failed or timed out/);
        assert.doesNotMatch(lines, /SYNTHETIC-PRIVATE/);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});


describe("Windows job root query", () => {
  it("caps process and path counts and projects only requested fields", async () => {
    const diagnostic = mock.fn();
    const run = queryResult({
      processes: Array.from({ length: 25 }, (_, i) => ({
        ...PROCESS_DETAILS, pid: 4000 + i, CommandLine: "SYNTHETIC", env: { secret: "SYNTHETIC" },
      })),
      entries: Array.from({ length: 25 }, (_, i) => ({
        path: `C:\\fixture\\entry-${i}`, attributes: "ReadOnly, Hidden", owner: CURRENT_SID,
        created: "2026-01-02T03:04:05.0000000Z", lastWrite: "2026-01-02T03:04:06.0000000Z",
        deny: [{ sid: CURRENT_SID, rights: "Delete", note: "SYNTHETIC" }], denyOmitted: 2,
        parentDeny: [], parentDenyOmitted: 0, data: "SYNTHETIC",
      })),
      limited: true, processLimited: true,
    });
    await diagnoseJobRoot("C:\\fixture's", diagnostic, run);
    assert.equal(diagnostic.mock.callCount(), 42);
    assert.match(output({ diagnostic }), /process pid=4000 parent-pid=2000 image=.*holder\.exe/);
    assert.match(output({ diagnostic }), /candidate path=.*entry-19.*Delete.*\(\+2 more\).*parent-deny=\[\].*ReadOnly, Hidden.*handle="not determined"/);
    assert.match(output({ diagnostic }), /Cleanup path scan reached its inspection or reporting limit/);
    assert.match(output({ diagnostic }), /Cleanup process scan reached its inspection or reporting limit/);
    assert.doesNotMatch(output({ diagnostic }), /SYNTHETIC|secret|CommandLine|env|entry-20|pid=4020/);
    const [, , options] = run.mock.calls[0].arguments;
    const script = options.env[QUERY_VARIABLE];
    assert.ok(script.includes("$root = 'C:\\fixture''s'"));
    assert.match(script, /Get-CimInstance Win32_Process/);
    assert.match(script, /NtQueryDirectoryFile\(\$handle,/);
    assert.match(script, /NtQuerySecurityObject\(\$handle,/);
    assert.doesNotMatch(script, /Get-ChildItem|Set-Acl|SetAttributes|icacls|takeown|Stop-Process|Remove-Item|-Recurse|Environment/i);
  });
  it("reserves byte budget for Restart Manager output after long Unicode file rows", async () => {
    const diagnostic = mock.fn();
    const run = queryResult({
      entries: Array.from({ length: 20 }, (_, i) => ({
        path: `C:\\fixture\\${i}\\${"例".repeat(800)}`, attributes: "Archive", owner: null,
        deny: null, parentDeny: null, created: "2026-01-02T03:04:05.0000000Z", lastWrite: "2026-01-02T03:04:06.0000000Z",
      })),
      holders: [
        { kind: "restartManager", path: "C:\\fixture\\example.log", operation: "RmGetList", code: 234 },
        { ...PROCESS_DETAILS, kind: "holder", app: "holder.exe", service: "", path: "C:\\fixture\\example.txt" },
      ],
    });
    await diagnoseJobRoot("C:\\fixture", diagnostic, run);
    const lines = output({ diagnostic });
    assert.ok(Buffer.byteLength(lines) + 1 <= 64 * 1024);
    assert.match(lines, /candidate path=.*created="2026-01-02T03:04:05.0000000Z" last-write="2026-01-02T03:04:06.0000000Z"/);
    assert.match(lines, /Restart Manager lookup failed .*operation=RmGetList code=234/);
    assert.match(lines, /holder pid=4000.*app="holder\.exe"/);
    assert.match(lines, /Cleanup diagnostic output reached its byte limit/);
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
  it("rebuilds the child module path without changing other environment entries", async () => {
    const originalEnv = process.env;
    const expectedEnv = { ...originalEnv, AVE_JOB_ENV_SENTINEL: "preserved", AVE_JOB_ENV_EMPTY: "" };
    for (const key of Object.keys(expectedEnv)) if (/^psmodulepath$/i.test(key)) delete expectedEnv[key];
    const injectedEnv = {
      ...expectedEnv,
      PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
      psmodulepath: "C:\\Program Files\\PowerShell\\7\\Modules",
      PsMoDuLePaTh: "C:\\Program Files\\PowerShell\\7\\Modules",
    };
    process.env = injectedEnv;
    try {
      const harden = commandRunner(), query = queryResult();
      hardenWindowsJobRoot("C:\\ave-ci-abc123", harden);
      await diagnoseJobRoot("C:\\ave-ci-abc123", mock.fn(), query);
      for (const run of [harden, query]) {
        const calls = run.mock.calls.filter(call => call.arguments[0] === "powershell.exe");
        assert.equal(calls.length, 1);
        const options = calls[0].arguments[2];
        assert.ok(options.env);
        const { [QUERY_VARIABLE]: script, ...env } = options.env;
        assert.equal(typeof script, run === query ? "string" : "undefined");
        assert.deepEqual(env, expectedEnv);
        assert.equal(Object.keys(options.env).some(key => /^psmodulepath$/i.test(key)), false);
      }
      assert.equal(process.env, injectedEnv);
      assert.equal(process.env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
    } finally { process.env = originalEnv; }
  });

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
    const options = { encoding: "utf8", windowsHide: true, stdio: "pipe" };
    for (const call of run.mock.calls.slice(0, 3)) assert.deepEqual(call.arguments[2], options);
    assert.deepEqual(run.mock.calls[3].arguments[2], { ...options, env: windowsPowerShellEnv() });
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
        Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv() }));
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
