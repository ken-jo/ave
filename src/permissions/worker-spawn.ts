// Workers talk to their plugin only over stdin/stdout/stderr (worker stdio control v1 or output-only); no platform allocates a socket, a port or a loopback channel for them. stdin EOF is the liveness signal in both modes.
// Windows uses a dedicated per-worker holder grant and cleanup, never a shared all-plugin grant. Worker-confinement off preserves exact argv/secret-stripped env with no wrap. Production tools require a host-owned routing contract; manifest worker routing is not accepted.

import { errorMessage } from "../shared/error-message.js";
import { createLogger } from "../lib/logger.js";
import { registerWorkerOutputFlow } from "./worker-flow.js";
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { chmodSync, lstatSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { aveHome } from "../shared/ave-home.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  PLUGIN_WORKER_STATE_DIR_NAME,
  withPluginRuntimeDirQueue,
} from "../plugins/plugin-storage-layout.js";
import type {
  PluginWorkerControl,
  PluginWorkerExitInfo,
  PluginWorkerExitReason,
  WorkerControlRequestHandler,
  WorkerControlRequestOptions,
} from "../plugins/public-contract.js";
import {
  openWorkerStdioControl,
  WorkerControlFailedError,
  type WorkerStdioControl,
} from "./worker-stdio-control.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { spawnConfinedChild } from "./confined-child.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import { createSandboxProcessHome } from "./sandbox-process-home.js";
import {
  startWindowsAclGrantHolder,
  stopWindowsAclGrantHolder,
  terminateChildBestEffort,
} from "./windows-acl-grant-holder.js";
import {
  assertExtensionStartAllowed,
  isPluginWorkerConfinementActive,
  cleanupAsrtSandboxAfterCommand,
  grantWindowsWorkerFilesystemAccess,
  type WindowsWorkerFilesystemGrant,
} from "./asrt-sandbox.js";
import {
  markPluginWorkerWrapped,
  unmarkPluginWorkerWrapped,
} from "./sandbox-capability.js";

// Listener registered through SpawnedWorker.onStdout/`onStderr`.
export type WorkerOutputListener = (chunk: string) => void;

// The spec the HOST hands spawnWorker. The hostApi factory binds `pluginId` from the calling plugin instance; workerId/command/grant paths are declared by trusted first-party plugin code and reviewed at the HostApi effect boundary. `allowWritePaths` is the worker's filesystem write-jail; a requested state directory is added to it by the host.
export interface SpawnWorkerSpec {
  // Owning plugin id — selects the `~/.ave/plugins/<pluginId>/` sandbox root.
  readonly pluginId: string;
  // Stable per-worker id — names the `workers/<workerId>/` state dir + the reviewer wrapped-registry key. Sanitized to a single safe path segment.
  readonly workerId: string;
  // The worker executable to spawn (absolute path or PATH-resolved name).
  readonly command: string;
  // Argv for the worker.
  readonly args?: readonly string[];
  // Extra env merged onto the secret-stripped base env.
  readonly env?: NodeJS.ProcessEnv;
  // Paths the worker may read in addition to write-granted paths. This is explicit by design: host code must declare trusted worker code/runtime paths instead of the spawn primitive inferring path grants from argv.
  readonly allowReadPaths?: readonly string[];
  // Paths the worker may write (its sandbox root etc.).
  readonly allowWritePaths?: readonly string[];
  // The declared control mode. Required; an unknown value refuses before anything is created.
  readonly control: PluginWorkerControl;
  // Host-allocated `<plugin root>/workers/<workerId>/`, a sibling of the plugin's data dir that the plugin process cannot write. Granted read/write to the worker and named in AVE_WORKER_STATE_DIR.
  readonly stateDirectory?: boolean;
  // The reads, among allowReadPaths, this worker may hold inside the protected read floor: its plugin's declared `hostDirectory` that pierces it. Set by the host from the plugin's reviewed declaration, never by the plugin. Absent, none.
  readonly floorPierces?: readonly string[];
}

