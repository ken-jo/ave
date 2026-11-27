import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { getHostResources, type HostResources } from "../main/host-resources.js";
import { assertManagedChildProcessAdmissionOpen, trackManagedChildProcess } from "../main/managed-child-processes.js";
import { raceWithTimeout } from "../shared/abortable-deadline.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { MxcExtensionChannel, type MxcFramePayload } from "./mxc-extension-channel.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { isMxcSupervisorLoaderOverride } from "./mxc-supervisor-transport.js";
import { onSandboxStatusChanged } from "./sandbox-capability.js";
import {
  captureShellWorkingDirectoryIdentity, matchesShellWorkingDirectoryIdentity, sameShellWorkingDirectoryIdentity,
  type ShellWorkingDirectoryIdentity,
} from "./shell-working-directory-identity.js";

type ShellStart = Extract<MxcFramePayload, { type: "shell-start" }>;
type ShellReceipt = Extract<MxcFramePayload, { type: "exit" | "stopped" | "error" }>;

export function mxcShellSupervisorLocation(resources: HostResources = getHostResources()) {
  const app = resources.isPackaged ? join(resources.resourcePath, "app.asar") : dirname(resources.resourcePath);
  return {
    entry: join(app, "dist", "src", "main", "mxc-shell-supervisor.js"),
    nodeModules: join(resources.isPackaged ? `${app}.unpacked` : app, "node_modules"),
    isPackaged: resources.isPackaged,
  };
}

/**
 * Stage the request beside the identity of its working directory: the realpath and its dev and inode. The supervisor
 * restats that identity before the SDK call and the workload compares it with the cwd it inherited before user code.
 * `expected` is an identity already bound earlier, such as the approved directory; the staged one must equal it.
 */
export async function stageMxcShellRequest(
  requestPath: string, request: { readonly process: { readonly cwd: string } }, expected?: ShellWorkingDirectoryIdentity,
): Promise<ShellStart> {
  const identity = captureShellWorkingDirectoryIdentity(request.process.cwd);
  if (identity === undefined || identity.realpath !== request.process.cwd
    || (expected !== undefined && !sameShellWorkingDirectoryIdentity(identity, expected))) {
    throw new MxcCwdChangedError();
  }
  return {
    type: "shell-start", ...await writeMxcShellRequest(requestPath, request),
    cwdIdentity: { realpath: identity.realpath, dev: String(identity.dev), ino: String(identity.ino) },
  };
}

/** Write the request bytes once, private and new, and name their digest. The Linux route stages with this alone. */
export async function writeMxcShellRequest(requestPath: string, request: object): Promise<{ requestPath: string; requestSha256: string }> {
  const bytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, bytes, { flag: "wx", mode: 0o600 });
  return { requestPath, requestSha256: createHash("sha256").update(bytes).digest("hex") };
}

/** The container shell's working directory is not, or is no longer, the directory its request was staged for. */
export class MxcCwdChangedError extends Error {
  constructor() {
    super("Container shell working directory changed before the run");
    this.name = "MxcCwdChangedError";
  }
}

function stagedCwdIdentity(request: ShellStart): ShellWorkingDirectoryIdentity {
  return { realpath: request.cwdIdentity.realpath, dev: BigInt(request.cwdIdentity.dev), ino: BigInt(request.cwdIdentity.ino) };
}

/**
 * The host's final check before user code runs: it may grant only by calling `grant` synchronously, with nothing
 * awaited between its last check and that call, and returns whether it granted. The client has already compared the
 * staged cwd identity when this runs.
 */
export type MxcShellRunAuthorizer = (grant: () => boolean) => Promise<boolean>;

const AUTHORIZE_CWD_ONLY: MxcShellRunAuthorizer = (grant) => Promise.resolve(grant());

const STOP_MS = TOOL_TIMEOUT_POLICY.mxcMacShellStopMs;
const LOST = {
  code: null, timedOut: false, cancelled: false, rejected: false, cleanupUnverified: true,
} as const;

// The supervisor ended with no receipt before it reported the run started. Whether the SDK had started anything is
// not known, so cleanup stays unverified, but the command is reported as a failed start, not as a stopped run.
const START_LOST = { ...LOST, startFailed: true } as const;

interface ShellOutcome {
  /** The supervisor or the workload found the working directory changed before user code ran: nothing ran. */
  readonly cwdChanged?: true;
  /** The host's final check before user code refused its grant, and the stop that followed is confirmed: nothing ran. */
  readonly grantWithheld?: true;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly rejected: boolean;
  readonly cleanupUnverified: boolean;
  /** No receipt and no ready frame: the container start failed before the run. */
  readonly startFailed?: true;
  /** The run was stopped because its control channel failed; the stop itself was confirmed. */
  readonly transportFailed?: true;
  readonly failure?: Extract<ShellReceipt, { type: "error" }>;
}

