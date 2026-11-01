import { randomBytes } from "node:crypto";
import { PassThrough, Writable, type Duplex } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { getHostResources } from "../main/host-resources.js";
import { spawnManaged } from "../main/managed-child-processes.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { assertMxcExtensionRequest } from "./mxc-extension-request.js";
import { MxcExtensionChannel } from "./mxc-extension-channel.js";
import { MXC_STREAM_CHUNK_BYTES } from "./mxc-extension-protocol.js";
import { MxcIntegrityError } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError, MxcSupervisorLostError } from "./mxc-extension-errors.js";

interface ProcessResult { exitCode: number; timedOut: boolean }
export type MxcProcessLifecycleEvent = { type: "supervisor-started"; pid: number }
  | { type: "native-created"; id: number; processHandle: string; supervisorPid: number }
  | { type: "creating" | "spawning" } | { type: "stopped"; spawnPendingAtCancellation: boolean };
type LifecycleObserver = (event: MxcProcessLifecycleEvent) => void;

function notifyLifecycle(observer: LifecycleObserver | undefined, event: MxcProcessLifecycleEvent): void {
  try { observer?.(event); } catch (cause) {
    throw new MxcProcessContractError("Extension lifecycle observer failed", { cause });
  }
}
export interface OwnedMxcExtensionProcess {
  readonly id: number;
  readonly stdin: Writable;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly completion: Promise<ProcessResult>;
  readonly diagnostics: { nodeVersion: string; nativeModules: readonly string[]; nativeModuleCount: number; nativeModulesTruncated: boolean; ownerHandle: string };
  dispose(): Promise<void>;
}

