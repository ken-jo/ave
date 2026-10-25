/** Adversarial plugin fixture; run controls before interpreting filesystem, network or process denials. */
import { once } from "node:events";
import { readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 5_000;
/** Use a string forged ID so it cannot match runtime-allocated numeric IDs. */
const FORGED_REQUEST_ID = "adversarial-forged-getSecret";
const OWN_BYTES = "the adversarial plugin's own bytes";

function attempt(probe) {
  try {
    return { ok: true, value: probe() };
  } catch (error) {
    return { ok: false, code: errorCode(error), message: String(error?.message ?? error) };
  }
}

async function attemptAsync(probe) {
  try {
    return { ok: true, value: await probe() };
  } catch (error) {
    return { ok: false, code: errorCode(error), message: String(error?.message ?? error) };
  }
}

function errorCode(error) {
  return error?.code ?? error?.cause?.code ?? error?.name ?? typeof error;
}

function escaped(name, what) {
  return new Error(`[adversarial] ${name}: ${what} succeeded where the harness claims confinement`);
}

async function escapeSecrets(context, args) {
  const otherPluginId = args.otherPluginId ?? "neighbour";
  const sentinelName = args.sentinelName ?? "sentinel.txt";
  const secretsDir = args.secretsDir ?? join(context.aveHome, "secrets");
  const otherDataDir = args.otherDataDir ?? join(context.aveHome, "plugins", otherPluginId, "data");
  // Prove own-data read/write succeeds before interpreting neighbour failures as confinement.
  const ownFile = join(context.pluginDataDir, sentinelName);
  const own = {
    write: attempt(() => writeFileSync(ownFile, OWN_BYTES, "utf-8")),
    read: attempt(() => readFileSync(ownFile, "utf-8")),
  };
  const filesystem = {
    listSecrets: attempt(() => readdirSync(secretsDir)),
    readSecret: attempt(() => readFileSync(join(secretsDir, sentinelName), "utf-8")),
    listOtherData: attempt(() => readdirSync(otherDataDir)),
    readOtherData: attempt(() => readFileSync(join(otherDataDir, sentinelName), "utf-8")),
  };
  const hostApi = context.hostApi;
  const secrets = {
    foreignKey: `plugin.${otherPluginId}.key`,
    foreign: await attemptAsync(() => hostApi.getSecret(`plugin.${otherPluginId}.key`)),
    ownKey: `plugin.${context.pluginId}.key`,
    own: await attemptAsync(() => hostApi.getSecret(`plugin.${context.pluginId}.key`)),
  };
  // An empty mounted directory can list successfully; the sibling read establishes denial.
  const reached = [
    ...Object.entries(filesystem)
      .filter(([, probe]) => probe.ok && (!Array.isArray(probe.value) || probe.value.length > 0))
      .map(([name]) => name),
    ...(secrets.foreign.ok && secrets.foreign.value !== null ? ["getSecret(foreign)"] : []),
  ];
  if (args.expectConfined === true && reached.length > 0) throw escaped("escape_secrets", reached.join(", "));
  return {
    attempt: "escape_secrets",
    outcome: reached.length === 0 ? "confined" : "unconfined",
    own,
    filesystem,
    secrets,
  };
}

/** Capture worker output and exit, or report timeout without claiming denial. */
async function workerReads(context, workerId, command, file, allowReadPaths, waitMs) {
  return attemptAsync(async () => {
    const worker = await context.hostApi.spawnWorker({ workerId, command, args: [file], allowReadPaths, allowWritePaths: [] });
    let stdout = "";
    let stderr = "";
    worker.onStdout((chunk) => { stdout += chunk; });
    worker.onStderr((chunk) => { stderr += chunk; });
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), waitMs);
      worker.onExit(({ code }) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (exit === "timeout") worker.stop();
    return { stdout, stderr, exit };
  });
}

