// Linux network namespaces require a host-visible writable UDS directory plus AF_UNIX allowance; macOS requires a shared socket-directory allowance. Register shared socket policy before wrapping because per-command overrides are inert; remove it on cleanup and keep plugin-owned socket dirs/files private.
// Windows uses TCP with a dedicated per-worker holder grant and cleanup, never a shared all-plugin grant. Worker-confinement off preserves exact argv/secret-stripped env with no UDS directory or wrap. Production tools require a host-owned routing contract; manifest worker routing is not accepted.

import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { unlinkSync, rmdirSync, chmodSync, lstatSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import type { Readable, Writable } from "node:stream";

import { aveHome } from "../shared/ave-home.js";
import {
  assertUnixSocketPathFits,
  PLUGIN_WORKER_RUN_DIR_NAME,
  withPluginRuntimeDirQueue,
} from "../plugins/plugin-storage-layout.js";
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
  registerWorkerUnixSocketDir,
  unregisterWorkerUnixSocketDir,
  grantWindowsWorkerFilesystemAccess,
  type WindowsWorkerFilesystemGrant,
} from "./asrt-sandbox.js";
import {
  markPluginWorkerWrapped,
  unmarkPluginWorkerWrapped,
} from "./sandbox-capability.js";

// Listener registered through SpawnedWorker.onStdout/`onStderr`.
export type WorkerOutputListener = (chunk: string) => void;

// The spec the HOST hands spawnWorker. The hostApi factory binds `pluginId` from the calling plugin instance; workerId/command/grant paths are declared by trusted first-party plugin code and reviewed at the HostApi effect boundary. `allowWritePaths` is the worker's filesystem write-jail; the host-allocated socketDir is unioned onto it automatically.
export interface SpawnWorkerSpec {
  // Owning plugin id — selects the `~/.ave/plugins/<pluginId>/` sandbox root.
  readonly pluginId: string;
  // Stable per-worker id — names the `run/<workerId>/` control dir + the reviewer wrapped-registry key. Sanitized to a single safe path segment.
  readonly workerId: string;
  // The worker executable to spawn (absolute path or PATH-resolved name).
  readonly command: string;
  // Argv for the worker. The UDS path is injected per udsArgName.
  readonly args?: readonly string[];
  // Extra env merged onto the secret-stripped base env.
  readonly env?: NodeJS.ProcessEnv;
  // Paths the worker may read in addition to write-granted paths. This is explicit by design: host code must declare trusted worker code/runtime paths instead of the spawn primitive inferring path grants from argv.
  readonly allowReadPaths?: readonly string[];
  // Paths the worker may write (its sandbox root etc.). The host-allocated socketDir is added automatically so the `--bind` (Linux) comes for free.
  readonly allowWritePaths?: readonly string[];
  // How the host tells the worker WHERE to bind the control socket (gate ON, non-win32 only — when `socketPath` is non-null): - a string like `"--uds"` → appends `[udsArgName, socketPath]` to args; - `{ env: "AVE_CONTROL_SOCKET" }` → sets that env var to socketPath. The actual worker contract is plugin-specific; this primitive only provides the injection mechanism. Omitted ⇒ the worker is NOT told the path here (a future contract may discover it another way).
  readonly udsArgName?: string | { readonly env: string };
  // The reads, among allowReadPaths, this worker may hold inside the protected read floor: its plugin's declared `hostDirectory` that pierces it. Set by the host from the plugin's reviewed declaration, never by the plugin. Absent, none.
  readonly floorPierces?: readonly string[];
}

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

// The handle spawnWorker returns. `socketPath` is the host-side path to connect to (undici `Agent({ connect: { socketPath } })` / `http.request({ socketPath })`) — or `null` when the worker should use TCP control. `null` means gate-OFF plain spawn; callers must not infer sandbox status from transport alone.
export interface SpawnedWorker {
  // Host-side UDS path, or null when the worker uses TCP control.
  readonly socketPath: string | null;
  // The child pid (undefined only if spawn produced no pid).
  readonly pid: number | undefined;
  // Stop the worker (SIGTERM → SIGKILL after a grace period) + run cleanup.
  stop(): void;
  // Subscribe to worker stdout (utf-8, trimmed-per-chunk false).
  onStdout(listener: WorkerOutputListener): void;
  // Subscribe to worker stderr (utf-8).
  onStderr(listener: WorkerOutputListener): void;
  // Subscribe to worker EXIT (crash or normal). Fires once when the child process exits and its output streams drain — the consumer marks it dead and recovers (the handle owns lifecycle, so without it a crashed worker is undetectable).
  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
}

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

// Best-effort, idempotent removal of a stale control socket + its dir. Used before spawn (crash-safe: a previous worker may have died without cleanup) and on stop/exit. Sync so it can run inside an exit handler. Never throws.
function removeSocketArtifacts(socketPath: string, socketDir: string): void {
  try {
    unlinkSync(socketPath);
  } catch {
    // Already gone / never created — fine.
  }
  try {
    // Only removes the dir if empty — leaves a non-empty dir intact rather than deleting worker state we don't own.
    rmdirSync(socketDir);
  } catch {
    // Non-empty or already gone — fine.
  }
}