function shellOutcome(receipt: ShellReceipt, ready: boolean): ShellOutcome {
  if (receipt.type === "error" && receipt.code === "cwd-changed" && !ready) {
    return { ...LOST, cleanupUnverified: false, rejected: true, cwdChanged: true, failure: receipt };
  }
  if (receipt.type === "error") {
    if (receipt.code === "cleanup-unverified" || receipt.code === "supervisor-lost") return LOST;
    // After the run began, a contract receipt follows a confirmed stop: the channel failed, the container did not refuse.
    if (ready && receipt.code === "contract") return { ...LOST, cleanupUnverified: false, transportFailed: true, failure: receipt };
    if (ready) return LOST;
    return { ...LOST, cleanupUnverified: false, rejected: true, failure: receipt };
  }
  if (receipt.type === "stopped") return { ...LOST, cancelled: true, cleanupUnverified: false };
  if (!ready) return LOST;
  return { ...LOST, code: receipt.exitCode, timedOut: receipt.timedOut, cleanupUnverified: false };
}

function lostOutcome(ready: boolean): ShellOutcome {
  return ready ? LOST : START_LOST;
}

// A run the host refused to grant was stopped before user code: once that stop is confirmed, nothing ran.
function withheldOutcome(outcome: ShellOutcome, withheld: boolean): ShellOutcome {
  return withheld && outcome.cancelled ? { ...outcome, cancelled: false, rejected: true, grantWithheld: true } : outcome;
}

export { lostOutcome as _lostShellOutcomeForTest, shellOutcome as _shellOutcomeForTest };

type ShellSupervisorLocation = ReturnType<typeof mxcShellSupervisorLocation>;

/** A spawned, authenticated supervisor that has not been handed a request. It holds no authority. */
interface ShellSupervisorProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly owner: Writable;
  readonly control: Duplex;
  readonly channel: MxcExtensionChannel;
  readonly exited: Promise<void>;
  /** What the quit sweep does instead of a kill. Idle: close fds 3 and 4, so the supervisor stops and exits. */
  cooperativeStop: () => void;
  /** Transport failure on the owner pipe or the raw streams. Idle: the same close. */
  transportFailed: () => void;
  failed: boolean;
}

const STANDBY_LABEL = "mxc-shell-standby";

function spawnShellSupervisor(location: ShellSupervisorLocation, label: string): ShellSupervisorProcess {
  assertManagedChildProcessAdmissionOpen(label);
  const key = randomBytes(32);
  const generation = randomBytes(32).toString("hex");
  const env = Object.fromEntries(Object.entries(buildSafeChildEnv()).filter(([name]) => !isMxcSupervisorLoaderOverride(name)));
  const child = spawn(process.execPath, [location.entry, location.nodeModules, generation,
    location.isPackaged ? "packaged" : "development"], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<null, Readable, Readable>;
  const owner = child.stdio[3] as Writable;
  const control = child.stdio[4] as Duplex;
  const close = (): void => {
    owner.destroy();
    control.destroy();
  };
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.on("error", () => {
      if (child.pid === undefined) resolve();
    });
  });
  const supervisor: ShellSupervisorProcess = {
    child, owner, control, exited,
    channel: new MxcExtensionChannel(control, control, generation, key, "host"),
    cooperativeStop: close,
    transportFailed: close,
    failed: false,
  };
  const failed = (): void => {
    supervisor.failed = true;
    supervisor.transportFailed();
  };
  owner.on("error", failed);
  child.stdout.on("error", failed);
  child.stderr.on("error", failed);
  trackManagedChildProcess(child, { label, cooperativeStop: () => supervisor.cooperativeStop() });
  owner.write(key, (error) => { if (error) failed(); });
  return supervisor;
}

// One warm standby per supervisor bundle: spawned, authenticated and verifying its SDK, with no request and no authority.
const standbys = new Map<string, ShellSupervisorProcess>();
let observingSandboxStatus = false;

function standbyKey(location: ShellSupervisorLocation): string {
  return JSON.stringify([location.entry, location.nodeModules, location.isPackaged]);
}

function isLive(supervisor: ShellSupervisorProcess): boolean {
  return !supervisor.failed && supervisor.child.exitCode === null && supervisor.child.signalCode === null;
}

/** Stop and forget every standby: on a sandbox status change, and from test teardown. */
export function dropMxcShellStandbys(): void {
  const idle = [...standbys.values()];
  standbys.clear();
  for (const supervisor of idle) supervisor.cooperativeStop();
}

/** The pid of the live standby for a bundle, if any. @internal — tests only. */
export function _mxcShellStandbyPidForTest(location: ShellSupervisorLocation): number | undefined {
  const supervisor = standbys.get(standbyKey(location));
  return supervisor !== undefined && isLive(supervisor) ? supervisor.child.pid : undefined;
}

function refillStandby(location: ShellSupervisorLocation): void {
  const key = standbyKey(location);
  if (standbys.has(key)) return;
  let supervisor: ShellSupervisorProcess;
  try {
    supervisor = spawnShellSupervisor(location, STANDBY_LABEL);
  } catch {
    // Admission is sealed for shutdown, or the spawn failed: the next command starts a supervisor of its own.
    return;
  }
  if (!observingSandboxStatus) {
    observingSandboxStatus = true;
    onSandboxStatusChanged(dropMxcShellStandbys);
  }
  standbys.set(key, supervisor);
  void supervisor.exited.then(() => {
    if (standbys.get(key) === supervisor) standbys.delete(key);
  });
}

