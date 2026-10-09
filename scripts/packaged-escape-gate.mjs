#!/usr/bin/env node
/**
 * Admission's packaged gate for escape 3 (`docs/design/plugin-hostapi-protocol.md`
 * §9.8 A2, Gates (ii); decision 53): the Electron claim measured on the build
 * that ships, not on the development executable.
 *
 * Two halves, both against the unpacked executable electron-builder produced:
 *
 *  1. THE PROBES. The adversarial fixture's `probeElectron()` runs under the
 *     packaged executable with `ELECTRON_RUN_AS_NODE=1` — exactly what the
 *     production factory spawns for a plugin child — as a script from a
 *     temporary root outside the checkout. It must report the four shapes of
 *     table row 3: a version string (the trap), `require("electron")`
 *     `MODULE_NOT_FOUND`, `import("electron")` an inert namespace, the planted
 *     package a path string, and no usable API in any form.
 *  2. THE CONTROL. The packaged application's own main process, launched
 *     through Playwright with `ELECTRON_RUN_AS_NODE` removed, an isolated
 *     `--user-data-dir` and `AVE_HOME`, and asked with `app.evaluate` for
 *     `typeof BrowserWindow`, `typeof session.defaultSession` and
 *     `typeof ipcMain`: `"function"`, `"object"`, `"object"`. Without the
 *     variable the packaged executable starts the application rather than a
 *     helper script, so the development helper (`control-electron-main.cjs`)
 *     is never packaged evidence.
 *
 * A control that cannot launch fails the gate rather than passing it.
 *
 * Linux runs this under `xvfb-run -a` inside a D-Bus session with an unlocked
 * keyring, as the packaged smoke does, because the control is a full app.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import {
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";
import { findPackagedExecutable } from "./lib/packaged-executable-selection.mjs";
import { packagedEscapeGateEnvironment } from "./lib/packaged-escape-gate-environment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(root, "src", "plugins", "isolation", "__tests__", "fixtures", "adversarial");
const TARGET_PLATFORM = { mac: "darwin", linux: "linux", win: "win32" };
const PROBE_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 90_000;

function usage() {
  return [
    "Usage: node scripts/packaged-escape-gate.mjs --target <mac|linux|win|current> [--release-dir <path>]",
    "",
    "  --release-dir <path>   electron-builder output directory (default: release)",
  ].join("\n");
}

function parseArgs(argv) {
  let target = null;
  let releaseDir = resolve(root, "release");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") target = argv[++index] ?? null;
    else if (arg === "--release-dir") releaseDir = resolve(argv[++index] ?? "");
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}\n${usage()}`);
  }
  if (target === "current") {
    target = Object.entries(TARGET_PLATFORM).find(([, platform]) => platform === process.platform)?.[0] ?? null;
  }
  if (!target || !TARGET_PLATFORM[target]) throw new Error(`--target is required\n${usage()}`);
  if (TARGET_PLATFORM[target] !== process.platform) {
    throw new Error(`target ${target} must be measured on ${TARGET_PLATFORM[target]}; this is ${process.platform}`);
  }
  return { target, releaseDir };
}

function fail(message) {
  throw new Error(`[packaged-escape-gate] ${message}`);
}

function expectEqual(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Run `executable` with `args` and `env`, and return its exit and output. */
function run(executable, args, env, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

/**
 * The probes, from a temporary root: the fixture's entry and its planted
 * package copied there, beside a runner that calls `probeElectron()`. Outside
 * the checkout, no `node_modules` is reachable by walking up from it.
 */
async function measureProbes(executable, scratch) {
  const pluginRoot = join(scratch, "plugin");
  mkdirSync(pluginRoot, { recursive: true });
  cpSync(join(FIXTURE, "entry.mjs"), join(pluginRoot, "entry.mjs"));
  cpSync(join(FIXTURE, "vendored-electron"), join(pluginRoot, "vendored-electron"), { recursive: true });
  const runner = join(scratch, "probe-electron.mjs");
  writeFileSync(
    runner,
    `const { probeElectron } = await import(${JSON.stringify(pathToFileURL(join(pluginRoot, "entry.mjs")).href)});\n`
      + "process.stdout.write(`${JSON.stringify(await probeElectron())}\\n`);\n",
    "utf8",
  );
  const env = { ...packagedEscapeGateEnvironment(), ELECTRON_RUN_AS_NODE: "1", AVE_HOME: join(scratch, ".ave") };
  const { code, signal, stdout, stderr } = await run(executable, [runner], env, PROBE_TIMEOUT_MS);
  const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
  if (code !== 0 || line === undefined) {
    fail(`the probes did not report (exit ${code}, signal ${signal}): ${stderr.slice(-2_000)}`);
  }
  const report = JSON.parse(line);
  expectEqual(report.outcome, "no-usable-api", "probe outcome");
  expectEqual(report.usable, [], "forms carrying a usable API");
  expectEqual(report.runAsNode, "1", "ELECTRON_RUN_AS_NODE in the probe");
  if (typeof report.version !== "string") fail(`process.versions.electron is ${JSON.stringify(report.version)}, not a string`);
  expectEqual({ ok: report.requireBare.ok, code: report.requireBare.code }, { ok: false, code: "MODULE_NOT_FOUND" }, "require(\"electron\")");
  expectEqual(
    report.importBare.ok && report.importBare.module,
    { kind: "object", BrowserWindow: "undefined", session: "undefined", ipcMain: "undefined", app: "undefined" },
    "import(\"electron\")",
  );
  expectEqual(
    report.requireVendored.ok && {
      kind: report.requireVendored.module.kind,
      BrowserWindow: report.requireVendored.module.BrowserWindow,
    },
    { kind: "string", BrowserWindow: "undefined" },
    "the planted electron package",
  );
  for (const [form, uses] of Object.entries(report.uses)) {
    for (const [use, answer] of Object.entries(uses)) {
      if (answer.ok) fail(`${form}.${use} succeeded`);
    }
  }
  return report;
}

/** The packaged application's own main process, evaluated in place. */
async function measureControl(executable, scratch) {
  const userDataDir = join(scratch, "user-data");
  mkdirSync(userDataDir, { recursive: true });
  const env = prepareElectronLaunchEnv({
    ...packagedEscapeGateEnvironment(),
    HOME: join(scratch, "home"),
    USERPROFILE: join(scratch, "home"),
    AVE_HOME: join(scratch, ".ave"),
  });
  mkdirSync(env.HOME, { recursive: true });
  const args = prepareElectronLaunchArgs([`--user-data-dir=${userDataDir}`], env, { profileName: "Ave" });
  if (process.platform === "linux") args.push("--disable-gpu", "--no-sandbox", "--password-store=gnome-libsecret");
  // A build signed with an identity the login keychain has never seen asks the
  // user for keychain access the first time `safeStorage` runs, and that
  // prompt holds the main process until someone answers. The mock keychain is
  // Chromium's own test switch for exactly this; the measurement is about the
  // main process's API, not about the keychain.
  if (process.platform === "darwin") args.push("--use-mock-keychain");
  const app = await electron.launch({ executablePath: executable, args, env, timeout: CONTROL_TIMEOUT_MS });
  try {
    const reported = await app.evaluate(({ BrowserWindow, ipcMain, session }) => ({
      BrowserWindow: typeof BrowserWindow,
      defaultSession: typeof session.defaultSession,
      ipcMain: typeof ipcMain,
    }));
    expectEqual(reported, { BrowserWindow: "function", defaultSession: "object", ipcMain: "object" }, "the packaged main process");
    return reported;
  } finally {
    await app.close();
  }
}

async function main() {
  const { target, releaseDir } = parseArgs(process.argv.slice(2));
  const executable = findPackagedExecutable(target, releaseDir);
  if (!executable) fail(`no packaged executable for target=${target} under ${releaseDir}`);
  const scratch = mkdtempSync(join(tmpdir(), "ave-packaged-escape-gate-"));
  try {
    const control = await measureControl(executable, scratch);
    process.stdout.write(`[packaged-escape-gate] control ${JSON.stringify(control)}\n`);
    const probes = await measureProbes(executable, scratch);
    process.stdout.write(
      `[packaged-escape-gate] probes ${JSON.stringify({
        platform: process.platform,
        version: probes.version,
        requireBare: probes.requireBare.code,
        importBare: probes.importBare.module,
        requireVendored: probes.requireVendored.module.kind,
        usable: probes.usable,
      })}\n`,
    );
    process.stdout.write(`[packaged-escape-gate] passed for ${executable}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[packaged-escape-gate] FAILED: ${error.message}\n`);
  process.exit(1);
});
