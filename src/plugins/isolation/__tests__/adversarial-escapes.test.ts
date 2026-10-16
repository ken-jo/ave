/**
 * Admission's adversarial fixture under the REAL wrap
 * (`docs/design/plugin-hostapi-protocol.md` §9.8 A2, "The four escapes, stated
 * as assertions"; decision 53).
 *
 * The fixture (`fixtures/adversarial/`) is staged into an isolated
 * `AVE_HOME` outside the checkout — the install location
 * `<AVE_HOME>/plugins/<id>` a real plugin has, with no `node_modules` above it
 * to walk into — beside a sentinel in `secrets/` and a second plugin's data
 * directory. It is spawned through the PRODUCTION factory with the production
 * child entry, and its host API is the PRODUCTION one: `createHostApiFactory`
 * with its four-tier secret gate, its audit sink (a real `AuditLogger` writing
 * into the isolated home) and its `hostFetch` guard. A recording double could
 * not prove a denial, so none stands behind the table.
 *
 * THE CONTROLS RUN FIRST, and an escape case asserts nothing until its control
 * held: the sentinel is readable from the test process, the listener accepts a
 * connection from it, a full Electron main process (`control-electron-main.cjs`
 * — the same binary with `ELECTRON_RUN_AS_NODE` removed) runs the fixture's own
 * detector and it reports the API usable, and `patch()` really replaces
 * `globalThis.fetch` where it runs. Inside the sandbox, the child writes and
 * reads back its own data directory, and a worker it asks for prints it, before
 * either is held to failing on a neighbour's. A probe that
 * cannot be shown live is no evidence, so a control that fails or cannot start
 * fails the file.
 *
 * WHERE IT RUNS. Escapes 1, 2 and 4 need a live sandbox and are gated by
 * `sandboxCasesRun()` — `AVE_REQUIRE_SANDBOX_CASES=1` on the confinement jobs
 * turns "cannot measure" into a failure. Escape 3 needs no sandbox (the child
 * is `process.execPath` under `ELECTRON_RUN_AS_NODE=1` whether wrapped or not),
 * is spawned unwrapped as the default host spawns it, and runs everywhere its
 * control can start: macOS and Windows directly, Linux
 * under a display or `xvfb-run -a`. Off CI, a Linux host with neither reports
 * the Electron control and row 3 not exercised (`it.runIf`), never passed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** What the protocol session warned about this connection, for escape 4's unknown field. */
const sessionWarnings = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      if (name !== "plugin-protocol-session") return logger;
      return Object.assign(Object.create(logger) as typeof logger, {
        warn: (...args: unknown[]) => {
          sessionWarnings.push(args);
          logger.warn(...(args as Parameters<typeof logger.warn>));
        },
      });
    },
  };
});

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { createBootHostFixture, stationaryLeaseState } from "../../../__tests__/support/host-runtime.js";
import { createHostApiFactory } from "../../../boot/steps/plugin-runtime/host-api-factory.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import { HostApiGenerationScope } from "../../plugin-host-effect-scope.js";
import { admittedGenerationAccess } from "../../__tests__/test-helpers.js";
import { resolvePluginHostStorageDir, resolvePluginSocketDir } from "../../plugin-storage-layout.js";
import { flattenAgentPluginsManifest } from "../../public-contract.js";
import type { PluginHostApiIncarnation } from "../../runtime/index.js";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext, RuntimePlugin } from "../../types.js";
import { HOSTAPI_DISPATCH_TABLE } from "../host-api-dispatcher.js";
import {
  createOutOfProcessPluginFactory,
  PluginSandboxGrantError,
  type ObservedPluginChild,
} from "../out-of-process-plugin.js";
import { resolveProcessLaunch } from "../../process-entry.js";
import { buildChildEntry, childBundleDir } from "./child-entry-bundle.js";
import { installPythonSmoke } from "./python-smoke-harness.js";
import { sandboxCasesRequired, sandboxCasesRun } from "./sandbox-cases.js";

const FIXTURE_SOURCE = fileURLToPath(new URL("./fixtures/adversarial/", import.meta.url));
const PLUGIN_ID = "adversarial";
const NEIGHBOUR_ID = "neighbour";
const PYTHON_SMOKE_ID = "python-smoke";
const SENTINEL_NAME = "sentinel.txt";
const SECRETS_SENTINEL = "the host secret no plugin child may read";
const NEIGHBOUR_SENTINEL = "the neighbour's own bytes, which no other plugin may read";
const LATE_SENTINEL = "a plugin installed after the child spawned";

/**
 * A neighbour agent plugin's data (`agent-plugin-data/<name>`) and installed
 * version (`packages/agent-plugin/<name>/<version>`): outside the plugins root,
 * refused to every plugin-owned wrap all the same.
 */
function agentPluginNeighbourDirs(aveHome: string): string[] {
  return [join(aveHome, "agent-plugin-data", NEIGHBOUR_ID), join(aveHome, "packages", "agent-plugin", NEIGHBOUR_ID, "1.0.0")];
}
/** What the fixture's in-sandbox controls write into its own data directory (`entry.mjs`). */
const OWN_BYTES = "the adversarial plugin's own bytes";
const OWN_SECRET = "the adversarial plugin's own stored secret";
const NEIGHBOUR_SECRET = "the neighbour's stored secret";
const DENIED_URL = "https://not-allowed.invalid/escape";
const GENERATION_ID = "adversarial-generation";
const CHILD_BUNDLE_CACHE = "plugin-child-adversarial";
/** Escapes 1, 2 and 4 are measured where a wrap substrate exists (§9.8 A2 Gates). */
const WRAP_PLATFORM = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

/** The filesystem error each substrate answers a denied read with (table row 1a). */
function deniedReadCodes(): readonly string[] {
  if (process.platform === "linux") return ["ENOENT"];
  return ["EPERM", "EACCES"];
}

