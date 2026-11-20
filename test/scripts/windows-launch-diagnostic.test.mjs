import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { maskJobRootArguments, processCwdProbe } from "../../.github/scripts/job-root-diagnostic.mjs";
import { createRecorder, processMatch, renderRunnerOutput } from "../../.github/scripts/watch-windows-processes.mjs";
import { windowsTestFileMarkers } from "../../.github/scripts/windows-test-file-markers.mjs";

const ROOT = "C:\\ave-ci-example";
const SCRIPTS = new URL("../../.github/scripts/", import.meta.url);
const WIN32_ONLY = { skip: process.platform !== "win32", timeout: 40_000 };
const run = promisify(execFile);

function time(second) {
  return `2026-01-02T03:04:${String(second).padStart(2, "0")}.0000000Z`;
}

function readLines(file) {
  return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "launch-diagnostic-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function waitForPath(path, timeout = 16_000) {
  const deadline = performance.now() + timeout;
  while (!existsSync(path) && performance.now() < deadline) await delay(50);
  assert.ok(existsSync(path), "Diagnostic synchronization file was not written");
}

function control(directory, scripts, command, env = process.env, grace = 2000) {
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const nodeArgs = command === "start" ? ["-NodeExecutable", process.execPath] : [];
  return run(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(scripts, "windows-launch-lifecycle.ps1"), command, directory, "-GraceMilliseconds", String(grace), ...nodeArgs], {
    cwd: directory, windowsHide: true, env, timeout: 25_000,
  });
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

