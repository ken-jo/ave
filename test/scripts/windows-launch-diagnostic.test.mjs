import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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

  it("resolves an observed overlapping lifetime across delayed events and PID reuse", () => {
    const history = createProcessHistory(ROOT);
    const grandparent = history.remember({
      pid: 10, parentPid: 90, created: time(1), observedAt: time(4), name: "launcher.exe",
    });
    const parentRow = {
      pid: 20, parentPid: 10, created: time(2), observedAt: time(2),
      image: "C:/example/shell.exe", commandLine: `shell "${ROOT}\\probe"`,
    };
    const parent = history.remember(parentRow);
    assert.equal(history.remember({ ...parentRow, observedAt: time(4) }), null);
    history.remember({ ...parentRow, created: time(5), observedAt: time(7) });
    const row = {
      pid: 30, parentPid: 20, created: time(3), eventTime: time(4), observedAt: time(7),
      name: "setup_wm.exe", commandLine: `setup_wm "${ROOT}\\log"`,
    };
    const child = history.remember(row);
    assert.equal(parent.commandLine, 'shell "[job-root]"');
    assert.deepEqual(JSON.parse(history.formatStart(child, "media", row)), {
      kind: "start", match: "media", pid: 30, parentPid: 20, created: time(3), eventTime: time(4),
      image: "setup_wm.exe", commandLine: 'setup_wm "[job-root]"', cwdStatus: "unavailable",
      ancestry: [parent, grandparent], unresolvedParentPid: 90,
    });
  });

  it("leaves an exited cached parent unresolved when polling missed its replacement", () => {
    const history = createProcessHistory(ROOT);
    history.remember({ pid: 20, created: time(1), observedAt: time(2), name: "departed.exe" });
    const child = history.remember({ pid: 30, parentPid: 20, created: time(4), observedAt: time(5) });
    const record = JSON.parse(history.formatStart(child, "media"));
    assert.deepEqual(record.ancestry, []);
    assert.equal(record.unresolvedParentPid, 20);
  });

  it("leaves a late event unresolved when the only live generation started after the child", () => {
    const history = createProcessHistory(ROOT);
    history.remember({ pid: 20, created: time(5), observedAt: time(7), name: "replacement.exe" });
    const row = { pid: 30, parentPid: 20, created: time(3), eventTime: time(6), name: "setup_wm.exe" };
    const record = JSON.parse(history.formatStart(history.remember(row), "media", row));
    assert.equal(record.eventTime, time(6));
    assert.equal(record.created, time(3));
    assert.deepEqual(record.ancestry, []);
    assert.equal(record.unresolvedParentPid, 20);
  });

  it("retains the trace time for an exited media target without inventing its creation or ancestry", () => {
    const history = createProcessHistory(ROOT);
    history.remember({ pid: 20, created: time(1), observedAt: time(7), name: "parent.exe" });
    const row = { pid: 30, parentPid: 20, eventTime: time(4), name: "unregmp2.exe" };
    const record = JSON.parse(history.formatStart(history.remember(row), processMatch(row, ROOT), row));
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

  for (const stall of ["before readiness", "during stop"]) {
    it(`verifies and forces both diagnostic exits for a stall ${stall}`, WIN32_ONLY, async t => {
      const directory = fixture(t);
      const scripts = join(directory, "scripts");
      mkdirSync(scripts);
      copyFileSync(new URL("windows-launch-lifecycle.ps1", SCRIPTS), join(scripts, "windows-launch-lifecycle.ps1"));
      const prepared = stall === "during stop";
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
        const { stdout } = await control(directory, scripts, "stop");
        assert.equal((stdout.match(/Forced diagnostic process exit/g) ?? []).length, 2);
        assert.match(stdout, /collector and watcher exits verified/);
        assert.ok(identities.every(({ pid }) => !isAlive(pid)));
        assert.ok(existsSync(join(directory, "collector.stopping")));
        assert.ok(existsSync(join(directory, "watcher.stopping")));
      } finally {
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
  it("requires hosted Windows and writes pre-load and execution phases in UTC", t => {
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
      ["queued-before-load", "test/probe.test.ts"],
      ["execution-start", "test/probe.test.ts"],
      ["execution-finish", "test/probe.test.ts"],
    ]);
    assert.ok(lines.every(line => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(line.time)));
    assert.deepEqual(lines.map(line => line.time), lines.map(line => line.time).sort());
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