/**
 * Whether the full Electron main process can start here. Linux needs a display
 * driver: an inherited `DISPLAY`, or `xvfb-run`, Electron's documented answer
 * for a headless host. A job that requires the measurement runs the case and
 * lets a helper that cannot start fail it.
 */
function electronControlLauncher(): { readonly command: string; readonly prefix: readonly string[] } | undefined {
  if (process.platform !== "linux" || process.env.DISPLAY) return { command: process.execPath, prefix: [] };
  try {
    execFileSync("xvfb-run", ["--help"], { stdio: "ignore" });
    return { command: "xvfb-run", prefix: ["-a", process.execPath] };
  } catch {
    return undefined;
  }
}
const ELECTRON_CONTROL = electronControlLauncher();
const ELECTRON_CONTROL_RUNS = ELECTRON_CONTROL !== undefined || sandboxCasesRequired();

/** One plugin installed where a real one lives, and how its child is produced. */
interface Installed {
  readonly pluginId: string;
  readonly pluginRoot: string;
  readonly pluginDataDir: string;
  readonly manifest: PluginManifest;
  readonly launch: Parameters<typeof createOutOfProcessPluginFactory>[0]["launch"];
}

interface Staged {
  readonly root: string;
  readonly aveHome: string;
  readonly secretsDir: string;
  readonly neighbourDataDir: string;
  readonly fixture: Installed;
}

let staged: Staged;
let previousAveHome: string | undefined;
let listener: Server;
let listenerPort = 0;
const listenerConnections: string[] = [];
/** Which control held, by escape. An escape case refuses to assert without its own. */
const controls: Record<"secrets" | "network" | "electron" | "patch", "held" | undefined> = {
  secrets: undefined,
  network: undefined,
  electron: undefined,
  patch: undefined,
};

beforeAll(async () => {
  // Short on macOS, whose temp directory is deep: escape 1a's worker binds its
  // control socket under `<AVE_HOME>/plugins/<id>/run/<worker>/`, and a path
  // past `sun_path` is refused before any worker starts.
  const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "adv-"));
  const aveHome = join(root, ".ave");
  const secretsDir = join(aveHome, "secrets");
  const neighbourDataDir = join(aveHome, "plugins", NEIGHBOUR_ID, "data");
  const pluginRoot = join(aveHome, "plugins", PLUGIN_ID);
  const pluginDataDir = join(pluginRoot, "data");
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  mkdirSync(neighbourDataDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(secretsDir, SENTINEL_NAME), SECRETS_SENTINEL, "utf-8");
  writeFileSync(join(neighbourDataDir, SENTINEL_NAME), NEIGHBOUR_SENTINEL, "utf-8");
  for (const agentDir of agentPluginNeighbourDirs(aveHome)) {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(agentDir, SENTINEL_NAME), NEIGHBOUR_SENTINEL, "utf-8");
  }
  // Staged outside the checkout, where a bare `electron` specifier has no
  // `node_modules` to walk up into.
  cpSync(FIXTURE_SOURCE, pluginRoot, { recursive: true });
  mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
  mkdirSync(resolvePluginHostStorageDir(pluginDataDir), { recursive: true, mode: 0o700 });
  const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf-8")));
  staged = {
    root,
    aveHome,
    secretsDir,
    neighbourDataDir,
    fixture: {
      pluginId: PLUGIN_ID,
      pluginRoot,
      pluginDataDir,
      manifest,
      launch: { kind: "entry", entryPath: join(pluginRoot, "entry.mjs") },
    },
  };
  // The deny floor is derived from `aveHome()`: pointing it here is what makes
  // `<AVE_HOME>/secrets` a real denied path with a real file in it.
  previousAveHome = process.env.AVE_HOME;
  process.env.AVE_HOME = aveHome;
  listener = createServer((socket) => {
    listenerConnections.push(socket.remoteAddress ?? "unknown");
    socket.destroy();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  listenerPort = (listener.address() as { port: number }).port;
});

afterAll(async () => {
  if (liveControl !== undefined) killControl(liveControl.child, liveControl.group);
  await controlExit;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  rmSync(staged.root, { recursive: true, force: true });
  rmSync(childBundleDir(CHILD_BUNDLE_CACHE), { recursive: true, force: true });
});

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
});

interface ProductionHost {
  readonly api: PluginHostApi;
  readonly audit: AuditLogger;
  /** Every request that reached the transport underneath `hostFetch`. */
  readonly transportCalls: string[];
}

/**
 * The production host API for the fixture: `createHostApiFactory` itself, so
 * the secret gate, the audit vocabulary and the egress guard are the shipped
 * ones. Only the stores behind it are local — the secret values, the plugin's
 * saved config — and the transport, which records and refuses so a request
 * that got past the guard would be seen.
 */
