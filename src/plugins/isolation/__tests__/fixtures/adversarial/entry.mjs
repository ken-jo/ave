/**
 * Admission's adversarial fixture (`docs/design/plugin-hostapi-protocol.md`
 * §9.8, "The four escapes, stated as assertions"; decision 53).
 *
 * One plugin, four tools, each attempting one escape a plugin had in process:
 *
 *  1. `escape_secrets` — read `<AVE_HOME>/secrets/` and another plugin's data
 *     directory, and ask the host for another plugin's secret beside its own;
 *     its own data directory is written and read back first, the in-sandbox
 *     control that the paths and the probe work;
 *     `escape_worker` asks the host for a delegated worker that reads the
 *     other plugin's data, after one that reads its own;
 *  2. `escape_network` — a raw socket and a global `fetch` to a loopback
 *     listener, and a `hostFetch` to a host outside `allowedDomains`;
 *  3. `escape_electron` — every module form that could hand back Electron's
 *     main-process API, then the uses that would prove it usable;
 *  4. `escape_patch` — patch `globalThis.fetch` and `process.stdout.write`,
 *     then write to the protocol channel directly — fd 1, or on a sandboxed
 *     Windows child the loopback socket it finds among the process's own
 *     handles: a forged `ave/host/getSecret` frame naming another plugin,
 *     and, when asked, a line that is not JSON.
 *
 * A tool THROWS only when an escape succeeds where the harness claims it
 * cannot — `expectConfined: true`, which the real-wrap suite passes — and
 * otherwise returns `{ attempt, outcome, … }` with every probe's answer, so the
 * validate CLI (which never confines, decision 30) and the wrap suite run the
 * same code. `escape_electron` is the exception that proves the rule: no
 * harness runs a plugin as Electron's main process, so "no usable main-process
 * API" is claimed under both and asserted under both.
 *
 * `patch()` and `probeElectron()` are exported for the callers outside a
 * plugin child: the wrap suite's control imports `patch()` into the test
 * process, and the packaged gate runs `probeElectron()` under the packaged
 * executable.
 */
import { once } from "node:events";
import { readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE_TIMEOUT_MS = 5_000;
/** The id the forged frame carries: a string, so it can never meet the runtime's numeric ids. */
const FORGED_REQUEST_ID = "adversarial-forged-getSecret";
/** What the controls write into the plugin's own data directory and read back. */
const OWN_BYTES = "the adversarial plugin's own bytes";

/** A synchronous probe's answer: its value, or the error's code. */
function attempt(probe) {
  try {
    return { ok: true, value: probe() };
  } catch (error) {
    return { ok: false, code: errorCode(error), message: String(error?.message ?? error) };
  }
}

/** An asynchronous probe's answer, in the same shape. */
async function attemptAsync(probe) {
  try {
    return { ok: true, value: await probe() };
  } catch (error) {
    return { ok: false, code: errorCode(error), message: String(error?.message ?? error) };
  }
}

/** The most specific code an error carries: its own, its cause's, or its name. */
function errorCode(error) {
  return error?.code ?? error?.cause?.code ?? error?.name ?? typeof error;
}

function escaped(name, what) {
  return new Error(`[adversarial] ${name}: ${what} succeeded where the harness claims confinement`);
}

// ── 1. the host's secrets ────────────────────────────────────────────────────

async function escapeSecrets(context, args) {
  const otherPluginId = args.otherPluginId ?? "neighbour";
  const sentinelName = args.sentinelName ?? "sentinel.txt";
  const secretsDir = args.secretsDir ?? join(context.aveHome, "secrets");
  const otherDataDir = args.otherDataDir ?? join(context.aveHome, "plugins", otherPluginId, "data");
  // The control inside the sandbox: the child writes and re-reads its own data
  // directory. A denial that looked like a missing path (bubblewrap answers
  // ENOENT) would otherwise pass for a wrong path, and a data directory the
  // wrap left read-only would go unseen.
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
  // A listing reaches something only when it names an entry: bubblewrap denies
  // a directory by mounting an empty tmpfs over it, so there the listing
  // succeeds, empty, and the read beside it is what fails.
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

/**
 * One delegated worker that prints a file: its stdout, stderr and exit, or
 * `timeout` when it has not exited within `waitMs`.
 */
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
  // The control: the same command, granted the plugin's own data directory,
  // prints what the child wrote there. A worker that cannot print it proves
  // nothing by failing to print the neighbour's.
  const ownFile = join(context.pluginDataDir, sentinelName);
  writeFileSync(ownFile, OWN_BYTES, "utf-8");
  const own = await workerReads(context, "adversarial-own", command, ownFile, [context.pluginDataDir], waitMs);
  // The escape: no grant at all, so only what the wrap leaves readable is read.
  const other = await workerReads(context, "adversarial-other", command, join(otherDataDir, sentinelName), [], waitMs);
  const reached = other.ok && other.value.exit === 0 && other.value.stdout.length > 0 ? ["worker(otherData)"] : [];
  if (args.expectConfined === true && reached.length > 0) throw escaped("escape_worker", reached.join(", "));
  return { attempt: "escape_worker", outcome: reached.length === 0 ? "confined" : "unconfined", own, other };
}

// ── 2. direct egress ─────────────────────────────────────────────────────────

/** A raw TCP connect: `connected`, or the error the platform answered with. */
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

// ── 3. Electron ──────────────────────────────────────────────────────────────

/** What `typeof` says about the four members a main-process plugin would reach for. */
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

/** Whether a resolved module carries any of the API, as a value a plugin could use. */
function carriesApi(described) {
  return described.BrowserWindow === "function"
    || described.session === "object"
    || described.ipcMain === "object"
    || described.app === "object";
}

/** The three uses, each attempted on its own: a guard on one does not protect the next. */
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

/**
 * Every form, separately (blueprint `plugin-process-isolation.md:949`): they do
 * not fail in the same place, and an author who hits one reaches for the next.
 * `requireFrom` is the module whose location the bare specifier resolves from.
 */
export async function probeElectron(requireFrom = import.meta.url, vendoredDir = join(HERE, "vendored-electron")) {
  const require = createRequire(requireFrom);
  const forms = {
    // The trap: the process IS Electron, so a version check says yes.
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
  // Claimed under every harness: neither the validator nor the wrap runs a
  // plugin as Electron's main process.
  if (report.usable.length > 0) throw escaped("escape_electron", `main-process API through ${report.usable.join(", ")}`);
  return report;
}

// ── 4. a host internal ───────────────────────────────────────────────────────

/**
 * Replace `globalThis.fetch` and `process.stdout.write` in whatever process
 * imports this, and hand back the restore. In a plugin child that is the
 * child's own copy; the control runs it in the test process to show the
 * replacement is real where it lands.
 */
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

/** Bytes straight to fd 1, after whatever the framer has queued has left. */
async function writeFd1(text) {
  if (process.stdout.writableLength > 0) await once(process.stdout, "drain");
  writeSync(1, text);
}

/**
 * The channel the runtime speaks to the host over, reached around it: fd 1 and
 * stdin for a stdio child; for a sandboxed Windows child, whose channel is a
 * loopback connection (`child-loopback-link.ts`), the one connected TCP socket
 * among the process's own handles — what a plugin that wanted to speak for
 * the runtime would go looking for.
 */
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

/**
 * A `ave/host/getSecret` request for another plugin's key, carrying the
 * identity fields a plugin would forge. The reply arrives on the channel like
 * every other: the runtime's own table holds no entry for this id and drops
 * it, and this listener reads it beside the runtime.
 */
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