// The worker's standard streams. stdin is the host's LIVENESS PIPE: the host never writes to it and never ends it, so the only EOF a worker can ever read there is the OS closing the write end because the host process is gone — in every death mode, not only the graceful Quit that runs the managed-child force-kill sweep. A worker reparented by a crashed or killed host has no other signal that its owner left; with stdin `"ignore"` it lived on forever.
const WORKER_STDIO: StdioOptions = ["pipe", "pipe", "pipe"];

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) extra[key] = value;
  }
  return extra;
}

// Spawn a long-lived plugin worker, host-mediated and (gate ON) ASRT-wrapped with a bind-mounted UDS control channel. See the module header for the model. @returns a SpawnedWorker. `socketPath` is non-null only on the wrapped mac/linux UDS path; null covers gate-OFF plain TCP and the Windows ASRT wrapped path, which keeps TCP control while filesystem/network effects run under srt-win.
export async function spawnWorker(spec: SpawnWorkerSpec): Promise<SpawnedWorker> {
  assertExtensionStartAllowed({ holder: "worker" });
  const safePlugin = safeSegment(spec.pluginId, "pluginId");
  const safeWorker = safeSegment(spec.workerId, "workerId");
  const args = [...(spec.args ?? [])];

  // Secret-stripped base env (Least Privilege), shared with other child process spawners so Windows runtime variables stay complete without forwarding provider/API-key secrets.
  const baseEnv: NodeJS.ProcessEnv = buildSafeChildEnv(definedEnv(spec.env));

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
    return makeHandle(child, null);
  }

  // A wrapped worker owns a stable per-(plugin,worker) control path. Keep that key reserved while it is running OR stopping; otherwise a replacement can lose its marker, shared UDS allowance, and socket when the old exit arrives.
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
        allowRead: [sandboxHome.path, ...(spec.allowReadPaths ?? [])],
        allowWrite: [sandboxHome.path, ...(spec.allowWritePaths ?? [])],
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

      return makeHandle(child, null, spawned);
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

  // Gate ON, mac/linux → ASRT-wrapped with a bind-mounted UDS socketDir under the plugin's OWN sandbox root (storage-namespace rule), host-controlled. mkdir 0o700; the worker binds the socket 0o600.
  const pluginRoot = pathResolve(aveHome(), "plugins", safePlugin);
  const socketDir = pathResolve(
    pluginRoot,
    PLUGIN_WORKER_RUN_DIR_NAME,
    safeWorker,
  );
  const socketPath = join(socketDir, "control.sock");
  // A path over `sun_path` fails as `EINVAL` — "malformed address" — which sends the diagnosis anywhere but at a length. Checked here, where the path was just assembled and the message can name every part of it.
  assertUnixSocketPathFits(socketPath, `worker control socket for ${safePlugin}/${safeWorker}`);
  // Crash-safe: unlink any stale socket from a previous worker that died without cleanup BEFORE recreating the dir.
  try {
    await withPluginRuntimeDirQueue(pluginRoot, async () => {
      removeSocketArtifacts(socketPath, socketDir);
      await mkdir(socketDir, { recursive: true, mode: 0o700 });
      // `mkdir({recursive,mode})` only applies `mode` to dirs it CREATES — a pre-existing leaf (e.g. left by an older build under a looser umask) keeps its old mode. Reject a symlinked socketDir (a same-user attacker pre-seeding the path can't redirect the bind/binds) FIRST, then force 0o700: `chmod` follows a link, so the other order would change the mode of whatever the link points at before refusing it.
      if (lstatSync(socketDir).isSymbolicLink()) {
        throw new Error(`[worker-spawn] refusing symlinked control dir: ${socketDir}`);
      }
      chmodSync(socketDir, 0o700);
    });
  } catch (err) {
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }

  let sandboxHome: ReturnType<typeof createSandboxProcessHome>;
  try {
    sandboxHome = createSandboxProcessHome();
  } catch (err) {
    removeSocketArtifacts(socketPath, socketDir);
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Tell the worker where to bind. Either append `[name, path]` to argv or set an env var; the higher-level worker protocol remains plugin-specific.
  if (typeof spec.udsArgName === "string") {
    args.push(spec.udsArgName, socketPath);
  } else if (spec.udsArgName && typeof spec.udsArgName === "object") {
    baseEnv[spec.udsArgName.env] = socketPath;
  }

  // FAIL-CLOSED write jail: socketDir (so the Linux `--bind` exposes it + the socket file can be created on macOS) ∪ the host-supplied write paths. The worker also needs to READ its socketDir + tmp.
  const allowWrite = [socketDir, sandboxHome.path, ...(spec.allowWritePaths ?? [])];
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  const allowRead = [
    socketDir,
    sandboxHome.path,
    ...(spec.allowReadPaths ?? []),
    ...(spec.allowWritePaths ?? []),
    ...(tmpDir ? [tmpDir] : []),
  ];

  // UDS allow — SHARED config, NOT per-command (the per-command channel is INERT for the seatbelt/seccomp UDS rules in current ASRT; see asrt-sandbox.ts's WORKER UDS header). Register the socketDir so the live shared config grants the worker's bind: macOS `allowUnixSockets:(subpath <dir>)`, Linux the `allowAllUnixSockets` weakening (the `--bind` of the writable dir scopes WHERE). MUST happen BEFORE the wrap so the spawned profile carries it.
  let registered = false;
  const socketHolder = {};
  let wrapped = false;
  try {
    await registerWorkerUnixSocketDir(socketDir, socketHolder);
    registered = true;

    // Assemble the command DEFENSIVELY: shell-quote the binary + every arg so a path with spaces/metacharacters cannot mis-split. ASRT runs this branch under a POSIX shell (mac/linux). The per-command wrap carries ONLY the filesystem jail (the `--bind`).
    const { child } = await spawnConfinedChild({
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
    });
    trackManagedChildProcess(child, { label: `worker:${safePlugin}:${safeWorker}:asrt` });

    // Idempotent definitive-termination cleanup (mirrors mcp-client): exit or close runs it once. A stop request and process-operation error retain ownership because neither proves the child is dead. Drops the reviewer marker, releases the shared-config UDS allow + the per-command ASRT state, and removes the socket artifacts (crash-safe).
    let cleanupRan = false;
    const cleanupOnce = (): void => {
      if (cleanupRan) return;
      cleanupRan = true;
      unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      void unregisterWorkerUnixSocketDir(socketDir, socketHolder);
      void cleanupAsrtSandboxAfterCommand();
      removeSocketArtifacts(socketPath, socketDir);
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

    return makeHandle(child, socketPath);
  } catch (err) {
    // FAIL CLOSED: wrap/spawn setup failed. Roll back the shared-config UDS allow + socket artifacts so a failed spawn leaves no lingering allowance. If the wrap had SUCCEEDED (failure was the post-wrap spawn / empty-argv), also decrement ASRT's per-command state and drop the reviewer marker — `cleanupOnce` never wired up, so the catch owns that teardown.
    if (wrapped) {
      unmarkPluginWorkerWrapped(safePlugin, safeWorker);
      void cleanupAsrtSandboxAfterCommand();
    }
    if (registered) void unregisterWorkerUnixSocketDir(socketDir, socketHolder);
    sandboxHome.cleanup();
    removeSocketArtifacts(socketPath, socketDir);
    releaseWorkerReservation();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

// Compose the WRAPPED worker's env: the secret-stripped per-worker base env plus ONLY the ASRT proxy/CA keys ASRT actually CHANGED relative to `process.env` (none on mac/linux — proxy baked into the command string). Mirrors mcp-client's buildWrappedStdioEnv.
// Build the SpawnedWorker handle around a spawned child.
function makeHandle(
  child: ChildProcess,
  socketPath: string | null,
  io: { readonly stdin: Writable | null; readonly stdout: Readable | null } = child,
): SpawnedWorker {
  const outputBacklogMax = 1024 * 1024;
  const outputBacklogEventMax = 256;
  let stopped = false;
  let terminalExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let completed = false;
  const stopOnce = (): void => {
    if (stopped || terminalExit) return;
    stopped = true;
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
      for (const listener of state.listeners) listener(text);
      return;
    }
    const bytes = text.length * 2;
    if (state.backlog.length >= outputBacklogEventMax || state.bytes + bytes > outputBacklogMax) {
      state.backlog = [];
      state.bytes = 0;
      state.overflowed = true;
      stopOnce();
      return;
    }
    state.backlog.push(text);
    state.bytes += bytes;
  };
  io.stdout?.on("data", (chunk: Buffer) => captureOutput(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => captureOutput(stderr, chunk));

  const exitListeners: Array<(info: { code: number | null; signal: NodeJS.Signals | null }) => void> = [];
  const outputStreams = [...new Set([io.stdout, child.stderr].filter((stream): stream is Readable => stream !== null))];
  const drained = new Set(outputStreams.filter((stream) => stream.readableEnded || stream.closed));
  const completeIfDrained = (): void => {
    if (completed || !terminalExit || drained.size !== outputStreams.length) return;
    completed = true;
    for (const listener of exitListeners.splice(0)) listener(terminalExit);
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

  // A worker that exits first leaves the liveness pipe without a reader. A late EPIPE on it is that pipe ending as designed, not a host fault, and must not surface as an unhandled 'error' on the host.
  io.stdin?.on("error", () => {});
  return {
    socketPath,
    pid: child.pid,
    onStdout: (listener) => subscribeOutput(stdout, "stdout", listener),
    onStderr: (listener) => subscribeOutput(stderr, "stderr", listener),
    onExit(listener): void {
      if (completed) listener(terminalExit!);
      else exitListeners.push(listener);
    },
    stop(): void {
      // Keep ASRT/UDS/HOME ownership until definitive child termination. A TERM-ignoring worker is escalated without releasing its confinement.
      stopOnce();
    },
  };
}
