import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { maskJobRootArguments } from "../../.github/scripts/job-root-diagnostic.mjs";
import { createProcessHistory, processMatch, watchProcesses } from "../../.github/scripts/watch-windows-processes.mjs";
import { windowsTestFileMarkers } from "../../.github/scripts/windows-test-file-markers.mjs";

const ROOT = String.raw`C:\ave-ci-example`;

function readLines(file) {
  return readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "launch-diagnostic-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

describe("Windows launch diagnostic", () => {
  it("uses the cleanup argument matcher without changing unrelated text", () => {
    const input = String.raw`tool --file="c:/AVE-ci-example/tmp/a.json" /out=\\?\C:\ave-ci-example\b.txt C:\ave-ci-example2\keep xC:\ave-ci-example /flag`;
    assert.equal(maskJobRootArguments(input, ROOT),
      String.raw`tool --file="[job-root]" /out=[job-root] C:\ave-ci-example2\keep xC:\ave-ci-example /flag`);
    assert.equal(maskJobRootArguments(null, ROOT), null);
  });

  it("selects the media names and normalized job-root images", () => {
    for (const name of ["SETUP_WM.EXE", "unregmp2.exe", "wmplayer.exe"]) {
      assert.equal(processMatch({ name, image: null }, ROOT), "media");
    }
    assert.equal(processMatch({ image: String.raw`\\?\c:\AVE-ci-example\tmp\a.exe` }, ROOT), "image");
    assert.equal(processMatch({ image: "C:/ave-ci-example/tmp/../a.exe" }, ROOT), "image");
    assert.equal(processMatch({ image: "C:/ave-ci-example2/a.exe" }, ROOT), null);
    assert.equal(processMatch({ image: "C:/ave-ci-example/../other/a.exe" }, ROOT), null);
    assert.equal(processMatch({ image: "C:/other/a.exe", commandLine: ROOT }, ROOT), null);
  });

  it("formats the ancestry across PID reuse and reports missing ancestors", () => {
    const history = createProcessHistory(ROOT);
    const grandparent = history.remember({
      pid: 10, parentPid: 90, created: "2026-01-02T03:04:05.0000000Z", name: "launcher.exe",
    });
    const parentRow = {
      pid: 20, parentPid: 10, created: "2026-01-02T03:04:05.0000010Z",
      image: "C:/example/shell.exe", commandLine: `shell "${ROOT}\\probe"`,
    };
    const parent = history.remember(parentRow);
    assert.equal(history.remember(parentRow), null);
    history.remember({ ...parentRow, name: "new.exe", created: "2026-01-02T03:04:05.0000030Z" });
    const child = history.remember({
      pid: 30, parentPid: 20, created: "2026-01-02T03:04:05.0000020Z",
      name: "setup_wm.exe", commandLine: `setup_wm "${ROOT}\\log"`,
    });
    assert.equal(parent.commandLine, 'shell "[job-root]"');
    assert.deepEqual(JSON.parse(history.formatStart(child, "media")), {
      kind: "start", match: "media", pid: 30, parentPid: 20, created: child.created,
      image: "setup_wm.exe", commandLine: 'setup_wm "[job-root]"',
      ancestry: [parent, grandparent], unresolvedParentPid: 90,
    });
  });

  it("observes a short-lived native child and its parent using scoped polling", {
    skip: process.platform !== "win32", timeout: 30_000,
  }, async t => {
    const directory = fixture(t);
    const root = join(directory, "job");
    mkdirSync(root);
    const image = join(root, "child.exe");
    copyFileSync(join(process.env.SystemRoot, "System32", "ping.exe"), image);
    const watching = watchProcesses({ directory, root, pollParentPid: process.pid });
    try {
      const ready = join(directory, "watcher.ready");
      const deadline = Date.now() + 12_000;
      while (!existsSync(ready) && Date.now() < deadline) {
        await Promise.race([delay(50), watching.then(() => assert.fail("Polling stopped before it was ready"))]);
      }
      assert.ok(existsSync(ready), "Polling did not finish its initial snapshot");
      const child = spawn(image, ["-n", "5", "127.0.0.1"], { cwd: root, windowsHide: true, stdio: "ignore" });
      assert.deepEqual(await once(child, "exit"), [0, null]);
      writeFileSync(join(directory, "watcher.stop"), "");
      await watching;
      const log = readLines(join(directory, "watcher.jsonl"));
      assert.deepEqual(log[0], { kind: "mechanism", mechanism: "polling", jobRootMatch: "image path" });
      assert.equal(log.at(-1).kind, "stopped");
      const record = readLines(join(directory, "job-root-starts.jsonl")).find(row => row.pid === child.pid);
      assert.ok(record);
      assert.equal(record.parentPid, process.pid);
      assert.equal(record.ancestry[0].pid, process.pid);
      assert.equal(record.image.toLowerCase(), image.toLowerCase());
      assert.match(record.commandLine, /\[job-root\]/);
      t.diagnostic(JSON.stringify(record));
    } finally {
      writeFileSync(join(directory, "watcher.stop"), "");
      await watching;
    }
  });
});

describe("Windows test file markers", () => {
  it("is gated and writes UTC start and finish lines with relative file names", t => {
    const directory = fixture(t);
    assert.equal(windowsTestFileMarkers({ RUNNER_TEMP: directory }), undefined);
    assert.equal(windowsTestFileMarkers({ AVE_CI_WINDOWS_TEST_FILE_MARKERS: "1" }), undefined);
    const reporter = windowsTestFileMarkers({ RUNNER_TEMP: directory, AVE_CI_WINDOWS_TEST_FILE_MARKERS: "1" });
    const module = {
      project: { config: { root: directory } },
      moduleId: join(directory, "test", "probe.test.ts"),
    };
    reporter.onTestModuleStart(module);
    reporter.onTestModuleEnd(module);
    const lines = readLines(join(directory, "windows-launch-diagnostic", "test-files.jsonl"));
    assert.deepEqual(lines.map(line => [line.event, line.file]), [
      ["start", "test/probe.test.ts"], ["finish", "test/probe.test.ts"],
    ]);
    assert.ok(lines.every(line => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(line.time)));
    assert.ok(lines[0].time <= lines[1].time);
  });

  it("leaves the test outcome alone when the marker directory is unavailable", t => {
    const directory = fixture(t);
    writeFileSync(join(directory, "windows-launch-diagnostic"), "");
    const reporter = windowsTestFileMarkers({ RUNNER_TEMP: directory, AVE_CI_WINDOWS_TEST_FILE_MARKERS: "1" });
    const module = { project: { config: { root: directory } }, moduleId: join(directory, "probe.test.ts") };
    assert.doesNotThrow(() => reporter.onTestModuleStart(module));
    assert.doesNotThrow(() => reporter.onTestModuleEnd(module));
  });
});
