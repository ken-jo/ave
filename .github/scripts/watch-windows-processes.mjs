import { execFile } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isJobRootPath, maskJobRootArguments, processCwdProbe } from "./job-root-diagnostic.mjs";

const MEDIA_IMAGES = new Set(["setup_wm.exe", "unregmp2.exe", "wmplayer.exe", "wmpnscfg.exe", "wmpnetwk.exe"]);
const WATCH_LOG = "watcher.jsonl";
const MEDIA_LOG = "media-starts.jsonl";
const RAW_LOG = "raw-starts.jsonl";
const JOB_LOG = "job-root-starts.jsonl";
const MARKER_LOG = "test-files.jsonl";
const READY = "watcher.ready";
const FIELD_LIMIT = 2048;
const NAME_LIMIT = 260;
const LOG_LIMIT = 1024 * 1024;
const RAW_LOG_LIMIT = 32 * LOG_LIMIT;
const RAW_START_LIMIT = 200_000;
const PRECEDING_STARTS_PER_MEDIA = 32;
const PRECEDING_STARTS_TOTAL = 128;
const COLLECTOR_IDLE_MS = 12_000;

export function processMatch(row, root) {
  if (MEDIA_IMAGES.has((row.name ?? win32.basename(row.image ?? "")).toLowerCase())) return "media";
  if (isJobRootPath(row.image, root)) return "image";
  return isJobRootPath(row.cwd, root) ? "cwd" : null;
}

export function createRecorder(root, directory, { rawStartLimit = RAW_START_LIMIT } = {}) {
  const seen = new Set();
  const totals = new Map();
  let rawStarts = 0;

  function write(file, record) {
    const line = renderRunnerOutput(JSON.stringify(record));
    const size = Buffer.byteLength(line) + 1;
    const total = totals.get(file) ?? 0;
    if (total + size > (file === RAW_LOG ? RAW_LOG_LIMIT : LOG_LIMIT)) {
      if (file !== WATCH_LOG && total !== Infinity) write(WATCH_LOG, { kind: "output-limit", file });
      totals.set(file, Infinity);
      return;
    }
    appendFileSync(join(directory, file), line + "\n");
    totals.set(file, total + size);
  }

  function writeStart(row) {
    const match = processMatch(row, root);
    if (!match) return;
    const start = {
      kind: "start", match, pid: row.pid, created: row.created ?? null, eventTime: row.eventTime ?? null,
      image: (row.image ?? row.name ?? "").slice(0, FIELD_LIMIT) || null,
      commandLine: maskJobRootArguments(row.commandLine, root)?.slice(0, FIELD_LIMIT) ?? null,
      cwdStatus: row.cwdStatus ?? "unavailable", unresolvedParentPid: row.parentPid ?? null,
    };
    if (match === "media" && Array.isArray(row.ancestry)) {
      start.ancestryTimeBasis = row.ancestryTimeBasis;
      start.ancestryStatus = row.ancestryStatus;
      start.ancestry = row.ancestry.slice(0, 6).map(link => ({
        pid: link.pid, name: link.name?.slice(0, NAME_LIMIT) ?? null, created: link.created ?? null,
        image: link.image?.slice(0, FIELD_LIMIT) ?? null,
        commandLine: maskJobRootArguments(link.commandLine, root)?.slice(0, FIELD_LIMIT) ?? null,
        parentCreatedBeforeChild: link.parentCreatedBeforeChild === true,
      }));
    }
    write(match === "media" ? MEDIA_LOG : JOB_LOG, start);
  }

  function record(entry) {
    if (entry.kind === "heartbeat") return;
    if (entry.kind === "ready") {
      writeFileSync(join(directory, READY), "");
      return;
    }
    if (entry.kind === "raw-start") {
      if (rawStarts < rawStartLimit) {
        write(RAW_LOG, { pid: entry.pid, parentPid: entry.parentPid, eventTime: entry.eventTime,
          name: entry.name?.slice(0, NAME_LIMIT) ?? null });
      } else if (rawStarts === rawStartLimit) {
        write(WATCH_LOG, { kind: "raw-start-limit", maxRows: rawStartLimit });
      }
      rawStarts++;
      return;
    }
    if (entry.kind === "trace") {
      writeStart(entry.rows[0]);
      return;
    }
    if (entry.kind !== "snapshot" && entry.kind !== "baseline") {
      write(WATCH_LOG, entry);
      return;
    }
    for (const row of entry.rows) {
      const key = `${row.pid}/${row.created}`;
      if (seen.has(key)) continue;
      if (row.created) seen.add(key);
      if (entry.kind === "snapshot") writeStart(row);
    }
  }

  return { record, write };
}

function watch(root, directory, pipe) {
  const { record, write } = createRecorder(root, directory);
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
    socket.on("close", () => clearTimeout(idle));
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

function readLogTail(directory, file, limit) {
  const path = join(directory, file);
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, limit));
    const read = readSync(fd, tail, 0, tail.length, size - tail.length);
    const start = size > limit ? tail.indexOf(10) + 1 : 0;
    return { tail: size > limit, text: size <= limit || start > 0 ? tail.subarray(start, read).toString("utf8") : "" };
  } finally {
    closeSync(fd);
  }
}

function printTail(directory, file, limit) {
  const log = readLogTail(directory, file, limit);
  if (!log) return;
  console.log("--- " + file + (log.tail ? " (tail)" : "") + " ---");
  process.stdout.write(renderRunnerOutput(log.text));
}

function readRows(directory, file, limit) {
  const log = readLogTail(directory, file, limit);
  return log?.text.trimEnd().split("\n").flatMap(line => {
    try { return [JSON.parse(line)]; }
    catch { return []; }
  }) ?? [];
}

function printMediaStarts(directory) {
  const media = readRows(directory, MEDIA_LOG, LOG_LIMIT);
  if (!media.length) return;
  const raw = readRows(directory, RAW_LOG, RAW_LOG_LIMIT);
  const byEventTime = (left, right) => (left.eventTime ?? "").localeCompare(right.eventTime ?? "");
  media.sort(byEventTime);
  raw.sort(byEventTime);
  let first = 0;
  let end = 0;
  let remaining = PRECEDING_STARTS_TOTAL;
  console.log(`--- ${MEDIA_LOG} ---`);
  for (const row of media) {
    console.log(renderRunnerOutput(JSON.stringify(row)));
    if (!row.eventTime) continue;
    const earlier = new Date(Date.parse(row.eventTime) - 5000);
    // Keep the fractional seconds from the trace timestamp.
    const windowStart = earlier.toISOString().slice(0, 19) + row.eventTime.slice(19);
    while (end < raw.length && raw[end].eventTime < row.eventTime) end++;
    while (first < end && raw[first].eventTime < windowStart) first++;
    const count = Math.min(end - first, PRECEDING_STARTS_PER_MEDIA, remaining);
    remaining -= count;
    console.log(renderRunnerOutput(JSON.stringify({
      kind: "preceding-starts", pid: row.pid, eventTime: row.eventTime,
      omitted: end - first - count, starts: raw.slice(end - count, end),
    })));
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
      for (const [file, limit] of [[WATCH_LOG, 4096], [JOB_LOG, 16384], [MARKER_LOG, 131072]]) {
        printTail(directory, file, limit);
      }
      printMediaStarts(directory);
    } catch {
      console.log("Process watcher could not print the diagnostic");
    }
  }
}