class SupervisedMxcProcess implements OwnedMxcExtensionProcess {
  id = 0;
  readonly stdout = new PassThrough({ highWaterMark: MXC_STREAM_CHUNK_BYTES });
  readonly stderr = new PassThrough({ highWaterMark: MXC_STREAM_CHUNK_BYTES });
  readonly stdin: Writable;
  readonly completion: Promise<ProcessResult>;
  readonly ready: Promise<void>;
  diagnostics = { nodeVersion: "", nativeModules: [] as string[], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" };
  private readonly channel: MxcExtensionChannel;
  private readonly liveness: Duplex;
  private readonly closed: Promise<void>;
  private result: ProcessResult | undefined;
  private failure: Error | undefined;
  private lifecycleFailure: Error | undefined;
  private creationRequested = false;
  private creationStarted = false;
  private spawnInvoked = false;
  private nativeId = 0;
  private failureReceipt = false;
  private stopping = false;
  private stopped = false;
  private cleanup: Promise<void> | undefined;
  private closedAlready = false;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private resolveCompletion!: (result: ProcessResult) => void;
  private rejectCompletion!: (error: Error) => void;

  constructor(private readonly child: ChildProcess, generation: string, key: Buffer, private readonly onLifecycle?: LifecycleObserver, private readonly beforeSpawn?: () => void) {
    if (!child.stdin || !child.stdout || !child.stderr || !child.stdio[3]) {
      child.kill();
      throw new MxcProcessContractError("Supervisor requires private standard streams");
    }
    this.channel = new MxcExtensionChannel(child.stdout, child.stdin, generation, key, "host");
    this.liveness = child.stdio[3] as Duplex;
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.completion = new Promise<ProcessResult>((resolve, reject) => { this.resolveCompletion = resolve; this.rejectCompletion = reject; });
    void this.ready.catch(() => {}); void this.completion.catch(() => {});
    this.stdin = new Writable({ highWaterMark: MXC_STREAM_CHUNK_BYTES,
      write: (chunk: Buffer, _encoding, callback) => {
        const send = async () => {
          if (this.stopping || !this.id || this.result) throw new MxcProcessContractError("Extension input is closed");
          for (let offset = 0; offset < chunk.length; offset += MXC_STREAM_CHUNK_BYTES) {
            await this.channel.send({ type: "stdin", data: chunk.subarray(offset, offset + MXC_STREAM_CHUNK_BYTES).toString("base64") });
          }
        };
        void send().then(() => callback(), (error: Error) => callback(error));
      },
      final: (callback) => {
        if (this.stopping || this.result) return callback();
        void this.channel.send({ type: "stdin-end" }).then(() => callback(), (error: Error) => callback(error));
      },
    });
    const fail = (error: Error): void => this.fail(error);
    for (const stream of [this.stdin, this.stdout, this.stderr, child.stdin, child.stdout, child.stderr, this.liveness]) stream.on("error", fail);
    child.once("error", fail);
    // Raw supervisor diagnostics are bounded and never interpreted as frames.
    let diagnosticBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > MXC_STREAM_CHUNK_BYTES) this.fail(new MxcProcessContractError("Supervisor diagnostics exceed limit"));
    });
    const reading = this.read();
    void reading.catch(fail);
    this.closed = new Promise<void>((resolve) => child.once("close", (code, signal) => {
      this.closedAlready = true;
      this.liveness.destroy();
      void reading.catch(() => {}).then(() => {
        if (!this.failure && code === 0 && !signal && this.result && this.id) this.resolveCompletion(this.result);
        else if (!this.failure && code === 0 && !signal && this.stopped && this.stopping) {
          const error = new MxcProcessContractError("Extension start was cancelled");
          this.rejectReady(error); this.rejectCompletion(error);
        } else this.fail(this.failure ?? new MxcSupervisorLostError("Extension supervisor exited without verified termination"));
        this.stdout.end(); this.stderr.end(); this.stdin.destroy();
        resolve();
      });
    }));
    // The key is never placed in argv, environment, or the container request.
    this.liveness.write(key, (error) => { if (error) fail(error); });
  }

  async start(request: ContainerRequest): Promise<void> { await this.channel.send({ type: "start", request }); }

  private async read(): Promise<void> {
    for await (const frame of this.channel.frames()) {
      if (this.result || this.stopped || this.failureReceipt) throw new MxcProcessContractError("Supervisor sent data after termination");
      if (frame.type === "creating") {
        if (this.creationRequested || this.id) throw new MxcProcessContractError("Duplicate supervisor creation receipt");
        this.creationRequested = true;
        this.observe({ type: "creating" });
        if (this.stopping || this.failure) continue;
        try {
          // The authenticated request arrives after native bootstrap and probing.
          // Recheck admission synchronously; no asynchronous caller work may extend it.
          const result: unknown = this.beforeSpawn?.();
          if (result !== undefined) {
            void Promise.resolve(result).catch(() => {});
            throw new MxcProcessContractError("Extension admission check must be synchronous");
          }
        } catch (cause) {
          this.fail(new MxcProcessContractError("Extension admission revalidation failed", { cause }));
          continue;
        }
        if (this.stopping || this.failure) continue;
        this.creationStarted = true;
        await this.channel.send({ type: "spawn-authorized" });
      } else if (frame.type === "spawning") {
        if (!this.creationRequested || !this.creationStarted || this.spawnInvoked || this.id) throw new MxcProcessContractError("Unexpected supervisor spawning receipt");
        this.spawnInvoked = true;
        this.observe({ type: "spawning" });
      } else if (frame.type === "native-created") {
        if (!this.spawnInvoked || this.nativeId || this.id || this.child.pid === undefined) throw new MxcProcessContractError("Unexpected native process receipt");
        this.nativeId = frame.id;
        this.observe({ type: "native-created", id: frame.id, processHandle: frame.processHandle, supervisorPid: this.child.pid });
        await this.channel.send({ type: "native-observed", id: frame.id });
      } else if (frame.type === "ready") {
        if (!this.spawnInvoked) throw new MxcProcessContractError("Supervisor readiness preceded native invocation");
        if (frame.id !== this.nativeId) throw new MxcProcessContractError("Supervisor readiness lacks its native process receipt");
        if (this.id) throw new MxcProcessContractError("Duplicate supervisor readiness");
        this.id = frame.id;
        this.diagnostics = { nodeVersion: frame.nodeVersion, nativeModules: frame.nativeModules, nativeModuleCount: frame.nativeModuleCount, nativeModulesTruncated: frame.nativeModulesTruncated, ownerHandle: frame.ownerHandle };
        this.resolveReady();
      } else if (frame.type === "stdout" || frame.type === "stderr") {
        if (!this.id) throw new MxcProcessContractError("Supervisor output preceded readiness");
        await new Promise<void>((resolve, reject) => this[frame.type].write(Buffer.from(frame.data, "base64"),
          (error) => error ? reject(error) : resolve()));
      } else if (frame.type === "exit") {
        if (!this.id) throw new MxcProcessContractError("Supervisor exit preceded readiness");
        this.result = { exitCode: frame.exitCode, timedOut: frame.timedOut };
      } else if (frame.type === "stopped") {
        if (!this.stopping || this.id) throw new MxcProcessContractError("Unexpected supervisor stop receipt");
        this.stopped = true;
        this.observe({ type: "stopped", spawnPendingAtCancellation: frame.spawnPendingAtCancellation });
      } else if (frame.type === "error") {
        this.failureReceipt = true;
        if (frame.code === "cleanup-unverified") throw new MxcProcessCleanupError(frame.message);
        if (frame.code === "integrity") throw new MxcIntegrityError(frame.message);
        if (frame.code === "capability-unavailable") throw new MxcCapabilityUnavailableError(frame.message);
        if (frame.code === "supervisor-lost") throw new MxcSupervisorLostError(frame.message);
        throw new MxcProcessContractError(frame.message);
      } else throw new MxcProcessContractError("Unexpected supervisor event frame");
    }
  }

  get observerFailure(): Error | undefined { return this.lifecycleFailure; }

  private observe(event: MxcProcessLifecycleEvent): void {
    try { notifyLifecycle(this.onLifecycle, event); } catch (error) {
      this.lifecycleFailure ??= error as Error;
      this.fail(this.lifecycleFailure);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error instanceof MxcProcessContractError || error instanceof MxcProcessCleanupError || error instanceof MxcSupervisorLostError
      || error instanceof MxcIntegrityError || error instanceof MxcCapabilityUnavailableError
      ? error : new MxcSupervisorLostError("Extension supervisor channel failed", { cause: error });
    this.rejectReady(this.failure); this.rejectCompletion(this.failure);
    void this.dispose().catch(() => {});
  }

  dispose(): Promise<void> {
    this.cleanup ??= this.stop();
    return this.cleanup;
  }

  private async stop(): Promise<void> {
    this.stopping = true;
    // Readiness follows native-observed. EOF can then interrupt a control
    // reader blocked on native stdin without releasing an unobserved pin.
    if (this.id && !this.liveness.destroyed && !this.liveness.writableEnded) this.liveness.end();
    this.stdout.resume(); this.stderr.resume(); this.stdin.destroy();
    // Startup cancellation must retain owner liveness until native-observed;
    // EOF would let the supervisor close the process pin before duplication.
    // A failed stop send instead requests EOF teardown, without racing it with
    // an immediate supervisor kill.
    if (!this.closedAlready && !this.result && !this.stopped) {
      void this.channel.send({ type: "stop" }).catch(() => {
        if (!this.liveness.destroyed && !this.liveness.writableEnded) this.liveness.end();
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.liveness.destroy(); this.child.kill();
            reject(this.failure instanceof MxcProcessCleanupError || (this.creationStarted && !this.result && !this.stopped && !this.failureReceipt)
              ? new MxcProcessCleanupError("Extension supervisor cleanup deadline exceeded")
              : new MxcSupervisorLostError("Extension supervisor shutdown deadline exceeded"));
          }, TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
        }),
      ]);
      if (this.failure instanceof MxcProcessCleanupError) throw this.failure;
      if (this.creationStarted && !this.result && !this.stopped && !this.failureReceipt) {
        throw new MxcProcessCleanupError("Extension termination is unverified", { cause: this.failure });
      }
    } finally { clearTimeout(timer); }
  }
}

