#!/usr/bin/env node
// Await all first builds before launch and restart on main-process output changes.
// Keep profiles and stale-process cleanup isolated by checkout path.

import { spawn, spawnSync } from "node:child_process";
import { windowsPowerShellEnv } from "./lib/windows-powershell-env.mjs";
import { createHash } from "node:crypto";
import { existsSync, watch, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { waitForAllFirstBuilds } from "./lib/dev-watcher-gate.mjs";
import { shouldRelaunchDevChild } from "./lib/dev-relaunch-policy.mjs";
import { resolveBuildAssets } from "./lib/build-assets.mjs";
import { ensureElectronNativeModules } from "./lib/electron-native-modules.mjs";
import {
  extractUserDataDir,
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function cleanupStaleWindowsDevProcesses(userDataDir) {
  if (process.platform !== "win32") return;
  // Allow concurrent sessions to opt out of stale-process cleanup.
  if (
    process.env.AVE_DEV_NO_CLEANUP === "1" ||
    process.env.AVE_DEV_NO_CLEANUP === "true"
  ) {
    log("electron", "stale process cleanup skipped (AVE_DEV_NO_CLEANUP)");
    return;
  }
  const normalizedUserDataDir = String(userDataDir || "").trim();
  const localIndexerWorkspace = resolve(repoRoot, ".local-indexer-workspace");
  const launcherScriptPath = resolve(repoRoot, "scripts", "run-electron-dev.mjs");
  const mainEntryPath = mainOutput;
  if (!normalizedUserDataDir) return;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$currentPid = ${process.pid}`,
    `$userDataDir = '${escapePowerShellSingleQuoted(normalizedUserDataDir)}'`,
    `$localIndexerWorkspace = '${escapePowerShellSingleQuoted(localIndexerWorkspace)}'`,
    `$launcherScriptPath = '${escapePowerShellSingleQuoted(launcherScriptPath)}'`,
    `$mainEntryPath = '${escapePowerShellSingleQuoted(mainEntryPath)}'`,
    "$killedPids = @()",
    // Match launcher processes by absolute script path; checkout basenames can collide.
    "$staleLaunchers = @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.ProcessId -ne $currentPid -and $_.CommandLine -like \"*$launcherScriptPath*\" })",
    "foreach ($launcher in $staleLaunchers) {",
    "  taskkill /PID $launcher.ProcessId /T /F | Out-Null",
    "  $killedPids += \"node:$($launcher.ProcessId)\"",
    "}",
    "$targets = @()",
    // Match child processes by full resolved profile and workspace paths, never shared substrings.
    "if ($userDataDir.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.CommandLine -like \"*$mainEntryPath*\" -and $_.CommandLine -like \"*$userDataDir*\" }",
    "}",
    "if ($localIndexerWorkspace.Length -gt 0) {",
    "  $targets += Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*local_indexer_worker.py*' -and $_.CommandLine -like \"*$localIndexerWorkspace*\" }",
    "}",
    "$targets = @($targets | Group-Object ProcessId | ForEach-Object { $_.Group[0] })",
    "foreach ($target in $targets) {",
    // Kill the process tree so stale children cannot survive the launcher.
    "  taskkill /PID $target.ProcessId /T /F | Out-Null",
    "  $killedPids += \"$($target.Name):$($target.ProcessId)\"",
    "}",
    "Write-Output (\"killed=\" + $killedPids.Count + \" pids=\" + ($killedPids -join ','))",
  ].join("; ");

  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: windowsPowerShellEnv() },
    );
    // Check process status before parsing output; error text must not be logged as successful cleanup.
    if (result.error) {
      log("electron", `stale process cleanup skipped: ${result.error.message}`);
      return;
    }
    if (typeof result.status === "number" && result.status !== 0) {
      const detail = (`${result.stderr ?? ""}` || `${result.stdout ?? ""}`).trim()
        || `exit code ${result.status}`;
      log("electron", `stale process cleanup failed: ${detail}`);
      return;
    }
    const output = `${result.stdout ?? ""}`.trim();
    // Log removed process identities so unexpected session shutdowns can be traced.
    if (output && !/^killed=0\b/.test(output)) {
      log("electron", `cleaned stale dev processes (${output})`);
    }
  } catch (err) {
    log("electron", `stale process cleanup skipped: ${err.message}`);
  }
}

function pruneDuplicateMainElectronProcesses(userDataDir, keepPid) {
  if (process.platform !== "win32") return;
  const normalizedUserDataDir = String(userDataDir || "").trim();
  const keep = Number(keepPid || 0);
  if (!normalizedUserDataDir || !Number.isFinite(keep) || keep <= 0) return;

  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$keepPid = ${keep}`,
    `$userDataDir = '${escapePowerShellSingleQuoted(normalizedUserDataDir)}'`,
    `$mainEntryPath = '${escapePowerShellSingleQuoted(mainOutput)}'`,
    "$targets = @(Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.ProcessId -ne $keepPid -and $_.CommandLine -like \"*$mainEntryPath*\" -and $_.CommandLine -like \"*$userDataDir*\" })",
    "$prunedPids = @()",
    "foreach ($target in $targets) {",
    "  taskkill /PID $target.ProcessId /T /F | Out-Null",
    "  $prunedPids += $target.ProcessId",
    "}",
    "Write-Output (\"pruned=\" + $prunedPids.Count + \" pids=\" + ($prunedPids -join ','))",
  ].join("; ");

  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: windowsPowerShellEnv() },
    );
    // Check process errors before interpreting pruning output as success.
    if (result.error) {
      log("electron", `duplicate main prune skipped: ${result.error.message}`);
      return;
    }
    if (typeof result.status === "number" && result.status !== 0) {
      const detail = (`${result.stderr ?? ""}` || `${result.stdout ?? ""}`).trim()
        || `exit code ${result.status}`;
      log("electron", `duplicate main prune failed: ${detail}`);
      return;
    }
    const output = `${result.stdout ?? ""}`.trim();
    if (output && !/^pruned=0\b/.test(output)) {
      log("electron", `pruned duplicate electron main instances (${output})`);
    }
  } catch (err) {
    log("electron", `duplicate main prune skipped: ${err.message}`);
  }
}