// Names the worker's state directory in its environment.
export const WORKER_STATE_DIR_ENV = "AVE_WORKER_STATE_DIR";

const log = createLogger("worker-spawn");

const activeWrappedWorkerKeys = new Set<string>();
const workerExitWaiters = new Map<string, Promise<void>>();

// Resolve after every worker of this plugin has definitively exited.
export async function waitForPluginWorkersStopped(pluginId: string): Promise<void> {
  const prefix = `${pluginId.length}:${pluginId}:`;
  await Promise.all([...workerExitWaiters].filter(([key]) => key.startsWith(prefix)).map(([, ended]) => ended));
}

function wrappedWorkerKey(pluginId: string, workerId: string): string {
  return `${pluginId.length}:${pluginId}:${workerId}`;
}

function reserveWrappedWorker(pluginId: string, workerId: string): () => void {
  const key = wrappedWorkerKey(pluginId, workerId);
  if (activeWrappedWorkerKeys.has(key)) {
    throw new Error(
      `[worker-spawn] worker ${pluginId}/${workerId} is already running or stopping`,
    );
  }
  activeWrappedWorkerKeys.add(key);
  let resolveExit!: () => void;
  workerExitWaiters.set(key, new Promise<void>((resolve) => { resolveExit = resolve; }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeWrappedWorkerKeys.delete(key);
    workerExitWaiters.delete(key);
    resolveExit();
  };
}

// Test-only reset for mocked children that do not emit a definitive exit.
export function __resetActiveWrappedWorkersForTest(): void {
  activeWrappedWorkerKeys.clear();
  workerExitWaiters.clear();
}

// The handle spawnWorker returns, discriminated by the spec's `control`. The host-side shape matches the public SpawnedPluginWorker.
interface SpawnedWorkerBase {
  // The child pid (undefined only if spawn produced no pid).
  readonly pid: number | undefined;
  // Stop the worker (stdin EOF, SIGTERM → SIGKILL after a grace period) + run cleanup.
  stop(): void;
  // Subscribe to worker stderr (utf-8).
  onStderr(listener: WorkerOutputListener): void;
  // Subscribe to worker EXIT (crash or normal). Fires once when the child process exits and its output streams drain — the consumer marks it dead and recovers (the handle owns lifecycle, so without it a crashed worker is undetectable).
  onExit(listener: (info: PluginWorkerExitInfo) => void): void;
}
export interface OutputOnlyWorker extends SpawnedWorkerBase {
  readonly control: "output-only-v1";
  // Subscribe to worker stdout (utf-8, trimmed-per-chunk false).
  onStdout(listener: WorkerOutputListener): void;
}
export interface StdioControlWorker extends SpawnedWorkerBase {
  readonly control: "stdio-control-v1";
  request(method: string, params?: unknown, options?: WorkerControlRequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onRequest(handler: WorkerControlRequestHandler): void;
  onNotification(listener: (method: string, params: unknown) => void): void;
}
export type SpawnedWorker = OutputOnlyWorker | StdioControlWorker;

const WORKER_CONTROLS: ReadonlySet<string> = new Set<PluginWorkerControl>(["stdio-control-v1", "output-only-v1"]);

const SAFE_WORKER_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

// Validate an id as one unambiguous path/registry segment.
function safeSegment(id: string, kind: string): string {
  if (typeof id !== "string" || !SAFE_WORKER_SEGMENT.test(id)) {
    throw new Error(
      `[worker-spawn] invalid ${kind} '${String(id)}' ` +
        "(expected 1-128 lowercase characters matching [a-z0-9][a-z0-9._-]*)",
    );
  }
  return id;
}

// Create (or reuse) the host-owned state dir. A symlinked leaf or `workers/` parent is refused: the worker's write grant must land on the directory the host made.
async function prepareWorkerStateDirectory(pluginId: string, workerId: string): Promise<string> {
  const pluginRoot = pathResolve(aveHome(), "plugins", pluginId);
  const parent = pathResolve(pluginRoot, PLUGIN_WORKER_STATE_DIR_NAME);
  const dir = pathResolve(parent, workerId);
  const refuseLink = (path: string): void => {
    let isLink: boolean;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (isLink) throw new Error(`[worker-spawn] refusing symlinked worker state directory: ${path}`);
  };
  await withPluginRuntimeDirQueue(pluginRoot, async () => {
    await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
    // One component at a time, each checked before anything is created through it: a recursive mkdir would follow a
    // symlinked `workers/` and create the leaf wherever it points.
    for (const path of [parent, dir]) {
      refuseLink(path);
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      refuseLink(path);
    }
    // `mkdir({recursive,mode})` only applies `mode` to dirs it creates.
    if (process.platform !== "win32") chmodSync(dir, 0o700);
  });
  return dir;
}

// The worker's standard streams. stdin is the host's LIVENESS PIPE in both modes: the host ends it only on an orderly stop, so otherwise the only EOF a worker can read there is the OS closing the write end because the host process is gone — in every death mode, not only the graceful Quit that runs the managed-child force-kill sweep. A stdio-control worker also reads its frames there; an output-only worker reads nothing. A worker reparented by a crashed or killed host has no other signal that its owner left; with stdin `"ignore"` it lived on forever.
const WORKER_STDIO: StdioOptions = ["pipe", "pipe", "pipe"];

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) extra[key] = value;
  }
  return extra;
}