async function escapeWorker(context, args) {
  const otherPluginId = args.otherPluginId ?? "neighbour";
  const sentinelName = args.sentinelName ?? "sentinel.txt";
  const otherDataDir = args.otherDataDir ?? join(context.aveHome, "plugins", otherPluginId, "data");
  const command = args.command ?? "/bin/cat";
  const waitMs = args.waitMs ?? PROBE_TIMEOUT_MS;
  // The worker must read granted own data before a neighbour failure proves confinement.
  const ownFile = join(context.pluginDataDir, sentinelName);
  writeFileSync(ownFile, OWN_BYTES, "utf-8");
  const own = await workerReads(context, "adversarial-own", command, ownFile, [context.pluginDataDir], waitMs);
  const other = await workerReads(context, "adversarial-other", command, join(otherDataDir, sentinelName), [], waitMs);
  const reached = other.ok && other.value.exit === 0 && other.value.stdout.length > 0 ? ["worker(otherData)"] : [];
  if (args.expectConfined === true && reached.length > 0) throw escaped("escape_worker", reached.join(", "));
  return { attempt: "escape_worker", outcome: reached.length === 0 ? "confined" : "unconfined", own, other };
}

function rawConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, code: "timeout" });
    }, PROBE_TIMEOUT_MS);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok: true, value: "connected" });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: errorCode(error), message: String(error.message) });
    });
  });
}

async function escapeNetwork(context, args) {
  const host = "127.0.0.1";
  const port = args.port;
  const deniedUrl = args.deniedUrl ?? "https://not-allowed.invalid/escape";
  const raw = {
    connect: await rawConnect(host, port),
    fetch: await attemptAsync(async () => {
      const response = await globalThis.fetch(`http://${host}:${port}/escape`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return response.status;
    }),
  };
  const hostFetch = {
    url: deniedUrl,
    ...(await attemptAsync(async () => (await context.hostApi.hostFetch(deniedUrl)).status)),
  };
  const reached = [
    ...Object.entries(raw).filter(([, probe]) => probe.ok).map(([name]) => name),
    ...(hostFetch.ok ? ["hostFetch(undeclared)"] : []),
  ];
  if (args.expectConfined === true && reached.length > 0) throw escaped("escape_network", reached.join(", "));
  return { attempt: "escape_network", outcome: reached.length === 0 ? "confined" : "unconfined", raw, hostFetch };
}

function describeModule(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return { kind: typeof value, BrowserWindow: "undefined", session: "undefined", ipcMain: "undefined", app: "undefined" };
  }
  return {
    kind: typeof value,
    BrowserWindow: typeof value.BrowserWindow,
    session: typeof value.session,
    ipcMain: typeof value.ipcMain,
    app: typeof value.app,
  };
}

function carriesApi(described) {
  return described.BrowserWindow === "function"
    || described.session === "object"
    || described.ipcMain === "object"
    || described.app === "object";
}

/** Probe APIs independently; guarding one does not protect the others. */
function useApi(module) {
  return {
    newBrowserWindow: attempt(() => typeof new module.BrowserWindow({ show: false })),
    defaultSession: attempt(() => typeof module.session.defaultSession),
    ipcMainHandle: attempt(() => {
      module.ipcMain.handle("adversarial", () => "escaped");
      return "registered";
    }),
  };
}

/** Probe each module-resolution form independently; requireFrom anchors bare-specifier resolution. */
export async function probeElectron(requireFrom = import.meta.url, vendoredDir = join(HERE, "vendored-electron")) {
  const require = createRequire(requireFrom);
  const forms = {
    // Process version identifies the binary, not whether main-process APIs are usable.
    version: process.versions.electron ?? null,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    requireBare: attempt(() => require("electron")),
    importBare: await attemptAsync(() => import("electron")),
    requireVendored: attempt(() => require(join(vendoredDir, "index.js"))),
  };
  const resolved = {};
  const uses = {};
  for (const name of ["requireBare", "importBare", "requireVendored"]) {
    const form = forms[name];
    if (!form.ok) continue;
    resolved[name] = describeModule(form.value);
    uses[name] = useApi(form.value);
    if (name === "importBare") {
      resolved.importBareDefault = describeModule(form.value.default);
      uses.importBareDefault = useApi(form.value.default ?? {});
    }
  }
  const usable = Object.entries(resolved).filter(([, described]) => carriesApi(described)).map(([name]) => name);
  for (const [name, used] of Object.entries(uses)) {
    for (const [use, answer] of Object.entries(used)) if (answer.ok) usable.push(`${name}.${use}`);
  }
  return {
    attempt: "escape_electron",
    outcome: usable.length === 0 ? "no-usable-api" : "usable-api",
    version: forms.version,
    runAsNode: forms.runAsNode,
    requireBare: forms.requireBare.ok ? { ok: true, module: resolved.requireBare } : forms.requireBare,
    importBare: forms.importBare.ok
      ? { ok: true, module: resolved.importBare, defaultModule: resolved.importBareDefault }
      : forms.importBare,
    requireVendored: forms.requireVendored.ok
      ? { ok: true, module: resolved.requireVendored }
      : forms.requireVendored,
    uses,
    usable,
  };
}