function productionHost(installed: Installed, config: Record<string, unknown>): ProductionHost {
  const secrets = new Map<string, string>([
    [`plugin.${PLUGIN_ID}.key`, OWN_SECRET],
    [`plugin.${NEIGHBOUR_ID}.key`, NEIGHBOUR_SECRET],
  ]);
  const transportCalls: string[] = [];
  // Its own directory per host, so each case reads only the rows its own
  // spawn wrote.
  const audit = new AuditLogger(mkdtempSync(join(staged.root, "audit-")));
  const scope = new HostApiGenerationScope(installed.pluginId);
  const incarnation: PluginHostApiIncarnation = {
    registerDisposer: () => undefined,
    trackOperation: <T>(operation: Promise<T>) => operation,
    isActive: () => true,
    isLifecycleHookActive: () => true,
    generationScope: scope,
  };
  const factory = createHostApiFactory({
    host: createBootHostFixture(),
    getPluginRuntime: () => ({
      getApprovedPluginAccess: () => undefined,
      listPluginIds: () => [installed.pluginId, NEIGHBOUR_ID],
      getWildcardConfigOverride: () => ({}),
      isShuttingDown: () => false,
    }),
    lateBinding: {},
    getRegistryEntry: () => undefined,
    refreshRegistryEntryCacheIfChanged: async () => undefined,
    hostClassifiesRiskEnabled: () => true,
    pluginShutdownHandlers: [],
    readAppPreference: () => undefined,
    settingsService: {
      ...stationaryLeaseState,
      getPluginConfig: () => config,
      getSecret: (key: string) => secrets.get(key) ?? null,
    },
    bootAuditLogger: audit,
    pluginRuntimeAuditLog: () => undefined,
    networkFetch: (async (input: unknown) => {
      transportCalls.push(String(input));
      throw new Error("the transport is not reachable from this suite");
    }) as unknown as typeof fetch,
    mainWindow: null,
    openAuthWindowService: async () => [],
    openLinkWindowService: async () => undefined,
    openAuthPartitionViewerService: async () => undefined,
    clearAuthPartitionService: async () => undefined,
    shellOpenExternal: async () => undefined,
    approvalGate: {},
    routinesStore: {},
    getWorkBoardStore: () => undefined,
    getAlertsService: () => undefined,
    grantEvidence: {
      officialPins: async () => [],
      receiptArtifactSha256: async () => null,
    },
  } as never);
  const api = factory(installed.pluginId, installed.manifest, installed.pluginDataDir, incarnation, null, undefined, null);
  scope.bindGeneration(admittedGenerationAccess(GENERATION_ID), GENERATION_ID);
  scope.publish();
  return { api, audit, transportCalls };
}

/** Every audit row written into the isolated home so far, as its text. */
async function auditTexts(audit: AuditLogger): Promise<string[]> {
  await audit.flush();
  const dir = audit.getAuditDir();
  const rows: string[] = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".jsonl")).sort()) {
    for (const line of readFileSync(join(dir, name), "utf-8").split("\n")) {
      if (line.length === 0) continue;
      const row = JSON.parse(line) as { input?: string; output?: string };
      rows.push(row.input ?? row.output ?? "");
    }
  }
  return rows;
}

interface Spawned {
  readonly instance: RuntimePlugin;
  readonly host: ProductionHost;
  readonly stdout: () => string;
  readonly child: () => ObservedPluginChild | undefined;
}

/** The context the runtime builds for an installed plugin. */
function contextFor(installed: Installed, host: ProductionHost, config: Record<string, unknown>): PluginRuntimeContext {
  return {
    pluginId: installed.pluginId,
    pluginSocketDir: resolvePluginSocketDir(installed.pluginDataDir),
    pluginRoot: installed.pluginRoot,
    hostRoot: join(staged.root, "app-root"),
    pluginDataDir: installed.pluginDataDir,
    userHome: homedir(),
    aveHome: staged.aveHome,
    config,
    log: () => undefined,
    hostApi: host.api,
  };
}

/**
 * An installed plugin, through the production factory, observed from its spawn:
 * wrapped, as a host with the OS sandbox on spawns it, unless `wrapped` is
 * false, as a host with the sandbox off (the default) does.
 */
async function spawnInstalled(
  installed: Installed,
  config: Record<string, unknown> = {},
  { wrapped = true }: { readonly wrapped?: boolean } = {},
): Promise<Spawned> {
  if (wrapped) await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  const host = productionHost(installed, config);
  let stdout = "";
  let observed: ObservedPluginChild | undefined;
  const factory = createOutOfProcessPluginFactory({
    manifest: installed.manifest,
    launch: installed.launch,
    ...(installed.launch.kind === "entry" ? { childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE) } : {}),
    observeChild: (child) => {
      observed = child;
      child.onStdout((chunk) => {
        stdout += chunk.toString("utf-8");
      });
    },
  });
  const instance = await factory(contextFor(installed, host, config));
  return { instance, host, stdout: () => stdout, child: () => observed };
}

async function call(spawned: Spawned, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await spawned.instance.handlers[tool]!(args)) as Record<string, unknown>;
}

/**
 * How long the control may take to report, and then to exit by itself before it
 * is reaped. A healthy control exits within about 2 s of reporting; on a
 * contended macOS host its main thread can then wait in Chromium's shutdown far
 * longer (observed past 60 s), which is scheduler latency, not anything the
 * control proves, so it is killed with its helpers and the stall logged.
 */
const CONTROL_REPORT_TIMEOUT_MS = 60_000;
const CONTROL_EXIT_GRACE_MS = 5_000;

/** How the control process ended after it reported. */
interface ControlExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Whether the harness had to kill it after the grace period. */
  readonly reaped: boolean;
  /** A process of its group still alive after it ended, if any (POSIX). */
  readonly survivor: boolean;
  /** Its stderr, and where it was stuck if it had to be reaped. */
  readonly diagnostics: string;
}

/** The Electron control's report, and its exit, observed separately. */
interface ControlRun {
  readonly report: Record<string, unknown>;
  readonly exited: Promise<ControlExit>;
}

/** The control's exit, asserted on its own once the report has held. */
let controlExit: Promise<ControlExit> | undefined;
/** A control still running, so `afterAll` can reap its process group. */
let liveControl: { readonly child: ChildProcess; readonly group: boolean } | undefined;

/**
 * Kill the control and every helper it started. On POSIX it leads its own
 * process group (`detached`), so the GPU, network and renderer helpers — and
 * `xvfb-run`'s server on Linux — go with it; on Windows the job object Chromium
 * keeps for its helpers closes with the main process.
 */
