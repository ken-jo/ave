import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { maskJobRootArguments, processCwdProbe } from "../../.github/scripts/job-root-diagnostic.mjs";
import { createProcessHistory, processMatch, renderRunnerOutput } from "../../.github/scripts/watch-windows-processes.mjs";
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
  return run(executable, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    join(scripts, "windows-launch-lifecycle.ps1"), command, directory, "-GraceMilliseconds", String(grace)], {
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
    for (const name of ["SETUP_WM.EXE", "unregmp2.exe", "wmplayer.exe"]) {
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

  it("resolves generation lifetimes using snapshot order even when creation times run backward", () => {
    const history = createProcessHistory(ROOT);
    const grandparentRow = { pid: 10, parentPid: 90, created: time(12), name: "launcher.exe" };
    const grandparent = history.remember(grandparentRow, 1);
    history.remember(grandparentRow, 2);
    const parentRow = {
      pid: 20, parentPid: 10, created: time(6),
      image: "C:/example/shell.exe", commandLine: `shell "${ROOT}\\probe"`,
    };
    const parent = history.remember(parentRow, 3);
    for (const snapshot of [3, 4, 5, 6, 7]) history.remember(grandparentRow, snapshot);
    for (const snapshot of [4, 5, 6]) assert.equal(history.remember(parentRow, snapshot), null);
    const row = {
      pid: 30, parentPid: 20, created: time(3),
      name: "setup_wm.exe", commandLine: `setup_wm "${ROOT}\\log"`,
    };
    const child = history.remember(row, 5);
    history.remember({ ...parentRow, created: time(5) }, 7);
    assert.equal(parent.commandLine, 'shell "[job-root]"');
    assert.deepEqual(JSON.parse(history.formatSnapshotStart(child, "media", row)), {
      kind: "start", match: "media", pid: 30, parentPid: 20, created: time(3), eventTime: null,
      image: "setup_wm.exe", commandLine: 'setup_wm "[job-root]"', cwdStatus: "unavailable",
      ancestry: [parent, grandparent], unresolvedParentPid: 90,
    });
  });

  it("leaves an exited cached parent unresolved when polling missed its replacement", () => {
    const history = createProcessHistory(ROOT);
    const departed = { pid: 20, created: time(1), name: "departed.exe" };
    history.remember(departed, 1);
    history.remember(departed, 2);
    const child = history.remember({ pid: 30, parentPid: 20, created: time(4) }, 3);
    history.remember({ ...departed, created: time(6), name: "later.exe" }, 4);
    const record = JSON.parse(history.formatSnapshotStart(child, "media"));
    assert.deepEqual(record.ancestry, []);
    assert.equal(record.unresolvedParentPid, 20);
  });

  it("leaves a missed replacement unresolved after the clock steps backward", () => {
    const history = createProcessHistory(ROOT);
    const departed = { pid: 20, created: time(1), observedAt: time(9), name: "departed.exe" };
    history.remember(departed, 1);
    history.remember(departed, 2);
    const child = history.remember({ pid: 30, parentPid: 20, created: time(4), observedAt: time(5) }, 3);
    const record = JSON.parse(history.formatSnapshotStart(child, "media"));
    assert.deepEqual(record.ancestry, []);
    assert.equal(record.unresolvedParentPid, 20);
  });

  it("leaves a late trace unresolved when the live parent generation differs from the baseline", () => {
    const history = createProcessHistory(ROOT);
    history.remember({ pid: 20, created: time(5), name: "departed.exe" }, 1);
    const replacement = { pid: 20, created: time(2), name: "replacement.exe" };
    const row = { pid: 30, parentPid: 20, created: time(3), eventTime: time(6), name: "setup_wm.exe" };
    const record = JSON.parse(history.formatTraceStart(row, "media", replacement));
    assert.equal(record.eventTime, time(6));
    assert.equal(record.created, time(3));
    assert.deepEqual(record.ancestry, []);
    assert.equal(record.unresolvedParentPid, 20);
  });

  it("resolves a trace parent observed before subscription and after event receipt", () => {
    const history = createProcessHistory(ROOT);
    const parent = { pid: 20, parentPid: 10, created: time(7), name: "parent.exe" };
    const saved = history.remember(parent, 1);
    const row = { pid: 30, parentPid: 20, eventTime: time(4), name: "unregmp2.exe" };
    const record = JSON.parse(history.formatTraceStart(row, "media", parent));
    assert.equal(record.created, null);
    assert.equal(record.eventTime, time(4));
    assert.deepEqual(record.ancestry, [saved]);
    assert.equal(record.unresolvedParentPid, 10);
  });

  it("retains the trace time for an exited media target without inventing its creation or ancestry", () => {
    const history = createProcessHistory(ROOT);
    history.remember({ pid: 20, created: time(1), name: "parent.exe" }, 1);
    const row = { pid: 30, parentPid: 20, eventTime: time(4), name: "unregmp2.exe" };
    const record = JSON.parse(history.formatTraceStart(row, processMatch(row, ROOT)));
    assert.equal(record.match, "media");
    assert.equal(record.eventTime, time(4));
    assert.equal(record.created, null);
    assert.equal(record.commandLine, null);
    assert.equal(record.unresolvedParentPid, 20);
    assert.deepEqual(record.ancestry, []);
  });

  it("renders command-like process arguments inert while preserving their JSON value", () => {
    const row = { commandLine: 'program "::stop-commands::token" "##[error]message" "::token::"\nfragment' };
    const rendered = renderRunnerOutput(`${JSON.stringify(row)}\n`);
    assert.doesNotMatch(rendered, /::|##\[/u);
    assert.deepEqual(JSON.parse(rendered), row);
  });

  for (const stall of ["before readiness", "during stop", "with a blocked stop signal", "when the graceful wait throws"]) {
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
      writeFileSync(join(scripts, "watch-windows-processes.mjs"), [
        'import { existsSync, writeFileSync } from "node:fs";',
        'setInterval(() => {',
        prepared ? '  if (existsSync("watcher-processes.json")) writeFileSync("watcher.ready", "");' : "",
        '  if (existsSync("watcher.stop")) writeFileSync("watcher.stopping", "");',
        '}, 40);',
      ].join("\n"));
      writeFileSync(join(scripts, "watch-windows-processes.ps1"), [
        'while ($true) {',
        "  if (Test-Path -LiteralPath 'watcher.stop') { [IO.File]::WriteAllText((Join-Path (Get-Location) 'collector.stopping'), '') }",
        '  Start-Sleep -Milliseconds 40',
        '}',
      ].join("\n"));
      const starting = control(directory, scripts, "start");
      starting.catch(() => {});
      try {
        const manifest = join(directory, "watcher-processes.json");
        await waitForPath(manifest);
        if (prepared) await starting;
        assert.equal(existsSync(join(directory, "watcher.ready")), prepared);
        const identities = Object.values(JSON.parse(readFileSync(manifest, "utf8")));
        assert.equal(identities.length, 2);
        assert.ok(identities.every(({ pid }) => isAlive(pid)));
        if (blockedSignal) mkdirSync(stopPath);
        const { stdout } = await control(directory, scripts, "stop", process.env, waitFailure ? 325 : 2000);
        if (blockedSignal) assert.match(stdout, /Could not signal diagnostic stop/);
        if (waitFailure) assert.match(stdout, /Diagnostic graceful wait failed/);
        assert.equal((stdout.match(/Forced diagnostic process exit/g) ?? []).length, 2);
        assert.match(stdout, /collector and watcher exits verified/);
        assert.ok(identities.every(({ pid }) => !isAlive(pid)));
        if (!blockedSignal && !waitFailure) {
          assert.ok(existsSync(join(directory, "collector.stopping")));
          assert.ok(existsSync(join(directory, "watcher.stopping")));
        }
      } finally {
        if (blockedSignal && existsSync(stopPath)) rmdirSync(stopPath);
        await starting;
        await control(directory, scripts, "stop");
      }
    });
  }

  it("observes short-lived image and cwd targets and their parent using scoped native polling", WIN32_ONLY, async t => {
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
        assert.equal(record.parentPid, process.pid);
        assert.equal(record.ancestry[0].pid, process.pid);
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
