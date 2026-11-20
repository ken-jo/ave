import { execFile } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isJobRootPath, maskJobRootArguments, processCwdProbe } from "./job-root-diagnostic.mjs";

const MEDIA_IMAGES = new Set(["setup_wm.exe", "unregmp2.exe", "wmplayer.exe"]);
const WATCH_LOG = "watcher.jsonl";
const MEDIA_LOG = "media-starts.jsonl";
const JOB_LOG = "job-root-starts.jsonl";
const MARKER_LOG = "test-files.jsonl";
const READY = "watcher.ready";
const FIELD_LIMIT = 2048;
const COLLECTOR_IDLE_MS = 12_000;

export function processMatch(row, root) {
  if (MEDIA_IMAGES.has((row.name ?? win32.basename(row.image ?? "")).toLowerCase())) return "media";
  if (isJobRootPath(row.image, root)) return "image";
  return isJobRootPath(row.cwd, root) ? "cwd" : null;
}

export function createProcessHistory(root) {
  const byPid = new Map();

  function describeProcess(row) {
    return {
      pid: row.pid,
      parentPid: row.parentPid,
      created: row.created ?? null,
      image: (row.image ?? row.name ?? "").slice(0, FIELD_LIMIT) || null,
      commandLine: maskJobRootArguments(row.commandLine, root)?.slice(0, FIELD_LIMIT) ?? null,
    };
  }

  function remember(row, snapshot) {
    const process = describeProcess(row);
    if (!process.created) return process;
    let generations = byPid.get(process.pid);
    if (!generations) {
      generations = new Map();
      byPid.set(process.pid, generations);
    }
    const previous = generations.get(process.created);
    if (previous) {
      if (previous.lastSnapshot !== snapshot - 1) previous.firstConsecutiveSnapshot = snapshot;
      previous.lastSnapshot = snapshot;
      return null;
    }
    generations.set(process.created, {
      process, firstSnapshot: snapshot, firstConsecutiveSnapshot: snapshot, lastSnapshot: snapshot,
    });
    return process;
  }

  function formatStart(process, match, row, ancestry) {
    return JSON.stringify({
      kind: "start", match, ...process, eventTime: row.eventTime ?? null,
      cwdStatus: row.cwdStatus ?? "unavailable", ancestry,
      unresolvedParentPid: (ancestry.at(-1) ?? process).parentPid || null,
    });
  }

  function formatSnapshotStart(process, match, row = {}) {
    const ancestry = [];
    let child = byPid.get(process.pid)?.get(process.created);
    while (child?.process.parentPid > 0) {
      // Parent sightings must bracket the child's last-absent and first-present queries.
      const candidates = [...(byPid.get(child.process.parentPid)?.values() ?? [])].filter(
        parent => parent.firstConsecutiveSnapshot < child.firstSnapshot - 1 && parent.lastSnapshot > child.firstSnapshot,
      );
      if (candidates.length !== 1) break;
      child = candidates[0];
      ancestry.push(child.process);
    }
    return formatStart(process, match, row, ancestry);
  }

  function formatTraceStart(row, match, liveParent) {
    // The baseline query finished before subscription. The live query started after event receipt.
    const parent = liveParent?.pid === row.parentPid && byPid.get(row.parentPid)?.get(liveParent.created);
    return formatStart(describeProcess(row), match, row, parent?.firstSnapshot === 1 ? [parent.process] : []);
  }

  return { remember, formatSnapshotStart, formatTraceStart };
}