function parseMsEnv(name, fallbackMs) {
  const raw = process.env[name];
  if (!raw) return fallbackMs;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallbackMs;
  return parsed;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashFile(filePath) {
  try {
    const buf = readFileSync(filePath);
    return createHash("sha1").update(buf).digest("hex");
  } catch {
    return "";
  }
}

// Set the code page in the same console as the launched process.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
// Hash the absolute checkout path into the profile name to prevent sibling cleanup collisions.
const repoRootHash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8);
const DEV_PROFILE_NAME = process.env.AVE_DEV_PROFILE_NAME || `Electron-Ave-Dev-${basename(repoRoot)}-${repoRootHash}`;
const binDir = resolve(repoRoot, "node_modules/.bin");
const mainOutput = resolve(repoRoot, "dist/src/main/main.js");
const [indexHtmlAsset] = resolveBuildAssets(repoRoot, "app-shell");
const htmlSrc = indexHtmlAsset.src;
const htmlOut = indexHtmlAsset.out;
// Ship the external bootstrap with the page; the shell policy rejects inline module scripts.
const pluginShellAssets = resolveBuildAssets(repoRoot, "plugin-shell");
// Dev and shipped builds share the runtime-asset registry.
const runtimeScriptAssets = resolveBuildAssets(repoRoot, "runtime-script");

const RESTART_DELAY_MS = parseMsEnv("AVE_DEV_RESTART_DELAY_MS", 2500);
const RESTART_FORCE_KILL_MS = parseMsEnv("AVE_DEV_RESTART_FORCE_KILL_MS", 3000);