// Spawn a plugin worker, host-mediated and (gate ON) ASRT-wrapped. See the module header for the model. A stdio-control worker resolves only after it answered the host's hello; otherwise it is stopped, its exit awaited, and the call rejects with WorkerControlFailedError.
export function spawnWorker(spec: SpawnWorkerSpec & { readonly control: "output-only-v1" }): Promise<OutputOnlyWorker>;
export function spawnWorker(spec: SpawnWorkerSpec & { readonly control: "stdio-control-v1" }): Promise<StdioControlWorker>;
export function spawnWorker(spec: SpawnWorkerSpec): Promise<SpawnedWorker>;
export async function spawnWorker(spec: SpawnWorkerSpec): Promise<SpawnedWorker> {
  assertExtensionStartAllowed({ holder: "worker" });
  const safePlugin = safeSegment(spec.pluginId, "pluginId");
  const safeWorker = safeSegment(spec.workerId, "workerId");
  if (typeof spec.control !== "string" || !WORKER_CONTROLS.has(spec.control)) {
    throw new Error(
      `[worker-spawn] worker ${safePlugin}/${safeWorker} declares control '${String(spec.control)}'; `
        + "expected \"stdio-control-v1\" or \"output-only-v1\"",
    );
  }
  const control = spec.control;
  // Windows environment names are case-insensitive, so any spelling of the name is the host's.
  const namesStateDir = (key: string): boolean =>
    process.platform === "win32" ? key.toUpperCase() === WORKER_STATE_DIR_ENV : key === WORKER_STATE_DIR_ENV;
  if (spec.env !== undefined && Object.keys(spec.env).some(namesStateDir)) {
    throw new Error(`[worker-spawn] worker ${safePlugin}/${safeWorker} may not set ${WORKER_STATE_DIR_ENV}; the host names the state directory`);
  }
  const label = `worker:${safePlugin}:${safeWorker}`;
  const args = [...(spec.args ?? [])];

  // Secret-stripped base env (Least Privilege), shared with other child process spawners so Windows runtime variables stay complete without forwarding provider/API-key secrets.
  const baseEnv: NodeJS.ProcessEnv = buildSafeChildEnv(definedEnv(spec.env));
  const stateDir = spec.stateDirectory === true ? await prepareWorkerStateDirectory(safePlugin, safeWorker) : undefined;
  if (stateDir !== undefined) baseEnv[WORKER_STATE_DIR_ENV] = stateDir;
  const stateGrant = stateDir !== undefined ? [stateDir] : [];

  // Gate OFF → plain unwrapped spawn
  if (!isPluginWorkerConfinementActive()) {
    assertManagedChildProcessAdmissionOpen(`worker:${safePlugin}:${safeWorker}`);
    const child = spawn(spec.command, args, {
      stdio: WORKER_STDIO,
      shell: false,
      windowsHide: true,
      env: baseEnv,
    });
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}` });
    return await openHandle(child, control, label);
  }

  // A wrapped worker owns a stable per-(plugin,worker) identity. Keep that key reserved while it is running OR stopping; otherwise a replacement can lose its marker when the old exit arrives.
  const releaseWorkerReservation = reserveWrappedWorker(safePlugin, safeWorker);

  if (process.platform === "win32") {
    let holder: ChildProcess;
    try {
      holder = startWindowsAclGrantHolder(
        `worker:${safePlugin}:${safeWorker}:asrt-win-acl`,
      );
    } catch (err) {
      releaseWorkerReservation();
      throw err;
    }
    const holderPid = holder.pid;
    if (holderPid === undefined) {
      stopWindowsAclGrantHolder(holder);
      releaseWorkerReservation();
      throw new Error("[worker-spawn] Windows ACL grant holder started without a pid");
    }
    let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
    try {
      sandboxHome = createSandboxProcessHome();
    } catch (err) {
      stopWindowsAclGrantHolder(holder);
      releaseWorkerReservation();
      throw err instanceof Error ? err : new Error(String(err));
    }
    let grant: WindowsWorkerFilesystemGrant | undefined;
    let wrapped = false;
    let marked = false;
    let child: ChildProcess | undefined;
    let grantReleased = false;
    let asrtCleanupRequested = false;
    let holderStopped = false;
    let holderFailure: Error | undefined;
    const cleanupResources = (): void => {
      if (marked) {
        marked = false;
        unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      }
      if (wrapped && !asrtCleanupRequested) {
        asrtCleanupRequested = true;
        void cleanupAsrtSandboxAfterCommand();
      }
      if (grant !== undefined && !grantReleased) {
        grantReleased = true;
        try {
          grant.release();
        } catch {
          // Cleanup must continue even if ASRT reports the grant was already gone.
        }
      }
      if (!holderStopped) {
        holderStopped = true;
        stopWindowsAclGrantHolder(holder);
      }
    };
    const finalizeResources = (): void => {
      cleanupResources();
      sandboxHome.cleanup();
      releaseWorkerReservation();
    };
    const holderDied = (first?: unknown, second?: unknown): void => {
      if (holderStopped) return;
      holderStopped = true;
      holderFailure =
        first instanceof Error
          ? first
          : new Error(
              `[worker-spawn] Windows ACL grant holder exited before worker cleanup ` +
                `(code=${String(first ?? "null")} signal=${String(second ?? "null")})`,
            );
      if (child !== undefined) {
        terminateChildBestEffort(child);
      } else {
        cleanupResources();
        sandboxHome.cleanup();
        releaseWorkerReservation();
      }
    };
    const assertHolderAlive = (): void => {
      if (holderFailure !== undefined) throw holderFailure;
    };
    holder.once("exit", holderDied);
    holder.once("error", holderDied);
    try {
      grant = await grantWindowsWorkerFilesystemAccess({
        holderPid,
        allowRead: [sandboxHome.path, ...stateGrant, ...(spec.allowReadPaths ?? [])],
        allowWrite: [sandboxHome.path, ...stateGrant, ...(spec.allowWritePaths ?? [])],
      });
      assertHolderAlive();

      // Windows grants reachability through ACLs against the holder process, so the wrap carries the deny floor only. The worker runs through the stdio relay: srt-win delivers neither its environment nor its stdin, and stdin is the liveness pipe — without the relay a worker reads its end at once and takes the host for gone (measured).
      const spawned = await spawnConfinedChild({
        command: spec.command,
        args,
        label: `worker:${safePlugin}:${safeWorker}:asrt-win`,
        egressOwner: { kind: "worker", role: "worker", pluginId: spec.pluginId, instanceId: spec.workerId },
        grantMode: "deny-only",
        baseEnv,
        extraEnv: { ...sandboxHome.env },
        stdio: WORKER_STDIO,
        windowsStdio: "relay",
        // srt-win starts only in a directory the sandbox account is granted; the host's own cwd is not one.
        cwd: sandboxHome.path,
        assertStillValid: assertHolderAlive,
        onWrapped: () => {
          wrapped = true;
          markPluginWorkerWrapped(safePlugin, safeWorker);
          marked = true;
        },
      });
      child = spawned.child;
      child.once("exit", finalizeResources);
      child.once("error", () => {
        // `error` can mean signal/message delivery failed while the child is still alive. Definitive resource finalization stays on exit/close.
      });
      child.once("close", finalizeResources);
      assertHolderAlive();

      return await openHandle(child, control, label, spawned);
    } catch (err) {
      if (child !== undefined) {
        terminateChildBestEffort(child);
      } else {
        cleanupResources();
        sandboxHome.cleanup();
        releaseWorkerReservation();
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }

  // FAIL-CLOSED write jail: the host-supplied write paths plus the worker's own HOME and state dir. The worker also needs to READ them + tmp.
  const allowWrite = [sandboxHome.path, ...stateGrant, ...(spec.allowWritePaths ?? [])];
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  const allowRead = [
    sandboxHome.path,
    ...stateGrant,
    ...(spec.allowReadPaths ?? []),
    ...(spec.allowWritePaths ?? []),
    ...(tmpDir ? [tmpDir] : []),
  ];

  let wrapped = false;
  let child: ChildProcess;
  try {
    // Assemble the command DEFENSIVELY: shell-quote the binary + every arg so a path with spaces/metacharacters cannot mis-split. ASRT runs this branch under a POSIX shell (mac/linux). The per-command wrap carries ONLY the filesystem jail (the `--bind`).
    ({ child } = await spawnConfinedChild({
      command: spec.command,
      args,
      label: `worker:${safePlugin}:${safeWorker}:asrt`,
      egressOwner: { kind: "worker", role: "worker", pluginId: spec.pluginId, instanceId: spec.workerId },
      grantMode: "allow-list",
      // A worker shares its plugin's temp directory, and no other plugin's.
      tempPrincipal: { kind: "plugin", id: spec.pluginId },
      allowRead,
      allowWrite,
      // A plugin worker is plugin-owned code: it may not remove or replace the host-created roots it writes into, its plugin's data root above all.
      pinWriteRoots: true,
      // Nor read what its plugin's child cannot: the plugins root is refused, and only the paths this worker was granted — which the dispatcher holds to the child's own envelope — are re-allowed inside it. Without this a child refused a neighbour's data could ask for a worker that reads it.
      denyPluginsRoot: true,
      ...(spec.floorPierces !== undefined ? { floorPierces: spec.floorPierces } : {}),
      baseEnv,
      extraEnv: { ...sandboxHome.env },
      stdio: WORKER_STDIO,
      onWrapped: () => {
        // The wrap incremented ASRT's per-command state (Linux activeSandboxCount, proxy ref); from here a failure MUST decrement it (see the catch).
        wrapped = true;
        // Mark the reviewer wrapped-registry: this worker genuinely runs under ASRT. Keyed plugin-scoped (NOT workerId alone) so two plugins sharing a workerId (e.g. "main") cannot collide into a false `asrt` no-leak signal.
        markPluginWorkerWrapped(safePlugin, safeWorker);
      },
    }));
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}:asrt` });

    // Idempotent definitive-termination cleanup (mirrors mcp-client): exit or close runs it once. A stop request and process-operation error retain ownership because neither proves the child is dead. Drops the reviewer marker and releases the per-command ASRT state.
    let cleanupRan = false;
    const cleanupOnce = (): void => {
      if (cleanupRan) return;
      cleanupRan = true;
      unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      void cleanupAsrtSandboxAfterCommand();
    };
    const finalizeOnce = (): void => {
      cleanupOnce();
      sandboxHome.cleanup();
      releaseWorkerReservation();
    };
    child.once("exit", finalizeOnce);
    child.once("error", () => {
      // A process-operation error is not proof of death. `close` is the asynchronous-spawn-failure finalizer; live children finalize on exit.
    });
    child.once("close", finalizeOnce);
  } catch (err) {
    // FAIL CLOSED: wrap/spawn setup failed. If the wrap had SUCCEEDED (failure was the post-wrap spawn / empty-argv), also decrement ASRT's per-command state and drop the reviewer marker — `cleanupOnce` never wired up, so the catch owns that teardown.
    if (wrapped) {
      unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      void cleanupAsrtSandboxAfterCommand();
    }
    sandboxHome.cleanup();
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }
  // Outside the try: from here the child's own exit finalizes its resources, including after a failed hello.
  return await openHandle(child, control, label);
}