async function spawnWith(request: ContainerRequest, nodeModules: string, entry: string,
  spawn: (entry: string, nodeModules: string, generation: string) => ChildProcess, signal?: AbortSignal, onLifecycle?: LifecycleObserver, beforeSpawn?: () => void, onOwned?: (owned: OwnedMxcExtensionProcess) => void): Promise<OwnedMxcExtensionProcess> {
  assertMxcExtensionRequest(request);
  if (signal?.aborted) throw new MxcProcessContractError("Extension start was cancelled");
  const generation = randomBytes(32).toString("hex"), key = randomBytes(32);
  const child = spawn(entry, nodeModules, generation);
  const owned = new SupervisedMxcProcess(child, generation, key, onLifecycle, beforeSpawn);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let startupAbort: (() => void) | undefined;
  const abort = (): void => { void owned.dispose().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  void owned.completion.finally(() => signal?.removeEventListener("abort", abort)).catch(() => {});
  try {
    onOwned?.(owned);
    if (child.pid !== undefined) notifyLifecycle(onLifecycle, { type: "supervisor-started", pid: child.pid });
    if (signal?.aborted) throw new MxcProcessContractError("Extension start was cancelled");
    await Promise.race([
      owned.start(request).then(() => owned.ready),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MxcSupervisorLostError("Extension supervisor startup deadline exceeded")), TOOL_TIMEOUT_POLICY.windowsAclHostStartupMs);
        if (signal) {
          startupAbort = () => reject(new MxcProcessContractError("Extension start was cancelled"));
          signal.addEventListener("abort", startupAbort, { once: true });
          if (signal.aborted) startupAbort();
        }
      }),
    ]);
    if (signal?.aborted) throw new MxcProcessContractError("Extension start was cancelled");
    return owned;
  } catch (error) {
    signal?.removeEventListener("abort", abort);
    try { await owned.dispose(); } catch (cleanupError) {
      if (cleanupError instanceof MxcProcessCleanupError) {
        throw new MxcProcessCleanupError("Extension startup cleanup is unverified", { cause: new AggregateError([error, cleanupError]) });
      }
      throw owned.observerFailure ?? error;
    }
    throw owned.observerFailure ?? error;
  } finally {
    clearTimeout(timer);
    if (startupAbort) signal?.removeEventListener("abort", startupAbort);
  }
}