function createRecorder(root, directory) {
  const history = createProcessHistory(root);
  const totals = new Map();
  let pending = [];
  let snapshot = 0;

  function write(file, record) {
    const line = typeof record === "string" ? record : JSON.stringify(record);
    const size = Buffer.byteLength(line) + 1;
    const total = totals.get(file) ?? 0;
    if (total + size > 1024 * 1024) {
      if (file !== WATCH_LOG && total !== Infinity) write(WATCH_LOG, { kind: "output-limit", file });
      totals.set(file, Infinity);
      return;
    }
    appendFileSync(join(directory, file), line + "\n");
    totals.set(file, total + size);
  }

  function writeStart(match, line) {
    write(match === "media" ? MEDIA_LOG : JOB_LOG, line);
  }

  function flush() {
    for (const { process, match, row } of pending) {
      writeStart(match, history.formatSnapshotStart(process, match, row));
    }
    pending = [];
  }

  function record(entry) {
    if (entry.kind === "heartbeat") return;
    if (entry.kind === "ready") {
      writeFileSync(join(directory, READY), "");
      return;
    }
    if (entry.kind === "trace") {
      const [row, liveParent] = entry.rows;
      const match = processMatch(row, root);
      if (match) writeStart(match, history.formatTraceStart(row, match, liveParent));
      return;
    }
    if (entry.kind !== "snapshot" && entry.kind !== "baseline") {
      if (entry.kind === "stopped" || entry.kind === "collector-failed") flush();
      write(WATCH_LOG, entry);
      return;
    }
    snapshot += 1;
    const starts = entry.rows.map(row => [row, history.remember(row, snapshot)]);
    if (entry.kind === "baseline") return;
    flush();
    for (const [row, process] of starts) {
      const match = process && processMatch(row, root);
      if (match) pending.push({ process, match, row });
    }
  }

  return { flush, record, write };
}

function watch(root, directory, pipe) {
  const { flush, record, write } = createRecorder(root, directory);
  let idle;
  const server = createServer(socket => {
    server.close();
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", line => {
      idle.refresh();
      try { record(JSON.parse(line)); }
      catch { write(WATCH_LOG, { kind: "unreadable-collector-record" }); }
    });
    socket.on("error", () => write(WATCH_LOG, { kind: "collector-pipe-error" }));
    socket.on("close", () => {
      clearTimeout(idle);
      flush();
    });
  });
  idle = setTimeout(() => {
    write(WATCH_LOG, { kind: "collector-timeout" });
    const controller = fileURLToPath(new URL("./windows-launch-lifecycle.ps1", import.meta.url));
    const powershell = win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", controller,
      "stop-collector", directory], { cwd: directory, windowsHide: true, timeout: 4500 }, error => {
      if (error) write(WATCH_LOG, { kind: "collector-exit-unverified" });
    });
    if (server.listening) server.close();
  }, COLLECTOR_IDLE_MS);
  server.on("error", () => {
    clearTimeout(idle);
    write(WATCH_LOG, { kind: "watcher-pipe-error" });
  });
  server.listen(pipe);
}

export function renderRunnerOutput(jsonl) {
  return jsonl.replaceAll("::", "\\u003a\\u003a").replaceAll("##[", "\\u0023\\u0023[");
}

function printTail(directory, file, limit) {
  const path = join(directory, file);
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, limit));
    const read = readSync(fd, tail, 0, tail.length, size - tail.length);
    const start = size > limit ? tail.indexOf(10) + 1 : 0;
    console.log("--- " + file + (size > limit ? " (tail)" : "") + " ---");
    if (size <= limit || start > 0) process.stdout.write(renderRunnerOutput(tail.subarray(start, read).toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , command, directory] = process.argv;
  if (command === "prepare") {
    const { AVE_CI_JOB_ROOT: root, GITHUB_ACTIONS, RUNNER_TEMP } = process.env;
    if (process.platform !== "win32" || GITHUB_ACTIONS !== "true" || !root || !RUNNER_TEMP ||
        directory !== join(RUNNER_TEMP, "windows-launch-diagnostic") || isJobRootPath(RUNNER_TEMP, root)) {
      process.exitCode = 1;
    } else {
      writeFileSync(join(directory, "cwd-probe.ps1"), processCwdProbe);
    }
  }
  if (command === "watch") watch(process.env.AVE_CI_JOB_ROOT, directory, process.env.AVE_PROCESS_WATCH_PIPE);
  if (command === "print") {
    try {
      for (const [file, limit] of [[WATCH_LOG, 4096], [MEDIA_LOG, 32768], [JOB_LOG, 16384], [MARKER_LOG, 131072]]) {
        printTail(directory, file, limit);
      }
    } catch {
      console.log("Process watcher could not print the diagnostic");
    }
  }
}