// Build the SpawnedWorker handle around a spawned child. A stdio-control worker must complete the hello first; when it does not, it is stopped and its exit awaited before the error surfaces, so no failed spawn leaves a process behind.
async function openHandle(
  child: ChildProcess,
  control: PluginWorkerControl,
  label: string,
  io: { readonly stdin: Writable | null; readonly stdout: Readable | null } = child,
): Promise<SpawnedWorker> {
  const outputBacklogMax = 1024 * 1024;
  const outputBacklogEventMax = 256;
  let stopped = false;
  let endReason: PluginWorkerExitReason | undefined;
  let channel: WorkerStdioControl | undefined;
  let terminalExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let completed = false;
  const stopOnce = (reason: PluginWorkerExitReason = "stopped"): void => {
    if (stopped || terminalExit) return;
    stopped = true;
    endReason ??= reason;
    channel?.close();
    terminateChildBestEffort(child);
  };
  type OutputState = {
    listeners: WorkerOutputListener[];
    backlog: string[];
    bytes: number;
    overflowed: boolean;
  };
  const stdout: OutputState = { listeners: [], backlog: [], bytes: 0, overflowed: false };
  const stderr: OutputState = { listeners: [], backlog: [], bytes: 0, overflowed: false };
  let replayFailure: { error: unknown } | undefined;
  const captureOutput = (state: OutputState, chunk: Buffer): void => {
    if (replayFailure || state.overflowed) return;
    const text = chunk.toString("utf-8");
    if (state.listeners.length > 0) {
      for (const listener of state.listeners) {
        // A plugin listener that throws must not become an uncaught exception in the host.
        try {
          listener(text);
        } catch (error) {
          log.warn(`[worker-spawn] ${label}: an output listener threw: ${errorMessage(error)}`);
        }
      }
      return;
    }
    const bytes = text.length * 2;
    if (state.backlog.length >= outputBacklogEventMax || state.bytes + bytes > outputBacklogMax) {
      state.backlog = [];
      state.bytes = 0;
      state.overflowed = true;
      stopOnce("output-overflow");
      return;
    }
    state.backlog.push(text);
    state.bytes += bytes;
  };
  // A stdio-control worker's stdout belongs to its channel; only an output-only worker's is text.
  if (control === "output-only-v1") io.stdout?.on("data", (chunk: Buffer) => captureOutput(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => captureOutput(stderr, chunk));

  const exitListeners: Array<(info: PluginWorkerExitInfo) => void> = [];
  const exitInfo = (): PluginWorkerExitInfo => ({ ...terminalExit!, reason: endReason ?? "exited" });
  const outputStreams = [...new Set([io.stdout, child.stderr].filter((stream): stream is Readable => stream !== null))];
  const drained = new Set(outputStreams.filter((stream) => stream.readableEnded || stream.closed));
  let resolveCompleted!: () => void;
  const completion = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const completeIfDrained = (): void => {
    if (completed || !terminalExit || drained.size !== outputStreams.length) return;
    completed = true;
    resolveCompleted();
    const info = exitInfo();
    for (const listener of exitListeners.splice(0)) listener(info);
  };
  for (const stream of outputStreams) {
    const markDrained = (): void => {
      drained.add(stream);
      completeIfDrained();
    };
    stream.once("end", markDrained);
    stream.once("close", markDrained);
  }
  const captureExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    // Record death immediately so stop cannot signal a reused pid while pipes drain.
    terminalExit ??= { code, signal };
    channel?.processEnded();
    completeIfDrained();
  };
  child.once("exit", captureExit);
  child.once("close", captureExit);
  if (child.exitCode !== null || child.signalCode !== null) {
    captureExit(child.exitCode, child.signalCode);
  }
  const subscribeOutput = (state: OutputState, name: string, listener: WorkerOutputListener): void => {
    if (replayFailure) throw replayFailure.error;
    if (state.overflowed) {
      throw new Error(`Worker ${name} exceeded the ${outputBacklogMax}-byte or ${outputBacklogEventMax}-event pre-listener buffer.`);
    }
    state.listeners.push(listener);
    const queued = state.backlog;
    state.backlog = [];
    state.bytes = 0;
    try {
      for (const chunk of queued) listener(chunk);
    } catch (error) {
      replayFailure = { error };
      for (const output of [stdout, stderr]) {
        output.backlog = [];
        output.bytes = 0;
        output.listeners = [];
      }
      stopOnce();
      throw error;
    }
  };

  // A worker that exits first leaves stdin without a reader. A late EPIPE on it is that pipe ending as designed, not a host fault, and must not surface as an unhandled 'error' on the host.
  io.stdin?.on("error", () => {});
  const base = {
    pid: child.pid,
    onStderr: (listener: WorkerOutputListener) => subscribeOutput(stderr, "stderr", listener),
    onExit(listener: (info: PluginWorkerExitInfo) => void): void {
      if (completed) listener(exitInfo());
      else exitListeners.push(listener);
    },
    stop(): void {
      // Keep ASRT/HOME ownership until definitive child termination. A TERM-ignoring worker is escalated without releasing its confinement.
      stopOnce();
    },
  };
  const outputPipes = [io.stdout, child.stderr].filter((stream): stream is Readable => stream !== null);
  const flowOf = (pauseControl?: () => void, resumeControl?: () => void) => ({
    pause: () => {
      if (terminalExit) return;
      if (pauseControl) pauseControl();
      for (const stream of outputPipes) if (stream !== io.stdout || !pauseControl) stream.pause();
    },
    resume: () => {
      if (resumeControl) resumeControl();
      for (const stream of outputPipes) if (stream !== io.stdout || !resumeControl) stream.resume();
    },
    end: (reason: "output-overflow") => stopOnce(reason),
  });
  if (control === "output-only-v1") {
    const handle: OutputOnlyWorker = {
      ...base,
      control,
      onStdout: (listener) => subscribeOutput(stdout, "stdout", listener),
    };
    registerWorkerOutputFlow(handle, flowOf());
    return handle;
  }
  if (!io.stdin || !io.stdout) {
    stopOnce();
    await completion;
    throw new WorkerControlFailedError(`[worker-spawn] ${label} has no stdin/stdout pipe to carry its control channel`);
  }
  try {
    channel = await openWorkerStdioControl({
      stdin: io.stdin,
      stdout: io.stdout,
      helloMs: TOOL_TIMEOUT_POLICY.workerControlHelloMs,
      onEnd: (reason) => stopOnce(reason),
    });
  } catch (error) {
    endReason ??= "control-violation";
    stopOnce("control-violation");
    // Surface the failure only once the process is gone, so a refused spawn leaves nothing running.
    await completion;
    throw error instanceof WorkerControlFailedError
      ? error
      : new WorkerControlFailedError(`[worker-spawn] ${label}: ${errorMessage(error)}`);
  }
  if (terminalExit) channel.processEnded();
  const opened = channel;
  const handle: StdioControlWorker = {
    ...base,
    control,
    request: (method, params, options) => opened.request(method, params, options),
    notify: (method, params) => opened.notify(method, params),
    onRequest: (handler) => opened.onRequest(handler),
    onNotification: (listener) => opened.onNotification(listener),
  };
  registerWorkerOutputFlow(handle, flowOf(() => opened.pauseInput(), () => opened.resumeInput()));
  return handle;
}