async function escapeElectron() {
  const report = await probeElectron();
  // Neither validation nor confinement may run a plugin as a main-process module.
  if (report.usable.length > 0) throw escaped("escape_electron", `main-process API through ${report.usable.join(", ")}`);
  return report;
}

/** Patch process-local globals and return a restore function; the harness control proves the patch actually landed. */
export function patch() {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  globalThis.fetch = async () => {
    throw new Error("[adversarial] the plugin replaced fetch");
  };
  process.stdout.write = function patchedWrite(...args) {
    return originalWrite.apply(this, args);
  };
  return () => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  };
}

/** Write directly only after queued framed output drains. */
async function writeFd1(text) {
  if (process.stdout.writableLength > 0) await once(process.stdout, "drain");
  writeSync(1, text);
}

/** Find the actual runtime channel in active handles, for both stdio and Windows loopback. */
function protocolChannel() {
  const handles = typeof process._getActiveHandles === "function" ? process._getActiveHandles() : [];
  const sockets = handles.filter((handle) =>
    handle instanceof Socket && handle.remoteAddress === "127.0.0.1" && !handle.destroyed);
  if (sockets.length === 1) {
    const [socket] = sockets;
    return {
      readable: socket,
      write: async (text) => {
        if (!socket.write(text)) await once(socket, "drain");
      },
    };
  }
  return { readable: process.stdin, write: writeFd1 };
}

/** Forge identity fields in a raw secret request; the runtime drops its unmatched string ID while this listener reads it. */
async function forgeGetSecret(otherPluginId) {
  const channel = protocolChannel();
  const reply = new Promise((resolve) => {
    let buffered = "";
    const timer = setTimeout(() => {
      channel.readable.off("data", onData);
      resolve({ answered: false });
    }, PROBE_TIMEOUT_MS);
    function onData(chunk) {
      buffered += chunk.toString("utf-8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        if (frame?.id !== FORGED_REQUEST_ID) continue;
        clearTimeout(timer);
        channel.readable.off("data", onData);
        resolve({ answered: true, ...("result" in frame ? { result: frame.result } : { error: frame.error }) });
        return;
      }
    }
    channel.readable.on("data", onData);
  });
  const frame = {
    jsonrpc: "2.0",
    id: FORGED_REQUEST_ID,
    method: "ave/host/getSecret",
    params: {
      key: `plugin.${otherPluginId}.key`,
      pluginId: otherPluginId,
      _meta: { pluginId: otherPluginId },
    },
  };
  await channel.write(`${JSON.stringify(frame)}\n`);
  return { key: frame.params.key, ...(await reply) };
}

async function escapePatch(context, args) {
  const otherPluginId = args.otherPluginId ?? "neighbour";
  const fetchBefore = globalThis.fetch;
  const writeBefore = process.stdout.write;
  const restore = patch();
  const patched = {
    fetch: globalThis.fetch !== fetchBefore,
    stdoutWrite: process.stdout.write !== writeBefore,
  };
  try {
    if (args.emitNonJson === true) await protocolChannel().write("this line is not JSON\n");
    const forged = await forgeGetSecret(otherPluginId);
    const reached = forged.answered && forged.result !== null && forged.result !== undefined;
    if (args.expectConfined === true && reached) throw escaped("escape_patch", "a forged getSecret for another plugin");
    return {
      attempt: "escape_patch",
      outcome: reached ? "unconfined" : "confined",
      patched,
      emittedNonJson: args.emitNonJson === true,
      forged,
    };
  } finally {
    restore();
  }
}

export const createPlugin = async (context) => ({
  handlers: {
    escape_secrets: (args) => escapeSecrets(context, args ?? {}),
    escape_worker: (args) => escapeWorker(context, args ?? {}),
    escape_network: (args) => escapeNetwork(context, args ?? {}),
    escape_electron: () => escapeElectron(),
    escape_patch: (args) => escapePatch(context, args ?? {}),
  },
});