function takeShellSupervisor(location: ShellSupervisorLocation, label: string): ShellSupervisorProcess {
  assertManagedChildProcessAdmissionOpen(label);
  const key = standbyKey(location);
  const warm = standbys.get(key);
  standbys.delete(key);
  let supervisor: ShellSupervisorProcess;
  if (warm !== undefined && isLive(warm)) {
    supervisor = warm;
  } else {
    warm?.cooperativeStop();
    supervisor = spawnShellSupervisor(location, label);
  }
  setImmediate(() => refillStandby(location));
  return supervisor;
}

export function startMxcShellSupervisor(
  request: ShellStart, timeoutMs: number, signal: AbortSignal | undefined, revoke: () => void,
  label: string, location = mxcShellSupervisorLocation(), authorize: MxcShellRunAuthorizer = AUTHORIZE_CWD_ONLY,
) {
  const cwdIdentity = stagedCwdIdentity(request);
  signal?.throwIfAborted();
  const supervisor = takeShellSupervisor(location, label);
  const { child, owner, control, channel, exited } = supervisor;
  let ready = false;
  let verified = false;
  let grantWithheld = false;
  let receipt: ShellReceipt | undefined;
  let stopping: Promise<void> | undefined;
  let stopDeadline: ReturnType<typeof setTimeout> | undefined;
  let quitting = false;
  let settled = false;
  let settleLost!: () => void;
  const lost = new Promise<void>((resolve) => { settleLost = resolve; });
  const closeControl = (): void => {
    owner.destroy();
    control.destroy();
  };
  const stop = (): Promise<void> => {
    if (stopping === undefined) {
      stopDeadline = setTimeout(settleLost, STOP_MS);
      stopping = channel.send({ type: "stop" }).catch(closeControl);
    }
    return stopping;
  };
  const handleFailure = (): void => {
    if (settled) return;
    revoke();
    void stop();
  };
  const handleAbort = (): void => { void stop(); };
  supervisor.transportFailed = handleFailure;
  supervisor.cooperativeStop = () => {
    quitting = true;
    handleFailure();
    closeControl();
  };
  // The workload reported its inherited cwd matched. Grant only while that directory is still the staged one and the
  // caller's own final check passes; otherwise stop it before user code runs.
  const grantRun = (): void => {
    const grant = (): boolean => {
      if (settled || stopping !== undefined || !matchesShellWorkingDirectoryIdentity(cwdIdentity.realpath, cwdIdentity)) return false;
      void channel.send({ type: "spawn-authorized" }).catch(handleFailure);
      return true;
    };
    void authorize(grant).then((granted) => granted, () => false).then((granted) => {
      // A run already stopping (cancelled, failed or quit) keeps that ending.
      if (granted || stopping !== undefined || settled) return;
      grantWithheld = true;
      void stop();
    });
  };
  const readReceipts = (async () => {
    for await (const frame of channel.frames()) {
      if (receipt !== undefined) throw new MxcProcessContractError("Frame after shell terminal receipt");
      if (frame.type === "shell-cwd-verified" && !verified && !ready) {
        verified = true;
        grantRun();
      } else if (frame.type === "shell-ready" && verified && !ready) ready = true;
      else if (frame.type === "exit" || frame.type === "stopped" || frame.type === "error") receipt = frame;
      else throw new MxcProcessContractError("Unexpected shell supervisor frame");
    }
    if (receipt === undefined && child.exitCode === null && child.signalCode === null) handleFailure();
  })().catch(() => { receipt = undefined; handleFailure(); });

  signal?.addEventListener("abort", handleAbort, { once: true });
  const watchdog = setTimeout(handleFailure, timeoutMs + STOP_MS);
  const completion = (async (): Promise<ShellOutcome> => {
    const result = await Promise.race([
      Promise.all([exited, readReceipts]).then(() => receipt === undefined ? lostOutcome(ready) : shellOutcome(receipt, ready)),
      lost.then(() => lostOutcome(ready)),
    ]).then((outcome) => withheldOutcome(outcome, grantWithheld && !ready));
    settled = true;
    clearTimeout(watchdog);
    clearTimeout(stopDeadline);
    signal?.removeEventListener("abort", handleAbort);
    revoke();
    // Only the supervisor child belongs to this host. Its workload has a separate owner.
    if (result.cleanupUnverified && !quitting && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    closeControl();
    const drained = Promise.all([child.stdout, child.stderr].map(
      (stream) => finished(stream, { writable: false, cleanup: true }),
    ));
    await raceWithTimeout(drained, TOOL_TIMEOUT_POLICY.mxcMacShellOutputDrainMs,
      () => new MxcProcessContractError("Shell output drain deadline exceeded")).catch(() => {
      child.stdout.destroy();
      child.stderr.destroy();
    });
    return result;
  })();
  if (supervisor.failed) handleFailure();
  void channel.send(request).catch(handleFailure);
  return { child, completion };
}
