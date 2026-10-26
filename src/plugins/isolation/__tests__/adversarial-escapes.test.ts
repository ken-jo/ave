// Run each escape against the real factory, permissions, audit sink and confinement; controls must prove the probe works.
// Required sandbox cases fail if unavailable; unmeasured controls never count as passes.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useVerifiedAveHomePrivacy } from "../../../__tests__/support/ave-home-privacy.js";

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

import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { createBootHostFixture, stationaryLeaseState } from "../../../__tests__/support/host-runtime.js";
import { createHostApiFactory } from "../../../boot/steps/plugin-runtime/host-api-factory.js";
import { configureHostResources } from "../../../main/host-resources.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import {
  __resetSandboxRequestedAtBootForTest,
  setPluginWorkerConfinementRequestedAtBoot,
} from "../../../permissions/sandbox-capability.js";
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
// Global setup owns the immutable shipped entry until all children finish.
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import { installPythonSmoke } from "./python-smoke-harness.js";
import { sandboxCasesRequired, sandboxCasesRun } from "./sandbox-cases.js";

useVerifiedAveHomePrivacy();

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    userInfo: vi.fn(original.userInfo),
  };
});

const FIXTURE_SOURCE = fileURLToPath(new URL("./fixtures/adversarial/", import.meta.url));
const PLUGIN_ID = "adversarial";
const NEIGHBOUR_ID = "neighbour";
const PYTHON_SMOKE_ID = "python-smoke";
const SENTINEL_NAME = "sentinel.txt";
const SECRETS_SENTINEL = "the host secret no plugin child may read";
const NEIGHBOUR_SENTINEL = "the neighbour's own bytes, which no other plugin may read";
const LATE_SENTINEL = "a plugin installed after the child spawned";

/** Agent-plugin data and installed versions remain outside every plugin-owned read envelope. */
function agentPluginNeighbourDirs(aveHome: string): string[] {
  return [join(aveHome, "agent-plugin-data", NEIGHBOUR_ID), join(aveHome, "packages", "agent-plugin", NEIGHBOUR_ID, "1.0.0")];
}
const OWN_BYTES = "the adversarial plugin's own bytes";
const OWN_SECRET = "the adversarial plugin's own stored secret";
const NEIGHBOUR_SECRET = "the neighbour's stored secret";
const DENIED_URL = "https://not-allowed.invalid/escape";
const GENERATION_ID = "adversarial-generation";
const WRAP_PLATFORM = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32";

/** Temporary roots may inherit a nonprivate access list. */
function protectWindowsTestRoot(root: string): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Cannot resolve the native system utilities directory");
  const system32 = join(systemRoot, "System32");
  const identity = execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf-8", windowsHide: true });
  const sids = identity.match(/\bS-\d-\d+(?:-\d+)+\b/g);
  if (sids?.length !== 1) throw new Error("Cannot resolve the test root owner's SID");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$sid = New-Object System.Security.Principal.SecurityIdentifier($env:AVE_ADVERSARIAL_ROOT_SID)",
    "$acl = Get-Acl -LiteralPath $env:AVE_ADVERSARIAL_ROOT",
    "if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Test root owner mismatch' }",
    "$acl.SetAccessRuleProtection($true, $false)",
    "foreach ($entry in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($entry) }",
    "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
    "$acl.AddAccessRule($rule)",
    "Set-Acl -LiteralPath $env:AVE_ADVERSARIAL_ROOT -AclObject $acl",
    "$check = Get-Acl -LiteralPath $env:AVE_ADVERSARIAL_ROOT",
    "$sddl = $check.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)",
    "$entries = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))",
    "if (!$check.AreAccessRulesProtected -or $entries.Count -ne 1) { throw ('Test root DACL is not owner-only: ' + $sddl) }",
    "$entry = $entries[0]",
    "if ($entry.IdentityReference -ne $sid -or $entry.IsInherited -or $entry.AccessControlType -ne 'Allow' -or $entry.FileSystemRights -ne 'FullControl' -or $entry.InheritanceFlags -ne 'ContainerInherit,ObjectInherit' -or $entry.PropagationFlags -ne 'None') { throw ('Test root DACL grant mismatch: ' + $sddl) }",
    "$sddl",
  ].join("; ");
  const sddl = execFileSync(join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf-8",
    windowsHide: true,
    env: { ...process.env, AVE_ADVERSARIAL_ROOT: root, AVE_ADVERSARIAL_ROOT_SID: sids[0] },
  }).trim();
  console.info(`[adversarial] private root ${root}: ${sddl}`);
}

