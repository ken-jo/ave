import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  prepareElectronLaunchArgs,
  prepareElectronLaunchEnv,
} from "./lib/electron-launch-options.mjs";

const INSPECTOR_LINE = /^Debugger listening on (ws:\/\/127\.0\.0\.1:(?!9222\/)[1-9]\d*\/[\da-f-]+)$/u;
const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));

async function withDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function parseLog(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function checkDevBoot(child, requestQuit, {
  bootTimeoutMs = 90_000,
  quitTimeoutMs = 30_000,
  onLine = () => {},
} = {}) {
  const boot = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const failed = Promise.withResolvers();
  const shutdown = new AbortController();
  let interfaceLoaded = false;
  let inspectorUrl;
  let quitting = false;
  let mxcRuntimeRoot = "unknown (no boot status reported)";
  const outputs = [child.stdout, child.stderr].map((input) => {
    const output = createInterface({ input, crlfDelay: Infinity });
    output.on("line", (line) => {
      const endpoint = input === child.stderr && INSPECTOR_LINE.exec(line);
      if (endpoint) {
        inspectorUrl = endpoint[1];
      } else {
        onLine(line);
        const record = parseLog(line);
        if (record?.mxcState === "available") {
          mxcRuntimeRoot = "available";
        } else if (record?.mxcState === "unavailable" && typeof record.mxcReason === "string"
          && /^[a-z][a-z0-9-]*$/u.test(record.mxcReason) && typeof record.mxcDetail === "string") {
          const detail = record.mxcDetail.replace(/[\r\n\u2028\u2029]+/gu, " ").trim();
          mxcRuntimeRoot = `unavailable (${record.mxcReason}: ${detail})`;
        }
        if (record?.msg === "main interface loaded" && record.reason === "bootstrap-complete") {
          interfaceLoaded = true;
        }
        const message = record?.msg;
        if (typeof message === "string" && (message === "bootstrap failed" || message === "shutdown cleanup timed out"
          || message.startsWith("before-quit: shutdown cleanup failed:")
          || (message === "failed to load index.html" && record.reason === "bootstrap-complete"))) {
          failed.reject(new Error(message));
        }
      }
      if (interfaceLoaded && inspectorUrl) boot.resolve(inspectorUrl);
    });
    output.on("error", failed.reject);
    return output;
  });
  child.once("error", failed.reject);
  child.once("close", closed.resolve);
  child.once("exit", (code, signal) => {
    const status = signal ? `signal ${signal}` : `code ${code}`;
    if (!quitting) failed.reject(new Error(`Development desktop exited before quit (${status})`));
    else if (code !== 0 || signal) failed.reject(new Error(`Development desktop quit with ${status}`));
  });

  try {
    const url = await withDeadline(Promise.race([boot.promise, failed.promise]),
      bootTimeoutMs, "Timed out waiting for development desktop boot");
    quitting = true;
    const quitAndExit = async () => {
      await requestQuit(url, shutdown.signal);
      await closed.promise;
    };
    await withDeadline(Promise.race([quitAndExit(), failed.promise]),
      quitTimeoutMs, "Timed out waiting for development desktop to quit");
  } finally {
    shutdown.abort();
    for (const output of outputs) output.close();
    onLine(`mxc-runtime-root: ${mxcRuntimeRoot}`);
  }
}

async function requestInspectorQuit(url, signal) {
  const socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", () => socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: "((app) => { setImmediate(() => app.quit()); })(require('electron').app)",
          includeCommandLineAPI: true,
        },
      })), { once: true });
      socket.addEventListener("message", ({ data }) => {
        const reply = JSON.parse(data);
        if (reply.id !== 1) return;
        if (reply.error || reply.result?.exceptionDetails || !reply.result) {
          reject(new Error("Inspector rejected the development desktop quit request"));
        } else {
          resolve();
        }
      });
      socket.addEventListener("error", () => reject(new Error("Development desktop inspector connection failed")));
      socket.addEventListener("close", () => reject(new Error("Inspector disconnected before acknowledging quit")));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } finally {
    socket.close();
  }
}

async function smokeWindowsDevBoot() {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (process.platform !== "win32" || !runnerTemp || !isAbsolute(runnerTemp)
    || !process.env.AVE_CI_JOB_ROOT || process.env.AVE_CI_REQUIRE_EMPTY_JOB !== "1") {
    throw new Error("Development desktop smoke requires the isolated Windows CI job");
  }
  const root = mkdtempSync(join(runnerTemp, "ave-dev-boot-"));
  const env = prepareElectronLaunchEnv({
    ...process.env,
    AVE_HOME: join(root, "home"),
    AVE_LOG_FORMAT: "json",
    LOG_LEVEL: "info",
    NODE_ENV: "development",
  });
  const args = prepareElectronLaunchArgs([
    "--inspect=127.0.0.1:0",
    join(REPOSITORY, "dist/src/main/main.js"),
    `--user-data-dir=${join(root, "profile")}`,
  ], env);
  const { default: executable } = await import("electron");
  const child = spawn(executable, args, { cwd: REPOSITORY, env, stdio: ["ignore", "pipe", "pipe"] });

  try {
    await checkDevBoot(child, requestInspectorQuit, { onLine: (line) => console.log(line) });
    console.log("Development desktop loaded its main interface and exited with code 0.");
  } finally {
    // The enclosing job reaps the process tree if the launch or clean quit fails.
    child.stdout.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await smokeWindowsDevBoot();
}
