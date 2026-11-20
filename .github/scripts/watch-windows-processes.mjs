import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsPowerShellEnv } from "../../scripts/lib/windows-powershell-env.mjs";
import { isJobRootPath, maskJobRootArguments } from "./job-root-diagnostic.mjs";

const MEDIA_IMAGES = new Set(["setup_wm.exe", "unregmp2.exe", "wmplayer.exe"]);
const WATCH_LOG = "watcher.jsonl";
const MEDIA_LOG = "media-starts.jsonl";
const JOB_LOG = "job-root-starts.jsonl";
const MARKER_LOG = "test-files.jsonl";
const READY = "watcher.ready";
const STOP = "watcher.stop";
const DONE = "watcher.done";
const FIELD_LIMIT = 2048;

export function processMatch(row, root) {
  if (MEDIA_IMAGES.has((row.name ?? win32.basename(row.image ?? "")).toLowerCase())) return "media";
  return isJobRootPath(row.image, root) ? "image" : null;
}

export function createProcessHistory(root) {
  const byPid = new Map();

  function remember(row) {
    let generations = byPid.get(row.pid);
    if (!generations) {
      generations = new Map();
      byPid.set(row.pid, generations);
    }
    if (generations.has(row.created)) return null;
    const process = {
      pid: row.pid,
      parentPid: row.parentPid,
      created: row.created,
      image: (row.image ?? row.name ?? "").slice(0, FIELD_LIMIT) || null,
      commandLine: maskJobRootArguments(row.commandLine, root)?.slice(0, FIELD_LIMIT) ?? null,
    };
    generations.set(row.created, process);
    return process;
  }

  function formatStart(process, match) {
    const ancestry = [];
    // A parent must have existed before its child. Keep the original PID generation
    // even when the parent exits or the same PID appears in a later snapshot.
    let child = process;
    while (child.parentPid > 0) {
      let parent;
      for (const candidate of byPid.get(child.parentPid)?.values() ?? []) {
        if (candidate.created < child.created && (!parent || candidate.created > parent.created)) parent = candidate;
      }
      if (!parent) break;
      ancestry.push(parent);
      child = parent;
    }
    return JSON.stringify({ kind: "start", match, ...process, ancestry, unresolvedParentPid: child.parentPid || null });
  }

  return { remember, formatStart };
}

function watcherEnv(env, directory) {
  const overrides = {
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    TEMP: directory, TMP: directory, TMPDIR: directory, AVE_TEST_TMP_ROOT: directory,
  };
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !(key.toUpperCase() in overrides) &&
      key.toUpperCase() !== "NODE_OPTIONS")),
    ...overrides,
  };
}

export async function watchProcesses({ root, directory, trace = false, pollParentPid }) {
  const history = createProcessHistory(root);
  const totals = new Map();
  function write(file, line) {
    const size = Buffer.byteLength(line) + 1;
    const total = totals.get(file) ?? 0;
    if (total + size > 1024 * 1024) {
      if (file !== WATCH_LOG && total !== Infinity) write(WATCH_LOG, JSON.stringify({ kind: "output-limit", file }));
      totals.set(file, Infinity);
      return;
    }
    appendFileSync(join(directory, file), line + "\n");
    totals.set(file, total + size);
  }
  const child = spawn(win32.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-File", fileURLToPath(new URL("./watch-windows-processes.ps1", import.meta.url)),
  ], {
    cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...windowsPowerShellEnv(watcherEnv(process.env, directory)),
      AVE_PROCESS_WATCH_STOP: join(directory, STOP),
      AVE_PROCESS_WATCH_TRACE: trace ? "1" : "",
      AVE_PROCESS_WATCH_PARENT: pollParentPid?.toString() ?? "",
    },
  });
  const exited = once(child, "close").then(([code]) => code === 0, () => false);
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const record = JSON.parse(line);
      if (record.kind === "snapshot" || record.kind === "baseline") {
        const starts = record.rows.map(row => [row, history.remember(row)]);
        if (record.kind === "baseline") writeFileSync(join(directory, READY), "");
        else for (const [row, process] of starts) {
          const match = process && processMatch(row, root);
          if (match) write(match === "media" ? MEDIA_LOG : JOB_LOG, history.formatStart(process, match));
        }
      } else {
        write(WATCH_LOG, JSON.stringify(record));
      }
    }
    write(WATCH_LOG, JSON.stringify({ kind: (await exited) ? "stopped" : "collector-failed" }));
  } finally {
    writeFileSync(join(directory, STOP), "");
    child.stdout.resume();
    await exited;
    writeFileSync(join(directory, DONE), "");
  }
}

async function waitForFile(directory, file, timeout) {
  const deadline = performance.now() + timeout;
  while (!existsSync(join(directory, file)) && performance.now() < deadline) await delay(100);
  return existsSync(join(directory, file));
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
    console.log(`--- ${file}${size > limit ? " (tail)" : ""} ---`);
    if (size <= limit || start > 0) process.stdout.write(tail.subarray(start, read));
  } finally {
    closeSync(fd);
  }
}

async function main(command) {
  const { GITHUB_ACTIONS, RUNNER_TEMP, AVE_CI_JOB_ROOT: root } = process.env;
  if (GITHUB_ACTIONS !== "true" || process.platform !== "win32" || !RUNNER_TEMP ||
      !root || isJobRootPath(RUNNER_TEMP, root)) return;
  const directory = join(RUNNER_TEMP, "windows-launch-diagnostic");
  if (command === "watch") {
    await watchProcesses({ root, directory, trace: true });
  } else if (command === "start") {
    const child = spawn(process.execPath, [join(directory, ".github", "scripts", "watch-windows-processes.mjs"), "watch"], {
      detached: true, windowsHide: true, stdio: "ignore", cwd: directory, env: watcherEnv(process.env, directory),
    });
    await once(child, "spawn");
    child.unref();
    if (!await waitForFile(directory, READY, 12_000)) console.log("Process watcher did not become ready");
  } else if (command === "stop" && existsSync(directory)) {
    writeFileSync(join(directory, STOP), "");
    if (existsSync(join(directory, READY)) && !await waitForFile(directory, DONE, 8_000)) {
      console.log("Process watcher did not acknowledge stop");
    }
    for (const [file, limit] of [[WATCH_LOG, 4096], [MEDIA_LOG, 32768], [JOB_LOG, 16384], [MARKER_LOG, 131072]]) {
      printTail(directory, file, limit);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(process.argv[2]); }
  catch { console.log("Process watcher could not complete the diagnostic"); }
}