function deniedReadCodes(): readonly string[] {
  if (process.platform === "linux") return ["ENOENT"];
  return ["EPERM", "EACCES"];
}

/** The full main-process control needs a Linux display; required measurements must fail if it cannot start. */
function electronControlLauncher():
  | { readonly command: string; readonly prefix: (scratchDir: string) => readonly string[] }
  | undefined {
  if (process.platform !== "linux" || process.env.DISPLAY) return { command: process.execPath, prefix: () => [] };
  try {
    execFileSync("xvfb-run", ["--help"], { stdio: "ignore" });
    // Place the display cookie inside harness scratch space so a killed control leaves no external temporary directory.
    return { command: "xvfb-run", prefix: (scratchDir) => ["-a", "-f", join(scratchDir, "Xauthority"), process.execPath] };
  } catch {
    return undefined;
  }
}
const ELECTRON_CONTROL = electronControlLauncher();
const ELECTRON_CONTROL_RUNS = ELECTRON_CONTROL !== undefined || sandboxCasesRequired();

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
let stagedRoot: string | undefined;
let previousAveHome: string | undefined;
let listener: Server;
let listenerPort = 0;
const listenerConnections: string[] = [];
/** Every escape must pass its own positive control before asserting denial. */
const controls: Record<"secrets" | "network" | "electron" | "patch", "held" | undefined> = {
  secrets: undefined,
  network: undefined,
  electron: undefined,
  patch: undefined,
};

beforeAll(async () => {
  previousAveHome = process.env.AVE_HOME;
  // Children and workers are confined only when worker confinement is enabled.
  setPluginWorkerConfinementRequestedAtBoot(true);
  // The Windows grant pins paths with the bundled helper, which boot locates.
  configureHostResources({ resourcePath: fileURLToPath(new URL("../../../../resources/", import.meta.url)), isPackaged: false });
  // Use a short POSIX root so worker sockets fit the kernel sun_path limit.
  const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : process.platform === "win32" ? tmpdir() : "/tmp", "adv-"));
  stagedRoot = root;
  if (process.platform === "win32") protectWindowsTestRoot(root);
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
  // Stage outside the checkout so bare imports cannot reach its dependencies.
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
  // Point aveHome at the fixture so its secrets directory receives the real deny floor.
  process.env.AVE_HOME = aveHome;
  if (process.platform === "win32") {
    // Use a fixture-owned home: Windows deny propagation across a real profile can exceed the stamp budget.
    vi.stubEnv("USERPROFILE", join(root, "home"));
    vi.stubEnv("HOME", join(root, "home"));
    vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(root, "home") });
    mkdirSync(join(root, "home"));
  }
  listener = createServer((socket) => {
    listenerConnections.push(socket.remoteAddress ?? "unknown");
    socket.destroy();
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  listenerPort = (listener.address() as { port: number }).port;
});

afterAll(async () => {
  __resetSandboxRequestedAtBootForTest();
  if (liveControl !== undefined) killControl(liveControl.child, liveControl.group);
  await controlExit;
  if (listener !== undefined) await new Promise<void>((resolve) => listener.close(() => resolve()));
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  vi.unstubAllEnvs();
  if (stagedRoot !== undefined) rmSync(stagedRoot, { recursive: true, force: true });
});

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
});

interface ProductionHost {
  readonly api: PluginHostApi;
  readonly audit: AuditLogger;
  readonly transportCalls: string[];
}

/** Use the production HostApi gates with fixture-owned stores and a recording, refusing transport. */
function productionHost(installed: Installed, config: Record<string, unknown>): ProductionHost {
  const secrets = new Map<string, string>([
    [`plugin.${PLUGIN_ID}.key`, OWN_SECRET],
    [`plugin.${NEIGHBOUR_ID}.key`, NEIGHBOUR_SECRET],
  ]);
  const transportCalls: string[] = [];
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

/** The production factory supplies both wrapped and explicitly unwrapped fixture children. */
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
    ...(installed.launch.kind === "entry" ? { childEntryPath: pluginChildEntryPath() } : {}),
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

/** Observe the control report separately from shutdown; reap and diagnose controls that exceed the exit grace period. */
const CONTROL_REPORT_TIMEOUT_MS = 60_000;
const CONTROL_EXIT_GRACE_MS = 5_000;

interface ControlExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly reaped: boolean;
  readonly survivor: boolean;
  /** Record live descendants outside the control process group; a group kill cannot reach them. */
  readonly escaped: readonly string[];
  readonly diagnostics: string;
}