function killControl(child: ChildProcess, group: boolean): void {
  if (!group || child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    // ESRCH: the group is gone. EPERM: macOS refuses to signal a group whose
    // only members are zombies, as when the control exits while it is sampled;
    // whether anything really survived is `controlGroupAlive`'s question.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

/**
 * Whether any process of the control's group is still alive (POSIX). Read from
 * `ps`, not `kill(-pgid, 0)`: macOS answers that EPERM while the group's last
 * members are zombies awaiting their reaper, which is not a survivor.
 */
function controlGroupAlive(pid: number): boolean {
  const table = execFileSync("/bin/ps", ["-Ao", "pgid=,stat="], { encoding: "utf-8" });
  return table.split("\n").some((row) => {
    const [pgid, stat] = row.trim().split(/\s+/);
    return pgid === String(pid) && stat !== undefined && !stat.startsWith("Z");
  });
}

/**
 * Where a control that did not finish is stuck, for the failure message: its
 * main thread's stack (macOS `sample`) and its process group. Each part names
 * its own failure, so a missing tool reads as that, never as a clean process.
 */
function controlDiagnostics(pid: number, userData: string): string {
  const parts: string[] = [];
  if (process.platform === "darwin") {
    const sampleFile = join(userData, "control.sample.txt");
    try {
      execFileSync("/usr/bin/sample", [String(pid), "2", "-file", sampleFile], { stdio: "ignore", timeout: 20_000 });
      const sample = readFileSync(sampleFile, "utf-8");
      // The frames each thread was waiting in, then the call graph that led there.
      const top = sample.indexOf("Sort by top of stack");
      const tree = Math.max(0, sample.indexOf("Call graph:"));
      parts.push(
        `sample ${pid}:\n${top === -1 ? "" : `${sample.slice(top, top + 3_000)}\n`}${sample.slice(tree, tree + 6_000)}`,
      );
    } catch (error) {
      parts.push(`sample ${pid} failed: ${String(error)}`);
    }
  }
  if (process.platform !== "win32") {
    try {
      const table = execFileSync("/bin/ps", ["-Ao", "pid,ppid,pgid,etime,stat,command"], { encoding: "utf-8" });
      const group = table
        .split("\n")
        .filter((row, index) => index === 0 || row.trim().split(/\s+/)[2] === String(pid))
        .map((row) => row.slice(0, 240));
      parts.push(`process group ${pid}:\n${group.join("\n")}`);
    } catch (error) {
      parts.push(`ps failed: ${String(error)}`);
    }
  }
  return parts.join("\n\n");
}

/**
 * Run the Electron control helper and read its one line as soon as it is
 * written. Its exit is a separate promise: the report is what the control
 * proves, and a process that then fails to exit is its own failure, killed with
 * its helpers after a grace period and reported with where it was stuck.
 */
async function runElectronControl(): Promise<ControlRun> {
  const launcher = ELECTRON_CONTROL;
  if (launcher === undefined) {
    throw new Error("the Electron control cannot start here: no DISPLAY and no xvfb-run");
  }
  const userData = mkdtempSync(join(tmpdir(), "adversarial-control-"));
  const env: NodeJS.ProcessEnv = { ...process.env, AVE_HOME: join(userData, ".ave") };
  delete env.ELECTRON_RUN_AS_NODE;
  const group = process.platform !== "win32";
  const child = spawn(
    launcher.command,
    [
      ...launcher.prefix,
      join(FIXTURE_SOURCE, "control-electron-main.cjs"),
      // `--no-sandbox`: Chromium's own renderer sandbox is not what this
      // control measures, and on a Linux host that restricts unprivileged
      // user namespaces (Ubuntu 24.04's default) with an unprivileged
      // `chrome-sandbox` helper the zygote aborts with SIGTRAP (exit 133)
      // before the main script runs.
      "--no-sandbox",
      `--user-data-dir=${userData}`,
      // macOS: safeStorage would otherwise open the login Keychain item for
      // this binary, which can wait on a prompt nobody answers.
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: group },
  );
  const pid = child.pid;
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf-8");
  });
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null } | Error>((resolve) => {
    child.once("error", resolve);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  liveControl = { child, group };
  const reportLine = (): string | undefined =>
    out
      .split("\n")
      .slice(0, -1)
      .find((entry) => entry.startsWith("{"));

  const reported = new Promise<void>((resolve) => {
    const check = (): void => {
      if (reportLine() !== undefined) resolve();
    };
    child.stdout.on("data", check);
    check();
  });
  let reportTimer: NodeJS.Timeout | undefined;
  const outcome = await Promise.race([
    reported.then(() => "reported" as const),
    ended.then(() => "ended" as const),
    new Promise<"timeout">((resolve) => {
      reportTimer = setTimeout(() => resolve("timeout"), CONTROL_REPORT_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(reportTimer);
  if (outcome === "ended" && reportLine() === undefined && !child.stdout.readableEnded) {
    // `exit` can precede the last stdout chunk; let the pipe drain before
    // concluding the control wrote nothing.
    await Promise.race([reported, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  const line = reportLine();
  if (line === undefined) {
    const diagnostics = outcome === "timeout" && pid !== undefined ? controlDiagnostics(pid, userData) : "";
    if (pid !== undefined) killControl(child, group);
    const end = await ended;
    liveControl = undefined;
    rmSync(userData, { recursive: true, force: true });
    const how = end instanceof Error ? String(end) : `exit ${String(end.code)}, signal ${String(end.signal)}`;
    throw new Error(
      `the Electron control did not report within ${CONTROL_REPORT_TIMEOUT_MS} ms (${outcome}; ${how}): ` +
        `stderr: ${err.slice(-2_000)}${diagnostics === "" ? "" : `\n\n${diagnostics}`}`,
    );
  }

  const exited = (async (): Promise<ControlExit> => {
    let diagnostics = "";
    let reaped = false;
    const grace = setTimeout(() => {
      if (pid === undefined) return;
      reaped = true;
      diagnostics = controlDiagnostics(pid, userData);
      killControl(child, group);
    }, CONTROL_EXIT_GRACE_MS);
    const end = await ended;
    clearTimeout(grace);
    // A helper that outlived its main process is a finding, then reaped too.
    let survivor = false;
    if (pid !== undefined && group) {
      const settle = Date.now() + 2_000;
      while (controlGroupAlive(pid) && Date.now() < settle) await new Promise((resolve) => setTimeout(resolve, 100));
      survivor = controlGroupAlive(pid);
      if (survivor) {
        diagnostics += `\n\n${controlDiagnostics(pid, userData)}`;
        killControl(child, group);
      }
    }
    liveControl = undefined;
    rmSync(userData, { recursive: true, force: true });
    if (end instanceof Error) {
      return { code: null, signal: null, reaped, survivor, diagnostics: `${String(end)}\n${diagnostics}` };
    }
    return {
      code: end.code,
      signal: end.signal,
      reaped,
      survivor,
      diagnostics: `stderr: ${err.slice(-2_000)}\n\n${diagnostics}`,
    };
  })();
  return { report: JSON.parse(line) as Record<string, unknown>, exited };
}

describe("the controls, which must hold before any escape is asserted", () => {
  it("reads the secrets sentinel and the neighbour's data from the test process", () => {
    expect(readFileSync(join(staged.secretsDir, SENTINEL_NAME), "utf-8")).toBe(SECRETS_SENTINEL);
    expect(readdirSync(staged.secretsDir)).toEqual([SENTINEL_NAME]);
    expect(readFileSync(join(staged.neighbourDataDir, SENTINEL_NAME), "utf-8")).toBe(NEIGHBOUR_SENTINEL);
    controls.secrets = "held";
  });

  it("connects to the loopback listener from the test process", async () => {
    const before = listenerConnections.length;
    const { connect } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port: listenerPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", reject);
    });
    await vi.waitFor(() => expect(listenerConnections.length).toBe(before + 1));
    controls.network = "held";
  });

  it.runIf(ELECTRON_CONTROL_RUNS)(
    "reports Electron's main-process API from a full main process of the same binary",
    async () => {
      // The test process is NOT this control: it runs as Node itself.
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
      const run = await runElectronControl();
      controlExit = run.exited;
      const control = run.report as {
        detector: { outcome: string; usable: string[] };
      };
      expect(control).toMatchObject({ BrowserWindow: "function", defaultSession: "object", ipcMain: "object" });
      // The detector row 3 relies on, run where the API is real, finds it and
      // uses it: "no-usable-api" below is that detector's answer, not its blind spot.
      expect(control.detector.outcome).toBe("usable-api");
      expect(control.detector.usable).toEqual(
        expect.arrayContaining(["requireBare", "requireBare.newBrowserWindow", "requireBare.defaultSession", "requireBare.ipcMainHandle"]),
      );
      controls.electron = "held";
    },
    90_000,
  );

  it.runIf(ELECTRON_CONTROL_RUNS)(
    "the Electron control ends after reporting, and none of its helpers outlives it",
    async () => {
      expect(controlExit, "the Electron control did not start").toBeDefined();
      const exit = await controlExit!;
      if (exit.reaped) {
        // Not a failure of what the control proves: its report already held.
        // The stack says where Chromium's shutdown was waiting, for the log.
        // Written to stderr, as the python smoke reports, so it reaches the run log.
        process.stderr.write(
          `[adversarial-escapes] the Electron control was reaped ${CONTROL_EXIT_GRACE_MS} ms after reporting:\n${exit.diagnostics}\n`,
        );
      }
      // A reaped control is killed, unless it exited by itself while sampled.
      const ended = [{ code: 0, signal: null }, ...(exit.reaped ? [{ code: null, signal: "SIGKILL" }] : [])];
      expect(ended, `the Electron control ended badly:\n${exit.diagnostics}`).toContainEqual({
        code: exit.code,
        signal: exit.signal,
      });
      expect(exit.survivor, `a helper of the Electron control outlived it:\n${exit.diagnostics}`).toBe(false);
    },
    CONTROL_EXIT_GRACE_MS + 60_000,
  );

  it("replaces globalThis.fetch where patch() runs", async () => {
    const { patch } = (await import(pathToFileURL(join(FIXTURE_SOURCE, "entry.mjs")).href)) as {
      patch: () => () => void;
    };
    const original = globalThis.fetch;
    const restore = patch();
    try {
      expect(globalThis.fetch).not.toBe(original);
      await expect(globalThis.fetch("https://example.com/")).rejects.toThrow(/replaced fetch/);
    } finally {
      restore();
    }
    expect(globalThis.fetch).toBe(original);
    controls.patch = "held";
  });
});

describe("the four escapes, against the production factory under the real wrap", () => {
  it.runIf(WRAP_PLATFORM)(
    "1a/1b: reads nothing of the host's secrets or a neighbour's data, and the gate denies the foreign key under the spawn-bound id",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.secrets, "the secrets control did not hold").toBe("held");
      const spawned = await spawnInstalled(staged.fixture);
      try {
        const result = await call(spawned, "escape_secrets", {
          expectConfined: true,
          secretsDir: staged.secretsDir,
          otherDataDir: staged.neighbourDataDir,
          sentinelName: SENTINEL_NAME,
          otherPluginId: NEIGHBOUR_ID,
        });
        // The control inside the sandbox: the child wrote its own data directory
        // and read the bytes back, so the reads below fail for being someone
        // else's, not for a wrong path or a data directory left read-only.
        expect(result.own).toEqual({ write: { ok: true }, read: { ok: true, value: OWN_BYTES } });
        const filesystem = result.filesystem as Record<string, { ok: boolean; code?: string; value?: unknown }>;
        // Both reads fail with the substrate's own error and return no bytes.
        for (const probe of ["readSecret", "readOtherData"]) {
          expect(filesystem[probe]!.ok, `${probe}: ${JSON.stringify(filesystem[probe])}`).toBe(false);
          expect(deniedReadCodes(), `${probe}: ${JSON.stringify(filesystem[probe])}`).toContain(filesystem[probe]!.code);
        }
        // A listing either fails the same way or, under bubblewrap's empty
        // tmpfs, names nothing.
        for (const probe of ["listSecrets", "listOtherData"]) {
          const listing = filesystem[probe]!;
          if (listing.ok) expect(listing.value, probe).toEqual([]);
          else expect(deniedReadCodes(), `${probe}: ${JSON.stringify(listing)}`).toContain(listing.code);
        }
        // There is no wire error for a denial: the gate answers `null`, and the
        // own-namespace control answers the stored value.
        expect(result.secrets).toMatchObject({
          foreign: { ok: true, value: null },
          own: { ok: true, value: OWN_SECRET },
        });
        const carried = `${JSON.stringify(result)}\n${spawned.stdout()}`;
        for (const bytes of [SECRETS_SENTINEL, NEIGHBOUR_SENTINEL, NEIGHBOUR_SECRET]) {
          expect(carried).not.toContain(bytes);
        }
        const audit = await auditTexts(spawned.host.audit);
        expect(audit).toContain(
          `[plugin:${PLUGIN_ID}] hostSecret_denied reason=not-allowlisted key=plugin.${NEIGHBOUR_ID}.key`,
        );
        expect(audit).toContain(`[plugin:${PLUGIN_ID}] pluginSecret_read key=plugin.${PLUGIN_ID}.key`);
        expect(audit.filter((row) => row.startsWith(`[plugin:${NEIGHBOUR_ID}]`))).toEqual([]);

        // A plugin installed AFTER this child spawned is refused too: the deny
        // is the plugins root, not a list of what was in it. Windows has no
        // such deny (`PerCommandFilesystem.denyPluginsRoot`).
        if (process.platform !== "win32") {
          const lateDataDir = join(staged.aveHome, "plugins", "lateplugin", "data");
          mkdirSync(lateDataDir, { recursive: true, mode: 0o700 });
          writeFileSync(join(lateDataDir, SENTINEL_NAME), LATE_SENTINEL, "utf-8");
          expect(readFileSync(join(lateDataDir, SENTINEL_NAME), "utf-8")).toBe(LATE_SENTINEL);
          const late = await call(spawned, "escape_secrets", {
            expectConfined: true,
            secretsDir: staged.secretsDir,
            otherDataDir: lateDataDir,
            sentinelName: SENTINEL_NAME,
            otherPluginId: NEIGHBOUR_ID,
          });
          const lateRead = (late.filesystem as Record<string, { ok: boolean; code?: string }>).readOtherData!;
          expect(lateRead.ok, JSON.stringify(lateRead)).toBe(false);
          expect(deniedReadCodes()).toContain(lateRead.code);
          expect(JSON.stringify(late)).not.toContain(LATE_SENTINEL);

          // An agent plugin's data and installed version, outside the plugins
          // root: refused by the same flag (`asrt-sandbox.ts`,
          // `ensurePluginOwnedReadRoots`), each with its unconfined control.
          for (const agentDir of agentPluginNeighbourDirs(staged.aveHome)) {
            expect(readFileSync(join(agentDir, SENTINEL_NAME), "utf-8")).toBe(NEIGHBOUR_SENTINEL);
            const agent = await call(spawned, "escape_secrets", {
              expectConfined: true,
              secretsDir: staged.secretsDir,
              otherDataDir: agentDir,
              sentinelName: SENTINEL_NAME,
              otherPluginId: NEIGHBOUR_ID,
            });
            const agentRead = (agent.filesystem as Record<string, { ok: boolean; code?: string }>).readOtherData!;
            expect(agentRead.ok, `${agentDir}: ${JSON.stringify(agentRead)}`).toBe(false);
            expect(deniedReadCodes()).toContain(agentRead.code);
            expect(JSON.stringify(agent)).not.toContain(NEIGHBOUR_SENTINEL);
          }
        }
      } finally {
        await spawned.instance.stop?.();
      }
    },
    120_000,
  );

  // Escape 1a by delegation: the child asks the host for a worker that reads
  // what it cannot. `/bin/cat` is the worker; Windows workers run as the same
  // single sandbox account as the child and have no neighbour deny to measure.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "1a by delegation: a worker the child asks for reads its own grant and not a neighbour's data",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.secrets, "the secrets control did not hold").toBe("held");
      // The control outside the sandbox: the same command prints the
      // neighbour's sentinel when nothing confines it.
      expect(execFileSync("/bin/cat", [join(staged.neighbourDataDir, SENTINEL_NAME)], { encoding: "utf-8" })).toBe(
        NEIGHBOUR_SENTINEL,
      );
      for (const agentDir of agentPluginNeighbourDirs(staged.aveHome)) {
        expect(execFileSync("/bin/cat", [join(agentDir, SENTINEL_NAME)], { encoding: "utf-8" })).toBe(NEIGHBOUR_SENTINEL);
      }
      const spawned = await spawnInstalled(staged.fixture);
      try {
        // The plugins root's neighbour, then an agent plugin's data and
        // installed version outside it.
        for (const otherDataDir of [staged.neighbourDataDir, ...agentPluginNeighbourDirs(staged.aveHome)]) {
          const result = await call(spawned, "escape_worker", {
            expectConfined: true,
            otherDataDir,
            sentinelName: SENTINEL_NAME,
            otherPluginId: NEIGHBOUR_ID,
            command: "/bin/cat",
          });
          // The control inside the sandbox: granted its plugin's data directory,
          // the worker prints what the child wrote there.
          expect(result.own, JSON.stringify(result.own)).toMatchObject({
            ok: true,
            value: { stdout: OWN_BYTES, exit: 0 },
          });
          const other = result.other as { ok: boolean; value?: { stdout: string; stderr: string; exit: unknown } };
          expect(other.ok, `${otherDataDir}: ${JSON.stringify(other)}`).toBe(true);
          expect(other.value!.exit, `${otherDataDir}: ${JSON.stringify(other)}`).not.toBe(0);
          expect(other.value!.stdout).toBe("");
          expect(JSON.stringify(result)).not.toContain(NEIGHBOUR_SENTINEL);
        }
      } finally {
        await spawned.instance.stop?.();
      }
    },
    120_000,
  );

  it.runIf(WRAP_PLATFORM)(
    "1c: refuses the spawn when the declared write grant names the secrets directory, and no child exists",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.secrets, "the secrets control did not hold").toBe("held");
      let observed = false;
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const config = { escapeDir: staged.secretsDir };
      const host = productionHost(staged.fixture, config);
      const factory = createOutOfProcessPluginFactory({
        manifest: staged.fixture.manifest,
        launch: staged.fixture.launch,
        childEntryPath: await buildChildEntry(CHILD_BUNDLE_CACHE),
        observeChild: () => {
          observed = true;
        },
      });
      const refused = factory(contextFor(staged.fixture, host, config));
      await expect(refused).rejects.toBeInstanceOf(PluginSandboxGrantError);
      // Refused for being the secrets directory — not merely for lacking an
      // approval, which a value anywhere outside an approved root would also be.
      await expect(refused).rejects.toThrow(/escapeDir/);
      await expect(refused).rejects.toThrow(/sensitive-path rule/);
      expect(observed, "a child was spawned for a refused grant").toBe(false);
    },
    120_000,
  );

  it.runIf(WRAP_PLATFORM)(
    "2: reaches no listener directly, and hostFetch refuses the undeclared host before any socket",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.network, "the network control did not hold").toBe("held");
      const before = listenerConnections.length;
      const spawned = await spawnInstalled(staged.fixture);
      try {
        const result = await call(spawned, "escape_network", {
          expectConfined: true,
          port: listenerPort,
          deniedUrl: DENIED_URL,
        });
        const raw = result.raw as Record<string, { ok: boolean; code?: string }>;
        expect(raw.connect!.ok, JSON.stringify(raw.connect)).toBe(false);
        expect(raw.fetch!.ok, JSON.stringify(raw.fetch)).toBe(false);
        expect(listenerConnections.length, "the listener recorded a connection from the child").toBe(before);
        // The child sees only that the host refused: the boundary carries no
        // host-side detail. The reason is the host's own audit record.
        expect(result.hostFetch).toMatchObject({ url: DENIED_URL, ok: false });
        // Refused by the allow-list, so nothing reached the transport.
        expect(spawned.host.transportCalls).toEqual([]);
        const audit = await auditTexts(spawned.host.audit);
        const denials = audit.filter((row) => row.startsWith(`[plugin:${PLUGIN_ID}] host_fetch_denied`));
        expect(denials, JSON.stringify(audit)).toHaveLength(1);
        // The allow-list's own detail, not merely "denied": `.invalid` never
        // resolves, so the SSRF layer behind the allow-list would deny it too,
        // and only this line tells the two apart.
        expect(denials[0]).toContain("https://not-allowed.invalid not in networkAccess.allowedDomains");
        expect(audit.some((row) => row.includes(" host_fetch ") && !row.includes("host_fetch_denied"))).toBe(false);
      } finally {
        await spawned.instance.stop?.();
      }
    },
    120_000,
  );

  it.runIf(ELECTRON_CONTROL_RUNS)(
    "3: the child is Electron run as Node, and no form of electron hands it a usable main-process API",
    async () => {
      expect(controls.electron, "the Electron control did not hold").toBe("held");
      // Escape 3 needs no sandbox: the claim is about `process.execPath` under
      // `ELECTRON_RUN_AS_NODE=1`, which the factory spawns wrapped or not. It
      // runs unwrapped, as a host with the sandbox off — the default — spawns
      // it, which is also where a child that lost the variable would come up as
      // a full main process and answer, rather than be stopped by the wrap
      // before the probe could report.
      const spawned = await spawnInstalled(staged.fixture, {}, { wrapped: false });
      try {
        const result = await call(spawned, "escape_electron", { expectConfined: true });
        expect(result).toMatchObject({
          attempt: "escape_electron",
          outcome: "no-usable-api",
          usable: [],
          runAsNode: "1",
          // The trap: a version check says yes.
          version: expect.any(String),
          requireBare: { ok: false, code: "MODULE_NOT_FOUND" },
          importBare: {
            ok: true,
            module: { kind: "object", BrowserWindow: "undefined", session: "undefined", ipcMain: "undefined", app: "undefined" },
          },
          requireVendored: { ok: true, module: { kind: "string", BrowserWindow: "undefined" } },
        });
        const uses = result.uses as Record<string, Record<string, { ok: boolean }>>;
        expect(Object.keys(uses).sort()).toEqual(["importBare", "importBareDefault", "requireVendored"]);
        for (const [form, used] of Object.entries(uses)) {
          for (const [use, answer] of Object.entries(used)) expect(answer.ok, `${form}.${use}`).toBe(false);
        }
      } finally {
        await spawned.instance.stop?.();
      }
    },
    120_000,
  );

  it.runIf(WRAP_PLATFORM)(
    "4: a patched child cannot touch the host's objects; a stray line is dropped and a forged frame answers under the spawn-bound id",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.patch, "the patch control did not hold").toBe("held");
      const hostFetch = globalThis.fetch;
      const table = HOSTAPI_DISPATCH_TABLE;
      const tableEntries = { ...HOSTAPI_DISPATCH_TABLE };
      const warningsBefore = sessionWarnings.length;
      const spawned = await spawnInstalled(staged.fixture);
      try {
        const result = await call(spawned, "escape_patch", {
          expectConfined: true,
          emitNonJson: true,
          otherPluginId: NEIGHBOUR_ID,
        });
        // The patch landed — in the child's own copy.
        expect(result.patched).toEqual({ fetch: true, stdoutWrite: true });
        // The forged frame was dispatched as this connection's request: the
        // gate saw `adversarial` asking for `neighbour`'s key and said no.
        expect(result.forged).toMatchObject({ key: `plugin.${NEIGHBOUR_ID}.key`, answered: true, result: null });
        const audit = await auditTexts(spawned.host.audit);
        expect(audit).toContain(
          `[plugin:${PLUGIN_ID}] hostSecret_denied reason=not-allowlisted key=plugin.${NEIGHBOUR_ID}.key`,
        );
        expect(audit.filter((row) => row.startsWith(`[plugin:${NEIGHBOUR_ID}]`))).toEqual([]);
        // The identity field is not a parameter of `getSecret`: ignored, and
        // named in the host's own log.
        const warnings = sessionWarnings.slice(warningsBefore);
        expect(
          warnings.some(([meta, message]) =>
            message === "ignored an undeclared params field"
            && (meta as { pluginId?: string; method?: string; field?: string }).pluginId === PLUGIN_ID
            && (meta as { field?: string }).field === "pluginId",
          ),
          JSON.stringify(warnings),
        ).toBe(true);
        // The non-JSON line reached the raw stream, the decoder dropped it, and
        // the session went on: the next call answers.
        expect(spawned.stdout().split("\n")).toContain("this line is not JSON");
        await expect(call(spawned, "escape_electron", { expectConfined: true })).resolves.toMatchObject({
          outcome: "no-usable-api",
        });
        // Nothing of the host's changed identity.
        expect(globalThis.fetch).toBe(hostFetch);
        expect(HOSTAPI_DISPATCH_TABLE).toBe(table);
        expect({ ...HOSTAPI_DISPATCH_TABLE }).toEqual(tableEntries);
        for (const [path, handler] of Object.entries(tableEntries)) {
          expect(HOSTAPI_DISPATCH_TABLE[path as keyof typeof HOSTAPI_DISPATCH_TABLE], path).toBe(handler);
        }
      } finally {
        await spawned.instance.stop?.();
      }
    },
    120_000,
  );
  // The `process` variant (§9.8 A2): escapes 1 and 2 again, from the Python
  // smoke — a child that is not JavaScript, spawned by the same factory under
  // the same wrap, where a reviewer would expect the filesystem and socket
  // claims to be re-proven. Escapes 3 and 4 are JavaScript-specific. A process
  // entry never runs on win32.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "1a and 2 from a Python child: the same reads and the same socket are refused",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.secrets, "the secrets control did not hold").toBe("held");
      expect(controls.network, "the network control did not hold").toBe("held");
      const pluginRoot = installPythonSmoke(join(staged.aveHome, "plugins", PYTHON_SMOKE_ID));
      const pluginDataDir = join(pluginRoot, "data");
      mkdirSync(pluginDataDir, { recursive: true, mode: 0o700 });
      mkdirSync(resolvePluginHostStorageDir(pluginDataDir), { recursive: true, mode: 0o700 });
      const manifest = flattenAgentPluginsManifest(JSON.parse(readFileSync(join(pluginRoot, "plugin.json"), "utf-8")));
      const installed: Installed = {
        pluginId: PYTHON_SMOKE_ID,
        pluginRoot,
        pluginDataDir,
        manifest,
        launch: { kind: "process", ...resolveProcessLaunch(manifest, pluginRoot, pluginDataDir) },
      };
      const before = listenerConnections.length;
      const spawned = await spawnInstalled(installed);
      try {
        const secrets = await call(spawned, "escape_secrets", {
          ownDataDir: pluginDataDir,
          secretsDir: staged.secretsDir,
          otherDataDir: staged.neighbourDataDir,
          sentinelName: SENTINEL_NAME,
        });
        // The in-sandbox control, as for the JavaScript child.
        expect(secrets.own).toEqual({
          write: { ok: true, value: null },
          read: { ok: true, value: "the python-smoke plugin's own bytes" },
        });
        const filesystem = secrets.filesystem as Record<string, { ok: boolean; code?: string; value?: unknown }>;
        for (const probe of ["readSecret", "readOtherData"]) {
          expect(filesystem[probe]!.ok, `${probe}: ${JSON.stringify(filesystem[probe])}`).toBe(false);
          expect(deniedReadCodes(), `${probe}: ${JSON.stringify(filesystem[probe])}`).toContain(filesystem[probe]!.code);
        }
        for (const probe of ["listSecrets", "listOtherData"]) {
          const listing = filesystem[probe]!;
          if (listing.ok) expect(listing.value, probe).toEqual([]);
          else expect(deniedReadCodes(), `${probe}: ${JSON.stringify(listing)}`).toContain(listing.code);
        }
        const carried = `${JSON.stringify(secrets)}\n${spawned.stdout()}`;
        for (const bytes of [SECRETS_SENTINEL, NEIGHBOUR_SENTINEL]) expect(carried).not.toContain(bytes);

        const network = await call(spawned, "escape_network", { port: listenerPort });
        const raw = network.raw as Record<string, { ok: boolean; code?: string }>;
        expect(raw.connect!.ok, JSON.stringify(raw.connect)).toBe(false);
        expect(listenerConnections.length, "the listener recorded a connection from the Python child").toBe(before);
      } finally {
        await spawned.instance.stop?.();
      }
    },
    600_000,
  );
});