const children = [];
const fsWatchDisposers = [];
let electronProc = null;
let restartTimer = null;
let shuttingDown = false;
let restartInFlight = false;
let shutdownPromise = null;
let lastMainOutputHash = "";

function log(tag, msg) {
  process.stdout.write(`[dev:${tag}] ${msg}\n`);
}
function startResilientWatch(tag, targetPath, onChange, options = {}) {
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? options.retryDelayMs : 750;
  const watchOptions = { persistent: true, ...(options.watchOptions ?? {}) };
  let watcher = null;
  let retryTimer = null;
  let closed = false;

  const scheduleRetry = () => {
    if (closed || shuttingDown || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, retryDelayMs);
  };

  const start = () => {
    if (closed || shuttingDown) return;
    try {
      watcher = watch(targetPath, watchOptions, onChange);
      watcher.on("error", (err) => {
        log(tag, `watch error (${targetPath}): ${err.message}`);
        try {
          watcher?.close();
        } catch {}
        watcher = null;
        scheduleRetry();
      });
    } catch (err) {
      log(tag, `watch failed (${targetPath}): ${err.message}`);
      scheduleRetry();
    }
  };

  start();

  return () => {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (watcher) {
      try {
        watcher.close();
      } catch {}
      watcher = null;
    }
  };
}

function forceKillProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

