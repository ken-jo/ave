import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
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

async function collectTrace(t, fixtureScript, onRecord = () => {}) {
  const directory = fixture(t);
  const pipe = `\\\\.\\pipe\\ave-trace-${process.pid}-${directory.split("\\").at(-1)}`;
  const transcript = Promise.withResolvers();
  const records = [];
  const server = createServer(socket => {
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", line => {
      const row = { ...JSON.parse(line), received: performance.now() };
      records.push(row);
      onRecord(row, directory);
    });
    lines.on("close", transcript.resolve);
  });
  server.listen(pipe);
  await once(server, "listening");
  t.after(() => promisify(server.close.bind(server))());
  const script = join(directory, "collector.ps1");
  writeFileSync(script, [
    "function Register-CimIndicationEvent {}",
    "function Unregister-Event {}",
    "function Remove-Event($EventIdentifier) {",
    "  $script:fixtureEvents = @($script:fixtureEvents | Where-Object { $_.EventIdentifier -ne $EventIdentifier })",
    "}",
    "function New-Start($id, $name, $parentId = 0, $time = [DateTime]::UtcNow) {",
    "  @{ EventIdentifier = $id; SourceEventArgs = @{ NewEvent = @{ ProcessID = $id; ParentProcessID = $parentId;",
    "    ProcessName = $name; TIME_CREATED = $time.ToFileTimeUtc() } } }",
    "}",
    ...fixtureScript,
    readFileSync(new URL("watch-windows-processes.ps1", SCRIPTS), "utf8"),
  ].join("\n"));
  writeFileSync(join(directory, "watcher-ownership.json"), "{}");
  const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  await run(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
    cwd: directory, windowsHide: true, timeout: 25_000,
    env: { ...process.env, GITHUB_ACTIONS: "true", AVE_PROCESS_WATCH_TRACE: "1", AVE_PROCESS_WATCH_PIPE: pipe },
  });
  await transcript.promise;
  return { directory, records };
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
      ancestryTimeBasis: null, ancestryStatus: "trace-unavailable", ancestry: [],
    };
    assert.deepEqual(readLines(join(directory, "media-starts.jsonl")), [expected, { ...expected, eventTime: time(6) }]);
  });

  it("keeps the trace time when the child has already exited", t => {
    const directory = fixture(t);
    const { record } = createRecorder(ROOT, directory);
    record({ kind: "trace", rows: [{
      pid: 30, parentPid: 0, eventTime: time(4), name: "unregmp2.exe",
      ancestryTimeBasis: "start-event", ancestryStatus: "root", ancestry: [],
    }] });
    assert.deepEqual(readLines(join(directory, "media-starts.jsonl")), [{
      kind: "start", match: "media", pid: 30, created: null, eventTime: time(4),
      image: "unregmp2.exe", commandLine: null, cwdStatus: "unavailable", unresolvedParentPid: 0,
      ancestryTimeBasis: "start-event", ancestryStatus: "root", ancestry: [],
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
    record({ kind: "stopped" });
    assert.deepEqual(readLines(join(directory, "raw-starts.jsonl")), [row, { ...row, pid: 31 }]);
    assert.deepEqual(readLines(join(directory, "watcher.jsonl")), [
      { kind: "raw-start-limit", maxRows: 2 },
      { kind: "dropped", count: 2, reason: "raw-output-limit" },
      { kind: "stopped" },
    ]);
    const [full] = readLines(join(directory, "job-root-starts.jsonl"));
    assert.equal(full.commandLine, 'target "[job-root]"');
  });

  it("records media context separately from raw process starts", async t => {
    const directory = fixture(t);
    const { record } = createRecorder(ROOT, directory);
    const start = { pid: 31, parentPid: 20, eventTime: time(3), name: "node.exe" };
    const commandLine = `node "${ROOT}\\example" "##[error]"`;
    const live = { pid: 31, parentPid: 20, created: time(3), image: "C:/tools/node.exe", commandLine };
    record({ kind: "raw-start", ...start });
    record({ kind: "media-context", pid: 32, eventTime: time(5), enriched: 1, unavailable: 0,
      starts: [live], stepProcesses: [live] });
    assert.deepEqual(readLines(join(directory, "raw-starts.jsonl")), [start]);
    const file = join(directory, "media-context.jsonl");
    assert.doesNotMatch(readFileSync(file, "utf8"), /##\[/u);
    const [context] = readLines(file);
    assert.deepEqual(context.starts, [{ ...live, commandLine: 'node "[job-root]" "##[error]"' }]);
    assert.deepEqual(context.stepProcesses, context.starts);
    const script = fileURLToPath(new URL("watch-windows-processes.mjs", SCRIPTS));
    const { stdout } = await run(process.execPath, [script, "print", directory], { cwd: directory, windowsHide: true });
    assert.match(stdout, /media-context\.jsonl/u);
    assert.doesNotMatch(stdout, /##\[/u);
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

  for (const [name, eventArgs] of [
    ["a missing event", "@{ NewEvent = $null }"],
    ["a subscription exception", "@{ Exception = [TimeoutException]::new() }"],
    ["an invalid process start", "@{ NewEvent = @{ ProcessID = 0; ParentProcessID = 0; TIME_CREATED = 0 } }"],
  ]) {
    it(`ends the trace and takes a polling snapshot after ${name}`, WIN32_ONLY, async t => {
      const directory = fixture(t);
      const pipe = `\\\\.\\pipe\\ave-trace-${process.pid}-${directory.split("\\").at(-1)}`;
      const transcript = Promise.withResolvers();
      const server = createServer(socket => {
        socket.setEncoding("utf8");
        let buffered = "";
        socket.on("data", chunk => { buffered += chunk; });
        socket.on("end", () => transcript.resolve(buffered));
      });
      server.listen(pipe);
      await once(server, "listening");
      t.after(() => promisify(server.close.bind(server))());

      const script = join(directory, "collector.ps1");
      writeFileSync(script, [
        "function Register-CimIndicationEvent($ClassName, $SourceIdentifier, $OperationTimeoutSec) {",
        "  [IO.File]::WriteAllText('operation-timeout', [string]$OperationTimeoutSec)",
        "}",
        "function Wait-Event {}",
        "function Remove-Event {}",
        "function Get-CimInstance {",
        "  if ($mechanism -eq 'polling' -and $script:sent) {",
        "    [IO.File]::WriteAllText($stop, '')",
        "    @{ ProcessId = 104; ParentProcessId = 10; Name = 'polling.exe'; CreationDate = [DateTime]::UtcNow }",
        "  }",
        "}",
        "function Get-Event {",
        "  if ($script:sent) { return }",
        "  $script:sent = $true",
        "  $processEvent = @{ ProcessID = 101; ParentProcessID = 10; ProcessName = 'fixture.exe'; TIME_CREATED = [DateTime]::UtcNow.ToFileTimeUtc() }",
        "  @{ EventIdentifier = 1; SourceEventArgs = @{ NewEvent = $processEvent } }",
        `  @{ EventIdentifier = 2; SourceEventArgs = ${eventArgs} }`,
        "  $processEvent = $processEvent.Clone()",
        "  $processEvent.ProcessID = 102",
        "  @{ EventIdentifier = 3; SourceEventArgs = @{ NewEvent = $processEvent } }",
        "}",
        readFileSync(new URL("watch-windows-processes.ps1", SCRIPTS), "utf8"),
      ].join("\n"));
      writeFileSync(join(directory, "watcher-ownership.json"), "{}");
      const executable = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      await run(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
        cwd: directory, windowsHide: true, timeout: 25_000,
        env: { ...process.env, GITHUB_ACTIONS: "true", AVE_PROCESS_WATCH_TRACE: "1", AVE_PROCESS_WATCH_PIPE: pipe },
      });

      const records = (await transcript.promise).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(records.filter(row => row.kind === "raw-start").map(row => row.pid), [101, 102]);
      assert.deepEqual(records.filter(row => row.kind === "dropped"),
        name === "a subscription exception" ? [] : [{ kind: "dropped", count: 1, reason: "invalid-start-event" }]);
      const ended = records.findIndex(row => row.kind === "trace-ended");
      assert.ok(ended > records.findLastIndex(row => row.kind === "raw-start"));
      assert.equal(records[ended + 1]?.mechanism, "polling");
      assert.deepEqual(records.find(row => row.kind === "snapshot")?.rows.map(row => row.pid), [104]);
      assert.equal(records.at(-1)?.kind, "stopped");
      assert.equal(readFileSync(join(directory, "operation-timeout"), "utf8"), "");
    });
  }

  it("writes a mixed burst in queue order and only looks up the media start", WIN32_ONLY, async t => {
    const { directory, records } = await collectTrace(t, [
      "[IO.File]::WriteAllText('cwd-probe.ps1', 'function ReadCurrentDirectory($id, $expectedCreation) { ''fixture-cwd'' }')",
      "function Get-CimInstance($Filter) {",
      "  if ($Filter) {",
      "    [IO.File]::AppendAllText('lookups', $Filter + [Environment]::NewLine)",
      "    if ($Filter -eq 'ProcessId = 132') {",
      "      @{ ProcessId = 132; ParentProcessId = 0; Name = 'setup_wm.exe'; CreationDate = [DateTime]::UtcNow.AddSeconds(-1) }",
      "    }",
      "  }",
      "}",
      "function Wait-Event {}",
      "function Get-Event {",
      "  if (!$script:sent) {",
      "    $script:sent = $true",
      "    $script:fixtureEvents = @(100..195 | ForEach-Object {",
      "      New-Start $_ $(if ($_ -eq 132) { 'setup_wm.exe' } else { 'ordinary.exe' })",
      "    })",
      "  } elseif (!$script:fixtureEvents.Count) { [IO.File]::WriteAllText($stop, '') }",
      "  $script:fixtureEvents",
      "}",
    ]);
    const lookups = readFileSync(join(directory, "lookups"), "utf8").trim().split(/\r?\n/u);
    const starts = records.filter(row => row.kind === "raw-start").map(row => row.pid);
    t.diagnostic(`${starts.length} raw starts, ${lookups.length} live lookup(s)`);
    assert.equal(lookups.length, 1, "Expected one media live lookup");
    assert.deepEqual(lookups, ["ProcessId = 132"]);
    assert.deepEqual(starts, Array.from({ length: 96 }, (_, index) => index + 100));
    const media = records.filter(row => row.kind === "trace").map(row => row.rows[0]);
    assert.equal(media.length, 1);
    assert.equal(media[0].pid, 132);
    assert.equal(media[0].ancestryTimeBasis, "child-creation");
    assert.equal(media[0].ancestryStatus, "root");
    assert.equal(media[0].cwd, "fixture-cwd");
    assert.equal(media[0].cwdStatus, "read");
    assert.equal(records.at(-1)?.kind, "stopped");
  });

  it("drains the entire queued backlog in order on stop", WIN32_ONLY, async t => {
    const { records } = await collectTrace(t, [
      "function Get-CimInstance {}",
      "function Wait-Event { [IO.File]::WriteAllText($stop, '') }",
      "function Get-Event {",
      "  if (!$script:sent) { $script:sent = $true; return }",
      "  if (!$script:fixtureEvents) {",
      "    if ($script:queued) { return }",
      "    $script:queued = $true",
      "    $script:fixtureEvents = @(100..195 | ForEach-Object { New-Start $_ 'ordinary.exe' })",
      "  }",
      "  $script:fixtureEvents",
      "}",
    ]);
    const starts = records.filter(row => row.kind === "raw-start").map(row => row.pid);
    t.diagnostic(`${starts.length} raw starts drained`);
    assert.equal(starts.length, 96);
    assert.deepEqual(starts, Array.from({ length: 96 }, (_, index) => index + 100));
    assert.equal(records.some(row => row.kind === "dropped"), false);
    assert.equal(records.at(-1)?.kind, "stopped");
  });

  it("keeps emitting while a media lookup takes longer than the idle limit", WIN32_ONLY, async t => {
    const { directory, records } = await collectTrace(t, [
      "function Get-CimInstance($Filter) {",
      "  if ($Filter -eq 'ProcessId = 101') {",
      "    [IO.File]::WriteAllText('lookup-started', '')",
      "    Start-Sleep -Milliseconds 13000",
      "  }",
      "}",
      "function Wait-Event { Start-Sleep -Milliseconds 50 }",
      "function Get-Event {",
      "  if (!$script:sent) {",
      "    $script:sent = $true",
      "    $script:fixtureEvents = @(New-Start 101 'setup_wm.exe')",
      "  } elseif (!$script:sentLater -and [IO.File]::Exists('lookup-started')) {",
      "    $script:sentLater = $true",
      "    $script:fixtureEvents = @(New-Start 102 'ordinary.exe')",
      "  }",
      "  $script:fixtureEvents",
      "}",
    ], (row, directory) => {
      if (row.kind === "raw-start" && row.pid === 102) writeFileSync(join(directory, "watcher.stop"), "");
    });
    assert.ok(existsSync(join(directory, "lookup-started")));
    const starts = records.filter(row => row.kind === "raw-start");
    assert.deepEqual(starts.map(row => row.pid), [101, 102]);
    const gap = starts[1].received - starts[0].received;
    t.diagnostic(`${Math.round(gap)} ms between raw starts`);
    assert.ok(gap < 12_000, `The next raw start took ${Math.round(gap)} ms during media enrichment`);
    assert.equal(records.find(row => row.kind === "trace-process-query-failed")?.reason, "media-budget-exhausted");
    assert.equal(records.at(-1)?.kind, "stopped");
  });

  it("enriches only preceding starts and verifies the step ancestry once per media start", WIN32_ONLY, async t => {
    const { records } = await collectTrace(t, [
      "$now = [DateTime]::UtcNow",
      "[IO.File]::WriteAllText('fixture-time', $now.ToString('o'))",
      "[IO.File]::WriteAllText('permission-step.txt', '10 ' + $now.AddSeconds(-10).ToString('yyyy-MM-ddTHH:mm:ss.ffffff'))",
      "function Get-CimInstance($Filter) {",
      "  if ($Filter -or !(Test-Path -LiteralPath 'query-context')) { return }",
      "  [IO.File]::AppendAllText('context-lookups', '1')",
      "  $time = [DateTime]::Parse([IO.File]::ReadAllText('fixture-time')).ToUniversalTime()",
      "  @{ ProcessId = 10; ParentProcessId = 0; Name = 'pwsh.exe'; CreationDate = $time.AddSeconds(-10) }",
      "  @{ ProcessId = 11; ParentProcessId = 10; Name = 'bun.exe'; CreationDate = $time.AddSeconds(-9) }",
      "  @{ ProcessId = 12; ParentProcessId = 11; Name = 'electron.exe'; CreationDate = $time.AddSeconds(-8); CommandLine = 'worker' }",
      "  @{ ProcessId = 13; ParentProcessId = 12; Name = 'node.exe'; CreationDate = $time.AddSeconds(-2); ExecutablePath = 'C:/tools/node.exe'; CommandLine = 'child' }",
      "  @{ ProcessId = 14; ParentProcessId = 12; Name = 'node.exe'; CreationDate = $time.AddSeconds(-1) }",
      "  @{ ProcessId = 15; ParentProcessId = 10; Name = 'node.exe'; CreationDate = $time.AddSeconds(-11) }",
      "}",
      "function Wait-Event { Start-Sleep -Milliseconds 30 }",
      "function Get-Event {",
      "  if (!$script:sent) {",
      "    $script:sent = $true",
      "    [IO.File]::WriteAllText('query-context', '')",
      "    $script:fixtureEvents = @((New-Start 12 'electron.exe' 11 $now.AddSeconds(-8)),",
      "      (New-Start 14 'node.exe' 12 $now.AddSeconds(-2)), (New-Start 31 'setup_wm.exe' 0 $now),",
      "      (New-Start 13 'node.exe' 12 $now.AddSeconds(-2)), (New-Start 32 'unregmp2.exe' 0 $now),",
      "      (New-Start 33 'ordinary.exe' 0 $now.AddSeconds(1)))",
      "  }",
      "  $script:fixtureEvents",
      "}",
    ], (row, directory) => {
      if (row.kind === "media-context" && row.pid === 32) {
        writeFileSync(join(directory, "watcher.stop"), "");
      }
      if (row.kind === "trace" && row.rows[0]?.pid === 32) {
        setTimeout(() => {
          const stop = join(directory, "watcher.stop");
          if (existsSync(directory) && !existsSync(stop)) writeFileSync(stop, "");
        }, 2000).unref();
      }
    });
    assert.deepEqual(records.filter(row => row.kind === "raw-start").map(row => row.pid), [12, 14, 31, 13, 32, 33]);
    const contexts = records.filter(row => row.kind === "media-context");
    assert.deepEqual(contexts.map(row => [row.pid, row.enriched, row.unavailable]), [[31, 1, 1], [32, 1, 1]]);
    for (const row of contexts) {
      assert.deepEqual(row.starts.map(start => [start.pid, start.image, start.commandLine]), [[13, "C:/tools/node.exe", "child"]]);
      assert.deepEqual(row.stepProcesses.map(start => start.pid).sort(), [12, 13, 14]);
    }
  });

  it("leaves raw starts flowing and abandons an overdue media context without a second lookup", WIN32_ONLY, async t => {
    const { directory, records } = await collectTrace(t, [
      "function Get-CimInstance($Filter) {",
      "  if ($Filter -or !(Test-Path -LiteralPath 'query-context')) { return }",
      "  [IO.File]::AppendAllText('context-lookups', '1')",
      "  Start-Sleep -Milliseconds 3000",
      "}",
      "function Wait-Event { Start-Sleep -Milliseconds 30 }",
      "function Get-Event {",
      "  if (!$script:sent) {",
      "    $script:sent = $true",
      "    [IO.File]::WriteAllText('query-context', '')",
      "    $script:fixtureEvents = @((New-Start 10 'node.exe'), (New-Start 31 'setup_wm.exe'))",
      "  } elseif (!$script:later -and [IO.File]::Exists('context-lookups')) {",
      "    $script:later = $true",
      "    $script:fixtureEvents = @((New-Start 11 'ordinary.exe'), (New-Start 32 'unregmp2.exe'))",
      "  } elseif (!$script:later -and !$script:fixtureEvents.Count) { [IO.File]::WriteAllText($stop, '') }",
      "  $script:fixtureEvents",
      "}",
    ], (row, directory) => {
      if (row.kind === "media-context" && row.pid === 31) writeFileSync(join(directory, "watcher.stop"), "");
    });
    assert.equal(readFileSync(join(directory, "context-lookups"), "utf8"), "1");
    const starts = records.filter(row => row.kind === "raw-start");
    assert.deepEqual(starts.map(row => row.pid), [10, 31, 11, 32]);
    const contexts = records.filter(row => row.kind === "media-context");
    assert.equal(contexts.length, 2);
    const first = contexts.find(row => row.pid === 31);
    assert.deepEqual([first.enriched, first.unavailable, first.stepProcesses], [0, 1, null]);
    assert.ok(starts[3].received < first.received);
    assert.ok(first.received - starts[1].received < 3000);
  });

  it("traces a media setup start and its live parent outside the job root", WIN32_ONLY, async t => {
    const directory = fixture(t);
    const root = join(directory, "job");
    mkdirSync(root);
    const image = join(directory, "setup_wm.exe");
    copyFileSync(process.execPath, image);
    const scripts = join(directory, ".github", "scripts");
    const lib = join(directory, "scripts", "lib");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(lib, { recursive: true });
    for (const file of ["windows-launch-lifecycle.ps1", "watch-windows-processes.mjs", "job-root-diagnostic.mjs"]) {
      copyFileSync(new URL(file, SCRIPTS), join(scripts, file));
    }
    copyFileSync(new URL("../../scripts/lib/windows-powershell-env.mjs", SCRIPTS), join(lib, "windows-powershell-env.mjs"));
    const collector = readFileSync(new URL("watch-windows-processes.ps1", SCRIPTS), "utf8");
    // Feed the same busy queue whether or not the native subscription can start.
    writeFileSync(join(scripts, "watch-windows-processes.ps1"), [
      "function Register-CimIndicationEvent($ClassName, $OperationTimeoutSec, $SourceIdentifier) {",
      "  $native = 'unavailable'",
      "  try {",
      "    CimCmdlets\\Register-CimIndicationEvent @PSBoundParameters -ErrorAction Stop | Out-Null",
      "    $native = 'active'",
      "  } catch { $native = 'unavailable (' + $_.FullyQualifiedErrorId + ')' }",
      "  [IO.File]::WriteAllText('native-trace', $native)",
      "}",
      "function Get-CimInstance($ClassName, $Property, $OperationTimeoutSec, $Filter) {",
      "  if ($Filter) { [IO.File]::AppendAllText('lookups', $Filter + [Environment]::NewLine) }",
      `  if ($Filter -eq 'ProcessId = 4294967294 OR ProcessId = ${process.pid}') {`,
      `    return @{ ProcessId = ${process.pid}; Name = 'node.exe'; CreationDate = [DateTime]::UtcNow }`,
      "  }",
      "  if ($Filter -match '^ProcessId = 4294967[12][0-9]{2}\\b') { return }",
      "  foreach ($row in (CimCmdlets\\Get-CimInstance @PSBoundParameters)) {",
      "    if ($Filter -match ' OR ' -and $row.Name -eq 'node.exe') {",
      "      @{ ProcessId = $row.ProcessId; ParentProcessId = 0; Name = $row.Name; CreationDate = $row.CreationDate;",
      "        ExecutablePath = $row.ExecutablePath; CommandLine = $row.CommandLine }",
      "    } else { $row }",
      "  }",
      "}",
      "function Get-Event {",
      "  $nativeStarts = @(Microsoft.PowerShell.Utility\\Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue)",
      "  foreach ($start in $nativeStarts) { Microsoft.PowerShell.Utility\\Remove-Event -EventIdentifier $start.EventIdentifier }",
      "  if ([IO.File]::Exists('trace-events.json')) {",
      "    $events = [IO.File]::ReadAllText('trace-events.json') | ConvertFrom-Json",
      "    [IO.File]::Delete('trace-events.json')",
      "    $script:fixtureEvents = @(for ($i = 0; $i -lt $events.Length; $i++) {",
      "      $event = $events[$i]",
      "      $event.TIME_CREATED = [DateTime]::UtcNow.AddSeconds(-$event.AgeSeconds).ToFileTimeUtc()",
      "      @{ EventIdentifier = $i; SourceEventArgs = @{ NewEvent = $event } }",
      "    })",
      "    foreach ($start in ($nativeStarts | Where-Object { $_.SourceEventArgs.NewEvent.ProcessName -notin $mediaImages } | Select-Object -First 4)) {",
      "      $script:fixtureEvents += @{ EventIdentifier = $script:fixtureEvents.Length; SourceEventArgs = $start.SourceEventArgs }",
      "    }",
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
    let parentClosed;
    let childPid = "";
    try {
      await control(directory, scripts, "start", env);
      const log = readLines(join(directory, "watcher.jsonl"));
      assert.equal(log.find(row => row.kind === "mechanism")?.mechanism, "Win32_ProcessStartTrace");
      t.diagnostic(`native trace subscription ${readFileSync(join(directory, "native-trace"), "utf8")}`);
      parent = spawn(process.execPath, ["-e", [
        'const { spawn } = require("node:child_process");',
        'const { renameSync, writeFileSync } = require("node:fs");',
        'const child = spawn(process.argv[1], ["-e", "process.stdin.resume()"], { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });',
        'process.stdin.on("end", () => { child.stdin.end(); });',
        'process.stdin.resume();',
        'child.on("exit", code => { process.exitCode = code ?? 1; process.stdin.destroy(); });',
        'const event = (ProcessID, ParentProcessID, ProcessName, AgeSeconds = 0) =>',
        '  ({ ProcessID, ParentProcessID, ProcessName, AgeSeconds, TIME_CREATED: 0 });',
        'const noise = Array.from({ length: 33 }, (_, index) => event(4294967200 + index, 0, "noise.exe"));',
        'writeFileSync("trace-events.tmp", JSON.stringify([...noise, event(process.pid, process.ppid, "node.exe"),',
        '  event(child.pid, process.pid, "setup_wm.exe"), event(4294967294, process.ppid, "setup_wm.exe", 3600),',
        '  event(4294967293, 4294967295, "wmpnetwk.exe"),',
        '  ...Array.from({ length: 6 }, (_, index) => event(4294967100 + index, 0, "wmplayer.exe"))]));',
        'renameSync("trace-events.tmp", "trace-events.json");',
        'process.stdout.write(String(child.pid));',
      ].join(" "), image, "fixture::token", "##[example]"], {
        cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
      });
      parentClosed = once(parent, "close");
      parent.stdout.on("data", chunk => { childPid += chunk; });
      await waitForPath(join(directory, "trace-drained"));
    } finally {
      try {
        parent?.stdin.end();
        if (parentClosed) assert.deepEqual(await parentClosed, [0, null]);
      } finally {
        const { stdout } = await control(directory, scripts, "stop");
        assert.match(stdout, /collector and watcher exits verified/);
        assert.doesNotMatch(stdout, /Forced diagnostic process exit/);
      }
    }
    const lookups = readFileSync(join(directory, "lookups"), "utf8").split(/\r?\n/u);
    const rows = readLines(join(directory, "media-starts.jsonl"));
    const missingParent = lookups.indexOf("ProcessId = 4294967293 OR ProcessId = 4294967295");
    assert.ok(missingParent >= 0, JSON.stringify({
      lookups: lookups.filter(Boolean).length,
      media: rows.map(({ ancestryStatus, created }) => [ancestryStatus, Boolean(created)]),
    }));
    assert.equal(lookups.includes("ProcessId = 4294967200"), false, "Ordinary starts must not be looked up");
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
    const later = rows.find(row => row.pid === 4294967294);
    const missing = rows.find(row => row.pid === 4294967293);
    assert.equal(later.ancestryTimeBasis, "start-event");
    assert.equal(later.ancestryStatus, "parent-not-older");
    assert.deepEqual(later.ancestry.map(({ pid, parentCreatedBeforeChild }) => [pid, parentCreatedBeforeChild]), [[process.pid, false]]);
    assert.equal(missing.ancestryStatus, "parent-unavailable");
    assert.deepEqual(missing.ancestry, [{
      pid: 4294967295, name: null, created: null, image: null, commandLine: null, parentCreatedBeforeChild: false,
    }]);
    const overflow = rows.find(row => row.pid === 4294967105);
    assert.equal(overflow?.ancestryStatus, "media-batch-limited");
    assert.deepEqual(overflow.ancestry, []);
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