interface ControlRun {
  readonly report: Record<string, unknown>;
  readonly exited: Promise<ControlExit>;
}

let controlExit: Promise<ControlExit> | undefined;
let liveControl: { readonly child: ChildProcess; readonly group: boolean } | undefined;

/** Reap the control and its helpers; POSIX detached groups include renderer and display-server children. */
function killControl(child: ChildProcess, group: boolean): void {
  if (!group || child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    // ESRCH means gone; macOS EPERM can mean a zombie-only group, so check actual survivors.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

// The control's shutdown is observed while later tests run; a synchronous probe here would freeze the event loop that relays their workers' exits (a blocking `sample` failed 1a by delegation as `exit: "timeout"`).
const execFileAsync = promisify(execFile);

/** Use process listings rather than signal 0; macOS reports EPERM for zombie-only groups. */
async function controlGroupAlive(pid: number): Promise<boolean> {
  const { stdout: table } = await execFileAsync("/bin/ps", ["-Ao", "pgid=,stat="], { encoding: "utf-8" });
  return table.split("\n").some((row) => {
    const [pgid, stat] = row.trim().split(/\s+/);
    return pgid === String(pid) && stat !== undefined && !stat.startsWith("Z");
  });
}

/** Check descendants outside the process group because group termination cannot reach them. */
async function controlDescendantsOutsideGroup(pid: number): Promise<{ readonly pid: number; readonly row: string }[]> {
  const { stdout: listing } = await execFileAsync("/bin/ps", ["-Ao", "pid=,ppid=,pgid=,stat=,command="], { encoding: "utf-8" });
  const rows = listing
    .split("\n")
    .map((row) => {
      const [own, parent, pgid, stat] = row.trim().split(/\s+/);
      return { pid: Number(own), ppid: Number(parent), pgid: Number(pgid), stat: stat ?? "", row: row.trim().slice(0, 240) };
    })
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  const descendants = new Set([pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const entry of rows) {
      if (descendants.has(entry.ppid) && !descendants.has(entry.pid)) {
        descendants.add(entry.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((entry) => entry.pid !== pid && descendants.has(entry.pid) && entry.pgid !== pid && !entry.stat.startsWith("Z"))
    .map(({ pid: own, row }) => ({ pid: own, row }));
}

/** Report stack and group diagnostics independently; a missing diagnostic tool is never a clean result. */
async function controlDiagnostics(pid: number, userData: string): Promise<string> {
  const parts: string[] = [];
  if (process.platform === "darwin") {
    const sampleFile = join(userData, "control.sample.txt");
    try {
      await execFileAsync("/usr/bin/sample", [String(pid), "2", "-file", sampleFile], { timeout: 20_000 });
      const sample = readFileSync(sampleFile, "utf-8");
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
      const { stdout: table } = await execFileAsync("/bin/ps", ["-Ao", "pid,ppid,pgid,etime,stat,command"], { encoding: "utf-8" });
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

/** Read the control report immediately; separately await, diagnose and reap a stalled shutdown. */
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
      ...launcher.prefix(userData),
      join(FIXTURE_SOURCE, "control-electron-main.cjs"),
      // Disable the control renderer sandbox where unprivileged namespaces prevent the main probe from starting.
      "--no-sandbox",
      `--user-data-dir=${userData}`,
      // Avoid a macOS keychain prompt that no test participant can answer.
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
    // Drain stdout after exit before deciding the control produced no report.
    await Promise.race([reported, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  const line = reportLine();
  if (line === undefined) {
    const diagnostics = outcome === "timeout" && pid !== undefined ? await controlDiagnostics(pid, userData) : "";
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
    let escaped: readonly string[] = [];
    let reaping: Promise<void> | undefined;
    const reap = async (controlPid: number): Promise<void> => {
      reaped = true;
      diagnostics = await controlDiagnostics(controlPid, userData);
      if (group) {
        // Sample descendants before the parent exits so reparenting cannot hide escaped helpers.
        const outside = await controlDescendantsOutsideGroup(controlPid);
        escaped = outside.map((entry) => entry.row);
        killControl(child, group);
        for (const entry of outside) {
          try {
            process.kill(entry.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      } else {
        killControl(child, group);
      }
    };
    const grace = setTimeout(() => {
      if (pid === undefined) return;
      reaping = reap(pid);
      // Rejections surface at the await below, not as an unhandled rejection while the control still runs.
      reaping.catch(() => {});
    }, CONTROL_EXIT_GRACE_MS);
    const end = await ended;
    clearTimeout(grace);
    // A reap in flight still owns the diagnostics and the escaped-helper kills; finish it before reading either.
    await reaping;
    // After reaping, the control PID and group ID may be recycled; stop signaling them.
    liveControl = undefined;
    // A surviving group member prevents group-ID reuse; report it before terminating the group.
    let survivor = false;
    if (pid !== undefined && group) {
      const settle = Date.now() + 2_000;
      while ((await controlGroupAlive(pid)) && Date.now() < settle) await new Promise((resolve) => setTimeout(resolve, 100));
      survivor = await controlGroupAlive(pid);
      if (survivor) {
        diagnostics += `\n\n${await controlDiagnostics(pid, userData)}`;
        killControl(child, group);
      }
    }
    rmSync(userData, { recursive: true, force: true });
    if (end instanceof Error) {
      return { code: null, signal: null, reaped, survivor, escaped, diagnostics: `${String(end)}\n${diagnostics}` };
    }
    return {
      code: end.code,
      signal: end.signal,
      reaped,
      survivor,
      escaped,
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
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
      const run = await runElectronControl();
      controlExit = run.exited;
      const control = run.report as {
        detector: { outcome: string; usable: string[] };
      };
      expect(control).toMatchObject({ BrowserWindow: "function", defaultSession: "object", ipcMain: "object" });
      // Run the same detector where the API is usable so a later denial cannot be a blind probe.
      expect(control.detector.outcome).toBe("usable-api");
      expect(control.detector.usable).toEqual(
        expect.arrayContaining(["requireBare", "requireBare.newBrowserWindow", "requireBare.defaultSession", "requireBare.ipcMainHandle"]),
      );
      controls.electron = "held";
    },
    90_000,
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
        // Successful own-data access proves neighbour denials come from confinement rather than a broken fixture.
        expect(result.own).toEqual({ write: { ok: true }, read: { ok: true, value: OWN_BYTES } });
        const filesystem = result.filesystem as Record<string, { ok: boolean; code?: string; value?: unknown }>;
        for (const probe of ["readSecret", "readOtherData"]) {
          expect(filesystem[probe]!.ok, `${probe}: ${JSON.stringify(filesystem[probe])}`).toBe(false);
          expect(deniedReadCodes(), `${probe}: ${JSON.stringify(filesystem[probe])}`).toContain(filesystem[probe]!.code);
        }
        // A confined listing may fail or return the empty mounted directory.
        for (const probe of ["listSecrets", "listOtherData"]) {
          const listing = filesystem[probe]!;
          if (listing.ok) expect(listing.value, probe).toEqual([]);
          else expect(deniedReadCodes(), `${probe}: ${JSON.stringify(listing)}`).toContain(listing.code);
        }
        // Secret denial returns null without wire errors; the own-namespace control must still succeed.
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

        // Deny the plugins root, including later installs; Windows has no equivalent neighbour deny.
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

          // Agent-plugin data and installed versions need separate controls outside pluginsRoot.
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

  // A delegated worker must not read what the child cannot; Windows shared-account workers have no neighbour deny.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "1a by delegation: a worker the child asks for reads its own grant and not a neighbour's data",
    async () => {
      if (!(await sandboxCasesRun())) return;
      expect(controls.secrets, "the secrets control did not hold").toBe("held");
      expect(execFileSync("/bin/cat", [join(staged.neighbourDataDir, SENTINEL_NAME)], { encoding: "utf-8" })).toBe(
        NEIGHBOUR_SENTINEL,
      );
      for (const agentDir of agentPluginNeighbourDirs(staged.aveHome)) {
        expect(execFileSync("/bin/cat", [join(agentDir, SENTINEL_NAME)], { encoding: "utf-8" })).toBe(NEIGHBOUR_SENTINEL);
      }
      const spawned = await spawnInstalled(staged.fixture);
      try {
        for (const otherDataDir of [staged.neighbourDataDir, ...agentPluginNeighbourDirs(staged.aveHome)]) {
          const result = await call(spawned, "escape_worker", {
            expectConfined: true,
            otherDataDir,
            sentinelName: SENTINEL_NAME,
            otherPluginId: NEIGHBOUR_ID,
            command: "/bin/cat",
          });
          // The worker must read its granted own data before neighbour denials count.
          expect(result.own, JSON.stringify(result.own)).toMatchObject({
            ok: true,
            value: { stdout: OWN_BYTES, exit: 0 },
          });
          const other = result.other as { ok: boolean; value?: { stdout: string; stderr: string; exit: unknown } };
          expect(other.ok, `${otherDataDir}: ${JSON.stringify(other)}`).toBe(true);
          // A worker that never exited measured nothing: only a refused read counts as confinement.
          expect(other.value!.exit, `${otherDataDir}: ${JSON.stringify(other)}`).toBeTypeOf("number");
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
        childEntryPath: pluginChildEntryPath(),
        observeChild: () => {
          observed = true;
        },
      });
      const refused = factory(contextFor(staged.fixture, host, config));
      await expect(refused).rejects.toBeInstanceOf(PluginSandboxGrantError);
      // Check the secrets-root refusal, not merely a missing approval.
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
        // Child errors carry no host details; verify the reason through the audit sink.
        expect(result.hostFetch).toMatchObject({ url: DENIED_URL, ok: false });
        expect(spawned.host.transportCalls).toEqual([]);
        const audit = await auditTexts(spawned.host.audit);
        const denials = audit.filter((row) => row.startsWith(`[plugin:${PLUGIN_ID}] host_fetch_denied`));
        expect(denials, JSON.stringify(audit)).toHaveLength(1);
        // Assert the allowlist reason so a later DNS or SSRF refusal cannot satisfy the test.
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
      // Run the execPath escape unwrapped to prove node-mode startup itself disables main-process APIs.
      const spawned = await spawnInstalled(staged.fixture, {}, { wrapped: false });
      try {
        const result = await call(spawned, "escape_electron", { expectConfined: true });
        expect(result).toMatchObject({
          attempt: "escape_electron",
          outcome: "no-usable-api",
          usable: [],
          runAsNode: "1",
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
        expect(result.patched).toEqual({ fetch: true, stdoutWrite: true });
        // A forged request keeps this connection identity; it cannot claim another plugin secret.
        expect(result.forged).toMatchObject({ key: `plugin.${NEIGHBOUR_ID}.key`, answered: true, result: null });
        const audit = await auditTexts(spawned.host.audit);
        expect(audit).toContain(
          `[plugin:${PLUGIN_ID}] hostSecret_denied reason=not-allowlisted key=plugin.${NEIGHBOUR_ID}.key`,
        );
        expect(audit.filter((row) => row.startsWith(`[plugin:${NEIGHBOUR_ID}]`))).toEqual([]);
        // Ignore and log identity fields outside the method contract.
        const warnings = sessionWarnings.slice(warningsBefore);
        expect(
          warnings.some(([meta, message]) =>
            message === "ignored an undeclared params field"
            && (meta as { pluginId?: string; method?: string; field?: string }).pluginId === PLUGIN_ID
            && (meta as { field?: string }).field === "pluginId",
          ),
          JSON.stringify(warnings),
        ).toBe(true);
        // Malformed raw frames must be dropped without poisoning the next valid call.
        expect(spawned.stdout().split("\n")).toContain("this line is not JSON");
        await expect(call(spawned, "escape_electron", { expectConfined: true })).resolves.toMatchObject({
          outcome: "no-usable-api",
        });
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
  // Recheck filesystem and socket confinement through the non-JavaScript process fixture; process entries exclude Windows.
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

// Positive controls must report before escape assertions; shutdown observations may overlap child work.
describe("the controls, which must hold before any escape is asserted", () => {
  it.runIf(ELECTRON_CONTROL_RUNS)(
    process.platform === "win32"
      ? "the Electron control ends after reporting (helper survival not observable: Windows has no process group)"
      : "the Electron control ends after reporting, and none of its helpers outlives it",
    async () => {
      expect(controlExit, "the Electron control did not start").toBeDefined();
      const exit = await controlExit!;
      if (exit.reaped) {
        // A valid control report and stalled shutdown are separate outcomes; log the stall stack to stderr.
        process.stderr.write(
          `[adversarial-escapes] the Electron control was reaped ${CONTROL_EXIT_GRACE_MS} ms after reporting:\n${exit.diagnostics}\n`,
        );
      }
      const ended = [{ code: 0, signal: null }, ...(exit.reaped ? [{ code: null, signal: "SIGKILL" }] : [])];
      expect(ended, `the Electron control ended badly:\n${exit.diagnostics}`).toContainEqual({
        code: exit.code,
        signal: exit.signal,
      });
      // Do not assert survivor fields on Windows where those measurements are unavailable.
      if (process.platform !== "win32") {
        expect(exit.survivor, `a helper of the Electron control outlived it:\n${exit.diagnostics}`).toBe(false);
        expect(exit.escaped, `a helper had left the control's process group, out of the group kill's reach:\n${exit.diagnostics}`).toEqual([]);
      }
    },
    CONTROL_EXIT_GRACE_MS + 60_000,
  );
});