async function stopElectronForRestart() {
  const proc = electronProc;
  if (!proc) return;
  const pid = proc.pid;
  await new Promise((resolve) => {
    let finished = false;
    let killTimer = null;
    const done = () => {
      if (finished) return;
      finished = true;
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    proc.once("exit", done);
    killTimer = setTimeout(() => {
      log("electron", `restart timeout -> force killing process tree (pid=${pid ?? "unknown"})`);
      forceKillProcessTree(pid);
    }, RESTART_FORCE_KILL_MS);
    try {
      proc.kill("SIGTERM");
    } catch {
      done();
    }
  });
  await sleep(RESTART_DELAY_MS);
}

function resolveLocalBin(name) {
  const candidates = process.platform === "win32"
    ? [resolve(binDir, `${name}.exe`), resolve(binDir, `${name}.cmd`), resolve(binDir, name)]
    : [resolve(binDir, name)];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

// Readiness promises let skip-write watchers signal completion without timestamp changes.
const watcherReady = new Map();

function stripAnsi(value) {
  return String(value).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function suppressTailwindStatusLine(line) {
  const normalized = stripAnsi(line).trim();
  return (
    normalized === "" ||
    /^Done in \d+(?:\.\d+)?(?:ms|s|[\u00b5\u03bc]s)$/.test(normalized) ||
    /^(?:\u2248\s*)?tailwindcss v\d+\.\d+\.\d+/.test(normalized)
  );
}

function createLineWriter(sink, suppressLine) {
  let pending = "";
  return {
    write(chunk) {
      if (typeof suppressLine !== "function") {
        sink.write(chunk);
        return;
      }
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!suppressLine(line)) sink.write(`${line}\n`);
      }
    },
    flush() {
      if (pending && !suppressLine(pending)) sink.write(pending);
      pending = "";
    },
  };
}

function spawnWatcher(tag, cmd, args, opts = {}) {
  const { readyPattern, suppressStderrLine, ...spawnOpts } = opts;
  // Capture readiness signals while retaining diagnostics on both output streams.
  if (readyPattern) {
    let resolveReady;
    const promise = new Promise((r) => { resolveReady = r; });
    watcherReady.set(tag, { resolve: resolveReady, promise });
  }
  const shouldPipeStdout = Boolean(readyPattern);
  const shouldPipeStderr = Boolean(readyPattern || suppressStderrLine);
  const child = spawn(cmd, args, {
    cwd: repoRoot,
    // Build-complete signals may arrive on either stream; scan and tee both.
    stdio: [
      "ignore",
      shouldPipeStdout ? "pipe" : "inherit",
      shouldPipeStderr ? "pipe" : "inherit",
    ],
    env: { ...process.env, AVE_DEV: "1" },
    shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
    ...spawnOpts,
  });
  if (readyPattern || suppressStderrLine) {
    let matched = false;
    let readyScanBuffer = "";
    const stdoutWriter = createLineWriter(process.stdout);
    const stderrWriter = createLineWriter(process.stderr, suppressStderrLine);
    const scan = (chunk, writer) => {
      if (readyPattern && !matched) {
        readyScanBuffer += chunk.toString();
        if (readyScanBuffer.length > 4096) readyScanBuffer = readyScanBuffer.slice(-4096);
        if (readyPattern.test(stripAnsi(readyScanBuffer))) {
          matched = true;
          readyScanBuffer = "";
          const entry = watcherReady.get(tag);
          if (entry) entry.resolve();
        }
      }
      writer.write(chunk);
    };
    if (child.stdout) {
      child.stdout.on("data", (c) => scan(c, stdoutWriter));
      child.stdout.on("end", () => stdoutWriter.flush());
    }
    if (child.stderr) {
      child.stderr.on("data", (c) => scan(c, stderrWriter));
      child.stderr.on("end", () => stderrWriter.flush());
    }
  }
  child.on("error", (err) => {
    log(tag, `spawn failed: ${err.message}`);
    shutdown(1);
  });
  child.on("exit", (code) => {
    if (!shuttingDown) log(tag, `watcher exited code=${code}`);
  });
  children.push(child);
  return child;
}

function runStep(tag, cmd, args, options = {}) {
  // Merge environment defaults before caller overrides and keep the working-directory default outside rest options.
  const { env: callerEnv, cwd: callerCwd, ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
      ...rest,
      cwd: callerCwd ?? repoRoot,
      env: { ...process.env, AVE_DEV: "1", ...(callerEnv ?? {}) },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${tag} failed (exit=${code ?? "null"})`));
      }
    });
  });
}

function copyHtml() {
  try {
    mkdirSync(dirname(htmlOut), { recursive: true });
    copyFileSync(htmlSrc, htmlOut);
    log("html", "copied index.html");
  } catch (err) {
    log("html", `copy failed: ${err.message}`);
  }
}

function copyPluginShellAsset(asset) {
  try {
    mkdirSync(dirname(asset.out), { recursive: true });
    copyFileSync(asset.src, asset.out);
    log("plugin-shell", `copied ${asset.label}`);
  } catch (err) {
    log("plugin-shell", `copy failed (${asset.label}): ${err.message}`);
  }
}

function copyAllPluginShellAssets() {
  for (const asset of pluginShellAssets) copyPluginShellAsset(asset);
}

function copyRuntimeScriptAsset(asset) {
  try {
    mkdirSync(dirname(asset.out), { recursive: true });
    copyFileSync(asset.src, asset.out);
    log("runtime-script", `copied ${asset.label}`);
  } catch (err) {
    log("runtime-script", `copy failed (${asset.label}): ${err.message}`);
  }
}

function copyAllRuntimeScriptAssets() {
  for (const asset of runtimeScriptAssets) copyRuntimeScriptAsset(asset);
}

async function stopChildProcess(proc, { forceTree = false } = {}) {
  if (!proc?.pid) return;
  if (forceTree && process.platform === "win32") {
    forceKillProcessTree(proc.pid);
    return;
  }
  await new Promise((resolve) => {
    let doneCalled = false;
    let killTimer = null;
    const done = () => {
      if (doneCalled) return;
      doneCalled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve();
    };
    proc.once("exit", done);
    killTimer = setTimeout(() => {
      forceKillProcessTree(proc.pid);
      done();
    }, RESTART_FORCE_KILL_MS);
    try {
      proc.kill("SIGTERM");
    } catch {
      done();
    }
  });
}

function launchElectron() {
  if (electronProc) return;
  const launchEnv = (() => {
    const e = {
      ...process.env,
      AVE_DEV: "1",
      AVE_DEV_LAUNCHER: "1",
      AVE_DEV_CONSOLE: process.env.AVE_DEV_CONSOLE ?? "1",
      // Development logging is selected at module load; set the environment before launch.
      NODE_ENV: process.env.NODE_ENV ?? "development",
    };
    return prepareElectronLaunchEnv(e);
  })();
  const electronArgs = prepareElectronLaunchArgs([mainOutput], launchEnv, {
    profileName: DEV_PROFILE_NAME,
  });
  const userDataDir = extractUserDataDir(electronArgs);
  cleanupStaleWindowsDevProcesses(userDataDir);
  log("electron", `launching ${mainOutput}`);
  const env = launchEnv;
  if (process.platform === "win32") {
    electronProc = spawn(electronPath, electronArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      windowsHide: false,
    });
  } else {
    electronProc = spawn(electronPath, electronArgs, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });
  }
  if (electronProc?.pid) {
    setTimeout(() => {
      pruneDuplicateMainElectronProcesses(userDataDir, electronProc?.pid ?? 0);
    }, 5000);
  }
  electronProc.on("error", (err) => {
    log("electron", `spawn failed: ${err.message}`);
    electronProc = null;
    shutdown(1);
  });
  electronProc.on("exit", (code, signal) => {
    log("electron", `exited code=${code} signal=${signal ?? "-"}`);
    electronProc = null;
    if (!shuttingDown && !restartInFlight && shouldRelaunchDevChild(code, signal)) {
      launchElectron();
      return;
    }
    if (!shuttingDown && !restartInFlight && signal !== "SIGTERM" && signal !== "SIGKILL") {
      shutdown(0);
    }
  });
}

function scheduleRestart() {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    void (async () => {
      restartTimer = null;
      if (shuttingDown || restartInFlight) return;
      restartInFlight = true;
      try {
        if (electronProc) {
          log("electron", `main changed -> restarting (grace=${RESTART_DELAY_MS}ms)`);
          await stopElectronForRestart();
        } else {
          await sleep(RESTART_DELAY_MS);
        }
        if (!shuttingDown) launchElectron();
      } finally {
        restartInFlight = false;
      }
    })();
  }, 400);
}

// Await fresh output or readiness signals from every watcher before launch.
// Skip-write styles builds require signals rather than mtime changes.
function makeWatcherList() {
  // Missing readiness setup must fail instead of silently polling an unchanged styles timestamp.
  if (!watcherReady.has("styles")) {
    throw new Error(
      "makeWatcherList: styles watcher not spawned yet — call spawnWatcher('styles', ...) first",
    );
  }
  return [
    { tag: "main",           label: "Main process (esbuild)",  output: resolve(repoRoot, "dist/src/main/main.js") },
    { tag: "preload",        label: "Preload (esbuild)",       output: resolve(repoRoot, "dist/src/preload.cjs") },
    { tag: "plugin-preload", label: "Plugin preload (esbuild)",output: resolve(repoRoot, "dist/src/plugin-preload.cjs") },
    { tag: "renderer",       label: "Renderer (esbuild)",      output: resolve(repoRoot, "dist/src/renderer.js") },
    { tag: "styles",         label: "Styles (Tailwind)",       readyPromise: watcherReady.get("styles")?.promise },
  ];
}

function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  restartInFlight = false;
  log("dev", "shutting down");
  const activeElectron = electronProc;
  const activeChildren = children.splice(0, children.length);
  const activeFsWatchDisposers = fsWatchDisposers.splice(0, fsWatchDisposers.length);
  electronProc = null;
  shutdownPromise = (async () => {
    for (const dispose of activeFsWatchDisposers) {
      try {
        dispose();
      } catch {}
    }
    await Promise.allSettled([
      ...(activeElectron ? [stopChildProcess(activeElectron)] : []),
      ...activeChildren.map((child) => stopChildProcess(child, { forceTree: process.platform === "win32" })),
    ]);
    process.exit(code);
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});
process.on("uncaughtException", (err) => {
  if (err?.code === "EPERM" && err?.syscall === "watch") {
    log("watch", `transient watcher EPERM suppressed: ${err.message}`);
    return;
  }
  throw err;
});
process.on("exit", () => {
  if (electronProc?.pid) forceKillProcessTree(electronProc.pid);
  for (const child of children) {
    if (child?.pid) forceKillProcessTree(child.pid);
  }
});

async function main() {
  log("dev", "AVE_DEV=1");
  ensureElectronNativeModules({
    repoRoot,
    log: (message) => log("native", message),
  });
  // Capture the baseline before spawning so stale output cannot satisfy first-build readiness.
  const launcherStartedAt = Date.now();
  // Build the watcher list after spawning so all readiness promises exist.

  copyHtml();
  fsWatchDisposers.push(startResilientWatch("html", htmlSrc, () => copyHtml()));

  // Watch the shell page and external bootstrap together.
  copyAllPluginShellAssets();
  for (const asset of pluginShellAssets) {
    fsWatchDisposers.push(
      startResilientWatch("plugin-shell", asset.src, () => copyPluginShellAsset(asset)),
    );
  }

  copyAllRuntimeScriptAssets();
  for (const asset of runtimeScriptAssets) {
    fsWatchDisposers.push(
      startResilientWatch("runtime-script", asset.src, () => copyRuntimeScriptAsset(asset)),
    );
  }

  // Use the shipped bundle recipe so development and production share the same entry path.
  spawnWatcher("main", process.execPath, [resolve(repoRoot, "scripts/build-main-esbuild.mjs"), "--watch"]);

  // Emit the exact .cjs filename the runtime loads or development can retain a stale preload.
  spawnWatcher("preload", resolveLocalBin("esbuild"), [
    "src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=dist/src/preload.cjs",
    "--watch=forever",
  ]);

  // Match the literal .cjs preload target used by the webview.
  spawnWatcher("plugin-preload", resolveLocalBin("esbuild"), [
    "src/plugin-preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=dist/src/plugin-preload.cjs",
    "--watch=forever",
  ]);

  spawnWatcher("renderer", resolveLocalBin("esbuild"), [
    "src/renderer.tsx",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--outfile=dist/src/renderer.js",
    "--watch=forever",
  ]);

  // Styles can skip identical writes; use the first completion signal instead of output mtime.
  spawnWatcher("styles", resolveLocalBin("tailwindcss"), [
    "-i",
    "src/styles.css",
    "-o",
    "dist/src/styles.css",
    "--watch=always",
  ], {
    readyPattern: /(^|\n)Done in \d+(?:\.\d+)?(?:ms|s|[\u00b5\u03bc]s)\b/,
    suppressStderrLine: suppressTailwindStatusLine,
  });

  // Await every first build so the page cannot load before styles and renderer assets exist.
  const watchers = makeWatcherList();
  const ok = await waitForAllFirstBuilds(watchers, launcherStartedAt, log);
  if (!ok) {
    log("dev", "timed out waiting for watchers — see [dev:progress] FAIL lines above");
    await shutdown(1);
    return;
  }
  log("progress", "all watchers ready — launching Electron");

  lastMainOutputHash = hashFile(mainOutput);
  launchElectron();

  fsWatchDisposers.push(
    startResilientWatch("main", mainOutput, () => {
      const nextHash = hashFile(mainOutput);
      if (!nextHash || nextHash === lastMainOutputHash) return;
      lastMainOutputHash = nextHash;
      scheduleRestart();
    }),
  );
}

main().catch((err) => {
  log("dev", `fatal: ${err?.stack ?? err}`);
  void shutdown(1);
});
