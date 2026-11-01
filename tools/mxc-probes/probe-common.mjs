import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";

export const PROBE_NAMES = ["node-ui", "loopback", "stdio-lifetime", "kernel-objects", "shell-ui"];

// Read the numeric entries from the owning policy without loading app code in a standalone probe.
export async function loadBudgets() {
  const source = await readFile(new URL("../../src/shared/tool-timeout-policy.ts", import.meta.url), "utf8");
  const entries = ["windowsAclHostStartupMs", "mxcRequestTransportMs", "pluginShutdownHandlerMs", "processGroupPollMs"];
  return Object.fromEntries(entries.map((key) => {
    const value = source.match(new RegExp(`^  ${key}: ([\\d_]+),$`, "m"))?.[1];
    if (!value) throw new Error(`Unsupported timeout policy entry: ${key}`);
    return [key, Number(value.replaceAll("_", ""))];
  }));
}

export function windowsQuote(value) {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new Error("Invalid command argument");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function parseOptions(argv) {
  const options = {};
  for (let at = 0; at < argv.length; at += 2) {
    const key = argv[at];
    if (!["--sdk-root", "--runtime", "--git-bash", "--git-root"].includes(key)
      || options[key.slice(2)] || !argv[at + 1] || !path.isAbsolute(argv[at + 1])) {
      throw new Error("Expected unique --sdk-root/--runtime/--git-bash/--git-root absolute paths");
    }
    options[key.slice(2)] = path.resolve(argv[at + 1]);
  }
  if (!options["sdk-root"] || !options.runtime) throw new Error("--sdk-root and --runtime are required");
  if (Boolean(options["git-bash"]) !== Boolean(options["git-root"])) throw new Error("Supply both --git-bash and --git-root");
  if (options["git-bash"] && !isWithin(options["git-bash"], options["git-root"])) throw new Error("Git Bash must be within --git-root");
  return options;
}

export function isWithin(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function safeEnvironment(temp) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT"]) {
    const actual = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actual) env[key] = process.env[actual];
  }
  return { ...env, SYSTEMROOT: env.SystemRoot, HOME: temp, USERPROFILE: temp, LOCALAPPDATA: temp,
    APPDATA: temp, TEMP: temp, TMP: temp, TMPDIR: temp, ELECTRON_RUN_AS_NODE: "1" };
}

export async function runProbe(name) {
  let verdict;
  try {
    if (!PROBE_NAMES.includes(name)) throw new Error("Unknown probe");
    if (process.platform !== "win32") {
      verdict = { probe: name, verdict: "unavailable", reason: "Windows interactive session required" };
    } else {
      const options = parseOptions(process.argv.slice(2));
      const budgets = await loadBudgets();
      const temp = await mkdtemp(path.join(tmpdir(), "ave-mxc-probes-"));
      const worker = fileURLToPath(new URL("./sdk-supervisor.mjs", import.meta.url));
      // The controller never loads the native SDK: even a native supervisor crash gets a JSON verdict.
      const env = { ...safeEnvironment(temp), MXC_PROBE_INPUT: JSON.stringify({ name, options, budgets, temp }) };
      const child = spawn(process.execPath, [worker], { cwd: temp, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const completion = captureChild(child, budgets.windowsAclHostStartupMs * 12);
      completion.catch(() => {});
      await writeFile(path.join(temp, "driver.json"), JSON.stringify({ supervisorPid: child.pid, startedAt: new Date().toISOString(), supervisorPath: worker }));
      const result = await completion;
      try {
        const lines = result.stdout.trimEnd().split(/\r?\n/);
        const parsed = JSON.parse(lines.pop());
        if (lines.length) parsed.nativeDiagnostics = lines.join("\n");
        if (result.code !== 0 || result.signal || result.timedOut) throw new Error("Supervisor failed");
        if (parsed.probe !== name || !["measured", "inconclusive", "error", "unavailable"].includes(parsed.verdict)) throw new Error("Invalid verdict");
        verdict = parsed;
      } catch {
        verdict = { probe: name, verdict: "error", reason: "Supervisor exited without a complete verdict",
          exitCode: result.code, signal: result.signal, timedOut: result.timedOut, stderr: result.stderr, temp, cleanupVerified: false };
      }
    }
  } catch (error) {
    verdict = { probe: name, verdict: "error", reason: String(error.message ?? error) };
  }
  process.stdout.write(JSON.stringify(verdict) + "\n");
  process.exitCode = verdict.verdict === "measured" ? 0 : 2;
}

export function captureChild(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "", stderr = "", timedOut = false;
    const cap = 1024 * 1024;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = (stdout + chunk).slice(-cap); });
    child.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-cap); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut }); });
  });
}

export async function spawnWithoutTelemetry(sdk, request, options) {
  if (options !== undefined || Object.hasOwn(request, "telemetry")) throw new Error("Probe telemetry must be omitted");
  return sdk.spawn(request);
}