/** The caller supplies an already-admitted immutable plan. beforeSpawn synchronously
 * revalidates its identities after native readiness; onOwned retains cleanup ownership
 * before startup begins, including when startup rejects with unverified cleanup.
 */

export async function spawnMxcExtensionProcess(request: ContainerRequest, options: { signal?: AbortSignal; onLifecycle?: LifecycleObserver; beforeSpawn?: () => void; onOwned?: (owned: OwnedMxcExtensionProcess) => void } = {}): Promise<OwnedMxcExtensionProcess> {
  if (process.platform !== "win32") throw new MxcCapabilityUnavailableError("Native extension processes require Windows");
  const resources = getHostResources();
  if (!resources.isPackaged) throw new MxcCapabilityUnavailableError("Native extension processes require a verified packaged installation");
  const nodeModules = join(resources.resourcePath, "app.asar.unpacked", "node_modules");
  const entry = join(resources.resourcePath, "app.asar", "dist", "src", "main", "mxc-extension-supervisor.js");
  // The supervisor needs only the runtime mode; the admitted container environment
  // is a separate sealed request and never inherits the supervisor's environment.
  return spawnWith(request, nodeModules, entry, (file, modules, generation) => spawnManaged(process.execPath, [file, modules, generation], {
    env: buildSafeChildEnv({ ELECTRON_RUN_AS_NODE: "1" }), cwd: resources.resourcePath, stdio: ["pipe", "pipe", "pipe", "pipe"],
  }, { label: "extension-native-supervisor" }), options.signal, options.onLifecycle, options.beforeSpawn, options.onOwned);
}

export const _spawnMxcExtensionProcessForTest = spawnWith;