describe("Windows launch diagnostic", () => {
  it("uses the cleanup argument matcher without changing unrelated text", () => {
    const input = 'tool --file="c:/AVE-ci-example/tmp/a.json" /out=\\\\?\\C:\\ave-ci-example\\b.txt C:\\ave-ci-example2\\keep xC:\\ave-ci-example /flag';
    assert.equal(maskJobRootArguments(input, ROOT),
      'tool --file="[job-root]" /out=[job-root] C:\\ave-ci-example2\\keep xC:\\ave-ci-example /flag');
    assert.equal(maskJobRootArguments(null, ROOT), null);
  });

  it("selects the media names and normalized job-root images and current directories", () => {
    for (const name of ["SETUP_WM.EXE", "unregmp2.exe", "wmplayer.exe", "wmpnscfg.exe", "wmpnetwk.exe"]) {
      assert.equal(processMatch({ name, image: null }, ROOT), "media");
    }
    assert.equal(processMatch({ image: "\\\\?\\c:\\AVE-ci-example\\tmp\\a.exe" }, ROOT), "image");
    assert.equal(processMatch({ image: "C:/ave-ci-example/tmp/../a.exe" }, ROOT), "image");
    assert.equal(processMatch({ image: "C:/ave-ci-example2/a.exe" }, ROOT), null);
    assert.equal(processMatch({ image: "C:/ave-ci-example/../other/a.exe" }, ROOT), null);
    assert.equal(processMatch({ image: "C:/other/a.exe", commandLine: ROOT }, ROOT), null);
    assert.equal(processMatch({ image: "C:/other/a.exe", cwd: ROOT }, ROOT), "cwd");
    assert.equal(processMatch({ image: "C:/other/a.exe", cwd: `${ROOT}-other` }, ROOT), null);
  });

  it("records only child facts when the reported parent pid is reused in polling and trace", t => {
    const directory = fixture(t);
    const { record } = createRecorder(ROOT, directory);
    const departed = { pid: 20, parentPid: 10, created: time(7), name: "departed.exe" };
    const replacement = { ...departed, name: "replacement.exe" };
    const child = {
      pid: 30, parentPid: 20, created: time(3), name: "setup_wm.exe", commandLine: `setup_wm "${ROOT}\\log"`,
    };
    record({ kind: "baseline", rows: [departed] });
    record({ kind: "snapshot", rows: [departed] });
    record({ kind: "snapshot", rows: [replacement, child] });
    record({ kind: "snapshot", rows: [replacement, child] });
    record({ kind: "trace", rows: [{ ...child, eventTime: time(6) }, replacement] });
    const expected = {
      kind: "start", match: "media", pid: 30, created: time(3), eventTime: null,
      image: "setup_wm.exe", commandLine: 'setup_wm "[job-root]"', cwdStatus: "unavailable", unresolvedParentPid: 20,
    };
    assert.deepEqual(readLines(join(directory, "media-starts.jsonl")), [expected, { ...expected, eventTime: time(6) }]);
  });

  it("keeps the trace time when the child has already exited", t => {
    const directory = fixture(t);
    const { record } = createRecorder(ROOT, directory);
    record({ kind: "trace", rows: [{ pid: 30, parentPid: 0, eventTime: time(4), name: "unregmp2.exe" }] });
    assert.deepEqual(readLines(join(directory, "media-starts.jsonl")), [{
      kind: "start", match: "media", pid: 30, created: null, eventTime: time(4),
      image: "unregmp2.exe", commandLine: null, cwdStatus: "unavailable", unresolvedParentPid: 0,
    }]);
  });

  it("renders command-like process arguments inert while preserving their JSON value", () => {
    const row = { commandLine: 'program "::stop-commands::token" "##[error]message" "::token::"\nfragment' };
    const rendered = renderRunnerOutput(`${JSON.stringify(row)}\n`);
    assert.doesNotMatch(rendered, /::|##\[/u);
    assert.deepEqual(JSON.parse(rendered), row);
  });

  it("records compact starts for all images up to a reported row limit", t => {
    const directory = fixture(t);
    const { record } = createRecorder(ROOT, directory, { rawStartLimit: 2 });
    const row = { pid: 30, parentPid: 20, eventTime: time(4), name: "outside.exe" };
    for (let offset = 0; offset < 4; offset++) {
      record({ kind: "raw-start", ...row, pid: row.pid + offset, image: "C:/other/outside.exe", commandLine: "private" });
    }
    record({ kind: "trace", rows: [{ ...row, image: `${ROOT}\\target.exe`, commandLine: `target "${ROOT}"` }] });
    assert.deepEqual(readLines(join(directory, "raw-starts.jsonl")), [row, { ...row, pid: 31 }]);
    assert.deepEqual(readLines(join(directory, "watcher.jsonl")), [{ kind: "raw-start-limit", maxRows: 2 }]);
    const [full] = readLines(join(directory, "job-root-starts.jsonl"));
    assert.equal(full.commandLine, 'target "[job-root]"');
  });

  it("prints escaped ancestor facts and bounded preceding starts for each media start", async t => {
    const directory = fixture(t);
    const { record } = createRecorder(ROOT, directory);
    const parent = {
      pid: 20, name: "parent.exe", image: "C:/other/parent.exe", created: time(9),
      commandLine: `parent "${ROOT}" "::stop-commands::example" "##[error]" ${"x".repeat(2048)}`,
      parentCreatedBeforeChild: true,
    };
    const replacement = { ...parent, pid: 10, created: time(11), parentCreatedBeforeChild: false };
    for (const [pid, eventTime] of [[10, time(4)], [11, time(5)], [12, time(9)], [13, time(10)], [14, time(11)]]) {
      record({ kind: "raw-start", pid, eventTime, parentPid: 1, name: "outside.exe" });
    }
    for (let pid = 100; pid < 140; pid++) {
      record({ kind: "raw-start", pid, eventTime: time(9), parentPid: 1, name: "outside.exe" });
    }
    // An older start can arrive later than another event.
    record({ kind: "raw-start", pid: 20, eventTime: time(8), parentPid: 10, name: parent.name });
    for (const [pid, eventTime] of [[30, time(10)], [31, time(15)]]) {
      record({ kind: "trace", rows: [{
        pid, parentPid: parent.pid, eventTime, created: eventTime, name: "setup_wm.exe",
        ancestry: [parent, replacement], ancestryTimeBasis: "child-creation", ancestryStatus: "parent-not-older",
      }] });
    }
    const file = join(directory, "media-starts.jsonl");
    assert.doesNotMatch(readFileSync(file, "utf8"), /::|##\[/u);
    const [media] = readLines(file);
    assert.equal(media.ancestry[0].commandLine.length, 2048);
    assert.match(media.ancestry[0].commandLine, /\[job-root\].*::stop-commands::example.*##\[error\]/u);
    assert.equal(media.ancestry[1].parentCreatedBeforeChild, false);
    const script = fileURLToPath(new URL("watch-windows-processes.mjs", SCRIPTS));
    const { stdout } = await run(process.execPath, [script, "print", directory], { cwd: directory, windowsHide: true });
    assert.doesNotMatch(stdout, /::|##\[/u);
    const rows = stdout.split(/\r?\n/u).filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    const starts = rows.filter(row => row.kind === "start");
    assert.deepEqual(starts.map(row => row.pid), [30, 31]);
    assert.deepEqual(starts[0].ancestry, media.ancestry);
    const windows = rows.filter(row => row.kind === "preceding-starts");
    assert.deepEqual(windows.map(row => row.pid), [30, 31]);
    assert.equal(windows[0].starts.length, 32);
    assert.equal(windows[0].omitted, 11);
    assert.ok(windows[0].starts.every(row => row.eventTime === time(9)));
    assert.deepEqual(windows[1].starts.map(row => row.pid), [13, 14]);
    assert.equal(windows[1].omitted, 0);
  });

  it("launches the watcher with the job's executable when PATH contains multiple node.exe files", WIN32_ONLY, async t => {
    const directory = fixture(t);
    const scripts = join(directory, "scripts");
    mkdirSync(scripts);
    copyFileSync(new URL("windows-launch-lifecycle.ps1", SCRIPTS), join(scripts, "windows-launch-lifecycle.ps1"));
    const nodeDirectories = ["first node", "second node"].map(name => join(directory, name));
    for (const path of nodeDirectories) {
      mkdirSync(path);
      copyFileSync(process.execPath, join(path, "node.exe"));
    }
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === "path") ?? "Path";
    const env = { ...process.env, [pathKey]: [...nodeDirectories, process.env[pathKey]].join(delimiter) };
    writeFileSync(join(scripts, "watch-windows-processes.mjs"), [
      'import { existsSync, writeFileSync } from "node:fs";',
      'writeFileSync("watcher-executable", process.execPath);',
      'writeFileSync("watcher.ready", "");',
      'const timer = setInterval(() => { if (existsSync("watcher.stop")) clearInterval(timer); }, 40);',
    ].join("\n"));
    writeFileSync(join(scripts, "watch-windows-processes.ps1"),
      "while (!(Test-Path -LiteralPath 'watcher.stop')) { Start-Sleep -Milliseconds 40 }");
    try {
      await control(directory, scripts, "start", env);
      assert.equal(readFileSync(join(directory, "watcher-executable"), "utf8"), process.execPath);
    } finally {
      if (existsSync(join(directory, "watcher-ownership.json"))) {
        const { stdout } = await control(directory, scripts, "stop");
        assert.match(stdout, /collector and watcher exits verified/);
      }
    }
  });

  for (const stall of [
    "before readiness", "during stop", "with a blocked stop signal", "when the graceful wait throws",
    "with an exclusively locked manifest", "with an exclusively locked ownership file",
  ]) {
    it(`verifies and forces both diagnostic exits for a stall ${stall}`, WIN32_ONLY, async t => {
      const directory = fixture(t);
      const scripts = join(directory, "scripts");
      mkdirSync(scripts);
      const controller = readFileSync(new URL("windows-launch-lifecycle.ps1", SCRIPTS), "utf8");
      const waitFailure = stall === "when the graceful wait throws";
      const gracefulWait = "function Wait-ForExit($processes, $timeout) {";
      assert.ok(controller.includes(gracefulWait));
      writeFileSync(join(scripts, "windows-launch-lifecycle.ps1"), waitFailure ? controller.replace(gracefulWait,
        `${gracefulWait}\n  if ($timeout -eq 325) { throw 'Synthetic graceful wait failure' }`) : controller);
      const blockedSignal = stall === "with a blocked stop signal";
      const stopPath = join(directory, "watcher.stop");
      const prepared = stall !== "before readiness";
      const ownership = "watcher-ownership.json";
      const lockFile = stall === "with an exclusively locked manifest" ? "watcher-processes.json" :
        stall === "with an exclusively locked ownership file" ? ownership : null;
      writeFileSync(join(scripts, "watch-windows-processes.mjs"), [
        'import { existsSync, writeFileSync } from "node:fs";',
        'writeFileSync("watcher.pid", String(process.pid));',
        prepared ? 'writeFileSync("watcher.ready", "");' : "",
        'setInterval(() => {',
        '  if (existsSync("watcher.stop")) writeFileSync("watcher.stopping", "");',
        '}, 40);',
      ].join("\n"));
      writeFileSync(join(scripts, "watch-windows-processes.ps1"), [
        "[IO.File]::WriteAllText((Join-Path (Get-Location) 'collector.pid'), [string]$PID)",
        ...(lockFile ? [
          "while (![IO.File]::Exists('lock.request')) { Start-Sleep -Milliseconds 40 }",
          `$lock = [IO.File]::Open('${lockFile}', 'OpenOrCreate', 'ReadWrite', 'None')`,
          "try {",
          "  [IO.File]::WriteAllText('lock.held', '')",
          "  while (![IO.File]::Exists('lock.release')) { Start-Sleep -Milliseconds 40 }",
          "} finally { $lock.Dispose() }",
          "[IO.File]::WriteAllText('lock.released', '')",
        ] : []),
        'while ($true) {',
        "  if (Test-Path -LiteralPath 'watcher.stop') { [IO.File]::WriteAllText((Join-Path (Get-Location) 'collector.stopping'), '') }",
        '  Start-Sleep -Milliseconds 40',
        '}',
      ].join("\n"));
      const output = join(directory, "step-output");
      const starting = control(directory, scripts, "start", { ...process.env, GITHUB_OUTPUT: output });
      starting.catch(() => {});
      const pids = [];
      let stopEnv = process.env;
      try {
        if (prepared) await starting;
        else await waitForPath(join(directory, ownership));
        assert.equal(existsSync(join(directory, "watcher.ready")), prepared);
        for (const role of ["watcher", "collector"]) {
          const file = join(directory, `${role}.pid`);
          await waitForPath(file);
          pids.push(Number(readFileSync(file, "utf8")));
        }
        assert.ok(pids.every(pid => pid > 0 && isAlive(pid)));
        if (lockFile === ownership) {
          const match = readFileSync(output, "utf8").match(/^ownership=(.+)$/m);
          assert.ok(match);
          stopEnv = { ...process.env, AVE_PROCESS_WATCH_OWNERSHIP: match[1] };
        }
        if (lockFile) {
          writeFileSync(join(directory, "lock.request"), "");
          await waitForPath(join(directory, "lock.held"));
          assert.throws(() => readFileSync(join(directory, lockFile)));
        }
        if (blockedSignal) mkdirSync(stopPath);
        const { stdout } = await control(directory, scripts, "stop", stopEnv, waitFailure ? 325 : 2000);
        if (blockedSignal) assert.match(stdout, /Could not signal diagnostic stop/);
        if (waitFailure) assert.match(stdout, /Diagnostic graceful wait failed/);
        assert.deepEqual(pids.map(isAlive), [false, false], stdout);
        assert.equal((stdout.match(/Forced diagnostic process exit/g) ?? []).length, 2, stdout);
        assert.match(stdout, /collector and watcher exits verified/);
        if (lockFile) assert.equal(existsSync(join(directory, "lock.released")), false);
        if (!lockFile && !blockedSignal && !waitFailure) {
          assert.ok(existsSync(join(directory, "collector.stopping")));
          assert.ok(existsSync(join(directory, "watcher.stopping")));
        }
      } finally {
        if (blockedSignal && existsSync(stopPath)) rmdirSync(stopPath);
        await starting;
        if (pids.length !== 2 || pids.some(isAlive)) {
          if (lockFile && existsSync(join(directory, "lock.held")) && isAlive(pids[1])) {
            writeFileSync(join(directory, "lock.release"), "");
            await waitForPath(join(directory, "lock.released"));
          }
          await control(directory, scripts, "stop", stopEnv);
        }
      }
    });
  }

  it("observes short-lived image and cwd targets using scoped native polling without naming a parent", WIN32_ONLY, async t => {
    const directory = fixture(t);
    const root = join(directory, "job");
    mkdirSync(root);
    const systemImage = join(process.env.SystemRoot, "System32", "ping.exe");
    const image = join(root, "child.exe");
    copyFileSync(systemImage, image);
    writeFileSync(join(directory, "cwd-probe.ps1"), processCwdProbe);
    const scripts = fileURLToPath(SCRIPTS);
    const env = {
      ...process.env, AVE_CI_JOB_ROOT: root, AVE_PROCESS_WATCH_PARENT: String(process.pid),
      AVE_PROCESS_WATCH_TRACE: "",
    };
    try {
      await control(directory, scripts, "start", env);
      assert.ok(existsSync(join(directory, "watcher.ready")), "Polling did not finish its initial snapshot");
      const children = [image, systemImage].map(file => spawn(file, ["-n", "5", "127.0.0.1"], {
        cwd: root, windowsHide: true, stdio: "ignore",
      }));
      const exits = await Promise.all(children.map(child => once(child, "exit")));
      assert.deepEqual(exits, [[0, null], [0, null]]);
      await waitForPath(join(directory, "job-root-starts.jsonl"));
      const records = readLines(join(directory, "job-root-starts.jsonl"));
      for (const [index, child] of children.entries()) {
        const record = records.find(row => row.pid === child.pid);
        assert.ok(record, "Child did not appear in the diagnostic");
        assert.equal(record.match, index === 0 ? "image" : "cwd");
        assert.equal(record.cwdStatus, "read");
        assert.equal(record.unresolvedParentPid, process.pid);
        assert.equal("parentPid" in record, false);
        assert.equal("ancestry" in record, false);
        assert.equal(record.image.toLowerCase(), (index === 0 ? image : systemImage).toLowerCase());
        if (index === 0) assert.match(record.commandLine, /\[job-root\]/);
      }
    } finally {
      const { stdout } = await control(directory, scripts, "stop");
      assert.match(stdout, /collector and watcher exits verified/);
      assert.doesNotMatch(stdout, /Forced diagnostic process exit/);
    }
    const log = readLines(join(directory, "watcher.jsonl"));
    assert.deepEqual(log[0], {
      kind: "mechanism", mechanism: "polling", jobRootMatch: "image path or current directory",
    });
    assert.equal(log.at(-1).kind, "stopped");
  });

  it("traces a media setup start and its live parent outside the job root", WIN32_ONLY, async t => {
    const directory = fixture(t);
    const root = join(directory, "job");
    mkdirSync(root);
    const image = join(directory, "setup_wm.exe");
    copyFileSync(join(process.env.SystemRoot, "System32", "ping.exe"), image);
    const scripts = join(directory, ".github", "scripts");
    const lib = join(directory, "scripts", "lib");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(lib, { recursive: true });
    for (const file of ["windows-launch-lifecycle.ps1", "watch-windows-processes.mjs", "job-root-diagnostic.mjs"]) {
      copyFileSync(new URL(file, SCRIPTS), join(scripts, file));
    }
    copyFileSync(new URL("../../scripts/lib/windows-powershell-env.mjs", SCRIPTS), join(lib, "windows-powershell-env.mjs"));
    const collector = readFileSync(new URL("watch-windows-processes.ps1", SCRIPTS), "utf8");
    // Supply trace events without CIM subscription privileges. The collector still queries the live processes.
    writeFileSync(join(scripts, "watch-windows-processes.ps1"), [
      "function Register-CimIndicationEvent {}",
      "function Get-Event {",
      "  if ([IO.File]::Exists('trace-events.json')) {",
      "    $events = [IO.File]::ReadAllText('trace-events.json') | ConvertFrom-Json",
      "    [IO.File]::Delete('trace-events.json')",
      "    $script:fixtureEvents = @(for ($i = 0; $i -lt $events.Length; $i++) {",
      "      $event = $events[$i]",
      "      $event.TIME_CREATED = [DateTime]::UtcNow.AddSeconds(-$event.AgeSeconds).ToFileTimeUtc()",
      "      @{ EventIdentifier = $i; SourceEventArgs = @{ NewEvent = $event } }",
      "    })",
      "  } elseif ($null -ne $script:fixtureEvents -and $script:fixtureEvents.Length -eq 0) {",
      "    [IO.File]::WriteAllText('trace-drained', '')",
      "    $script:fixtureEvents = $null",
      "  }",
      "  $script:fixtureEvents",
      "}",
      "function Remove-Event($EventIdentifier) {",
      "  $script:fixtureEvents = @($script:fixtureEvents | Where-Object { $_.EventIdentifier -ne $EventIdentifier })",
      "}",
      collector,
    ].join("\n"));
    const env = {
      ...process.env, AVE_CI_JOB_ROOT: root, AVE_PROCESS_WATCH_PARENT: String(process.pid),
      AVE_PROCESS_WATCH_TRACE: "1", GITHUB_ACTIONS: "true",
    };
    let parent;
    let childPid = "";
    try {
      await control(directory, scripts, "start", env);
      const log = readLines(join(directory, "watcher.jsonl"));
      assert.equal(log.find(row => row.kind === "mechanism")?.mechanism, "Win32_ProcessStartTrace");
      parent = spawn(process.execPath, ["-e", [
        'const { spawn } = require("node:child_process");',
        'const { renameSync, writeFileSync } = require("node:fs");',
        'const child = spawn(process.argv[1], ["-n", "5", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });',
        'const event = (ProcessID, ParentProcessID, ProcessName, AgeSeconds = 0) =>',
        '  ({ ProcessID, ParentProcessID, ProcessName, AgeSeconds, TIME_CREATED: 0 });',
        'writeFileSync("trace-events.tmp", JSON.stringify([event(process.pid, process.ppid, "node.exe"),',
        '  event(child.pid, process.pid, "setup_wm.exe"), event(0, process.ppid, "setup_wm.exe", 3600),',
        '  event(0, 4294967295, "wmpnetwk.exe")]));',
        'renameSync("trace-events.tmp", "trace-events.json");',
        'process.stdout.write(String(child.pid));',
        'child.on("exit", code => { process.exitCode = code ?? 1; });',
      ].join(" "), image, "fixture::token", "##[example]"], {
        cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      parent.stdout.on("data", chunk => { childPid += chunk; });
      const [code, signal] = await once(parent, "close");
      assert.deepEqual([code, signal], [0, null]);
      await waitForPath(join(directory, "trace-drained"));
    } finally {
      const { stdout } = await control(directory, scripts, "stop");
      assert.match(stdout, /collector and watcher exits verified/);
      assert.doesNotMatch(stdout, /Forced diagnostic process exit/);
    }
    const rows = readLines(join(directory, "media-starts.jsonl"));
    const media = rows.find(row => row.pid === Number(childPid));
    assert.ok(media);
    assert.equal(media.match, "media");
    assert.equal(media.image.toLowerCase(), image.toLowerCase());
    assert.equal(media.ancestryTimeBasis, "child-creation");
    assert.ok(media.ancestry.length <= 6);
    const [link] = media.ancestry;
    assert.equal(link.pid, parent.pid);
    assert.equal(link.name.toLowerCase(), "node.exe");
    assert.equal(link.image.toLowerCase(), process.execPath.toLowerCase());
    assert.match(link.commandLine, /fixture::token.*##\[example\]/u);
    assert.ok(Date.parse(link.created) <= Date.parse(media.created));
    assert.equal(link.parentCreatedBeforeChild, true);
    const [later, missing] = rows.filter(row => row.pid === 0);
    assert.equal(later.ancestryTimeBasis, "start-event");
    assert.equal(later.ancestryStatus, "parent-not-older");
    assert.deepEqual(later.ancestry.map(({ pid, parentCreatedBeforeChild }) => [pid, parentCreatedBeforeChild]), [[process.pid, false]]);
    assert.equal(missing.ancestryStatus, "parent-unavailable");
    assert.deepEqual(missing.ancestry, [{
      pid: 4294967295, name: null, created: null, image: null, commandLine: null, parentCreatedBeforeChild: false,
    }]);
    const starts = readLines(join(directory, "raw-starts.jsonl"));
    const compact = starts.find(row => row.pid === parent.pid);
    assert.ok(Number.isFinite(Date.parse(compact?.eventTime)));
    assert.deepEqual(compact, { pid: parent.pid, parentPid: process.pid, name: link.name, eventTime: compact.eventTime });
    assert.equal(starts.find(row => row.pid === media.pid)?.parentPid, parent.pid);
  });
});

describe("Windows test file markers", () => {
  it("requires hosted Windows and writes queue receipt and execution phases in UTC", t => {
    const directory = fixture(t);
    const enabled = { GITHUB_ACTIONS: "true", RUNNER_TEMP: directory, AVE_CI_WINDOWS_TEST_FILE_MARKERS: "1" };
    assert.equal(windowsTestFileMarkers(enabled, "linux"), undefined);
    for (const flag of Object.keys(enabled)) {
      assert.equal(windowsTestFileMarkers({ ...enabled, [flag]: undefined }, "win32"), undefined);
    }
    const reporter = windowsTestFileMarkers(enabled, "win32");
    const module = {
      project: { config: { root: directory } },
      moduleId: join(directory, "test", "probe.test.ts"),
    };
    reporter.onTestModuleQueued(module);
    reporter.onTestModuleStart(module);
    reporter.onTestModuleEnd(module);
    const lines = readLines(join(directory, "windows-launch-diagnostic", "test-files.jsonl"));
    assert.deepEqual(lines.map(line => [line.phase, line.file]), [
      ["queued-host-receipt", "test/probe.test.ts"],
      ["execution-start", "test/probe.test.ts"],
      ["execution-finish", "test/probe.test.ts"],
    ]);
    assert.ok(lines.every(line => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(line.time)));
    assert.deepEqual(lines.map(line => line.time), lines.map(line => line.time).sort());
  });

  it("labels a delayed queue receipt even when module import already launched a process", async t => {
    const directory = fixture(t);
    const moduleId = join(directory, "probe.mjs");
    const launched = join(directory, "top-level-launch");
    const args = ["-e", 'require("node:fs").writeFileSync(process.argv[1], "")', launched];
    writeFileSync(moduleId, [
      'import { execFileSync } from "node:child_process";',
      `execFileSync(process.execPath, ${JSON.stringify(args)}, { windowsHide: true, timeout: 5000 });`,
    ].join("\n"));
    const reporter = windowsTestFileMarkers({
      GITHUB_ACTIONS: "true", RUNNER_TEMP: directory, AVE_CI_WINDOWS_TEST_FILE_MARKERS: "1",
    }, "win32");
    const receiveQueue = () => reporter.onTestModuleQueued({ project: { config: { root: directory } }, moduleId });
    await import(pathToFileURL(moduleId).href);
    assert.ok(existsSync(launched));
    receiveQueue();
    const [marker] = readLines(join(directory, "windows-launch-diagnostic", "test-files.jsonl"));
    assert.equal(marker.phase, "queued-host-receipt");
    assert.match(marker.ordering, /may follow module import and top-level execution/);
  });

  it("leaves the test outcome alone when the marker directory is unavailable", t => {
    const directory = fixture(t);
    writeFileSync(join(directory, "windows-launch-diagnostic"), "");
    const reporter = windowsTestFileMarkers({
      GITHUB_ACTIONS: "true", RUNNER_TEMP: directory, AVE_CI_WINDOWS_TEST_FILE_MARKERS: "1",
    }, "win32");
    const module = { project: { config: { root: directory } }, moduleId: join(directory, "probe.test.ts") };
    assert.doesNotThrow(() => reporter.onTestModuleQueued(module));
    assert.doesNotThrow(() => reporter.onTestModuleStart(module));
    assert.doesNotThrow(() => reporter.onTestModuleEnd(module));
  });
});
