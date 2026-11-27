import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { MxcIntegrityError } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MxcExtensionChannel, type MxcFramePayload } from "./mxc-extension-channel.js";
import { MxcProcessContractError, MxcSupervisorLostError } from "./mxc-extension-errors.js";
import { CONTAINER_SHELL_CWD_GRANT, containerShellWorkingDirectoryPrelude } from "../tools/host-shell-cwd-guard.js";
import { mapSeatbeltShellRequest, SEATBELT_ENV_NAME, type buildSeatbeltShellRequest } from "./mxc-macos.js";
import { MxcNativeProcess, seatbeltCleanupUnverified } from "./mxc-native-process.js";
import { bootstrapMxcShellSupervisor, MXC_SHELL_ASYNC_STACK_BYTES, type MxcShellRuntime, type MxcShellSdk } from "./mxc-shell-supervisor-bootstrap.js";
import { readMxcSupervisorKey } from "./mxc-supervisor-transport.js";
import { matchesShellWorkingDirectoryIdentity, type ShellWorkingDirectoryIdentity } from "./shell-working-directory-identity.js";

type ShellStart = Extract<MxcFramePayload, { type: "shell-start" }>;
type ShellReceipt = Extract<MxcFramePayload, { type: "exit" | "stopped" | "error" }>;
type SeatbeltRequest = ReturnType<typeof buildSeatbeltShellRequest>["request"];
const CLEANUP_UNVERIFIED = { type: "error", code: "cleanup-unverified", message: "Native shell cleanup is unverified" } as const;
const CWD_CHANGED = { type: "error", code: "cwd-changed", message: "Native shell working directory changed before the run" } as const;
const ENDED_BEFORE_CHECK = { type: "error", code: "start-refused", message: "Native shell ended before its working directory check" } as const;

async function loadRequest(frame: ShellStart) {
  const bytes = await readFile(frame.requestPath);
  if (createHash("sha256").update(bytes).digest("hex") !== frame.requestSha256) {
    throw new MxcIntegrityError("Staged shell request hash mismatch");
  }
  const wire: SeatbeltRequest = JSON.parse(bytes.toString("utf8"));
  if (wire.version !== "1.0.0" || wire.containment !== "seatbelt" || typeof wire.seatbelt?.profileOverride !== "string"
    || !wire.seatbelt.profileOverride || typeof wire.process?.cwd !== "string" || !wire.process.cwd
    || wire.process.inheritDefaultEnv !== false || !Array.isArray(wire.process.env)
    // Every name is a plain identifier, so /bin/sh imports no function over the cwd prelude's builtins.
    || wire.process.env.some((entry) => typeof entry !== "string" || !SEATBELT_ENV_NAME.test(entry.slice(0, Math.max(entry.indexOf("="), 0))))) {
    throw new MxcProcessContractError("Invalid staged shell request");
  }
  const cwdIdentity: ShellWorkingDirectoryIdentity = {
    realpath: frame.cwdIdentity.realpath, dev: BigInt(frame.cwdIdentity.dev), ino: BigInt(frame.cwdIdentity.ino),
  };
  if (wire.process.cwd !== cwdIdentity.realpath) throw new MxcProcessContractError("Staged shell cwd is not its identity's path");
  const request = mapSeatbeltShellRequest(wire);
  // The workload checks its inherited cwd before the staged command, under the SDK's /bin/sh.
  return { request: { ...request, command: containerShellWorkingDirectoryPrelude(cwdIdentity) + request.command }, cwdIdentity };
}

/**
 * The workload's first stdout byte is its cwd verdict: R for the staged directory, C for another. A workload that
 * ends before it never ran the check, such as a shell lost before exec. Any other byte breaks the contract; a further
 * byte before the grant cannot come from the prelude, which waits.
 */
async function readCwdVerdict(stdout: AsyncIterator<Buffer>): Promise<"R" | "C" | "ended"> {
  const first = await stdout.next();
  if (first.done === true) return "ended";
  if (first.value.length !== 1) throw new MxcProcessContractError("Invalid native shell cwd verdict");
  const verdict = first.value.toString("latin1");
  if (verdict !== "R" && verdict !== "C") throw new MxcProcessContractError("Invalid native shell cwd verdict");
  return verdict;
}

async function forward(source: AsyncIterable<Buffer>, destination: Writable): Promise<void> {
  for await (const chunk of source) {
    await new Promise<void>((resolve, reject) => destination.write(chunk, (error) => error ? reject(error) : resolve()));
  }
}

export async function serveMxcShellSupervisor(
  channel: MxcExtensionChannel, liveness: Readable, stdout: Writable, stderr: Writable,
  bootstrap: () => Promise<MxcShellRuntime>, onFatal: () => void,
): Promise<void> {
  let owned: MxcNativeProcess | undefined;
  let starting = false;
  let spawnPending = false;
  let stopping = false;
  let spawnPendingAtCancellation = false;
  let ownerLost = false;
  let contractFailed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let awaitingGrant: (() => void) | undefined;
  let stopRequested!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stopRequested = resolve; });
  let resolveTerminal!: (receipt: ShellReceipt) => void;
  const terminal = new Promise<ShellReceipt>((resolve) => { resolveTerminal = resolve; });
  const stopped = (): ShellReceipt => contractFailed
    ? { type: "error", code: "contract", message: "Invalid native shell supervisor transport" }
    : { type: "stopped", spawnPendingAtCancellation };

  const stop = (): void => {
    if (!stopping) {
      stopping = true;
      stopRequested();
      spawnPendingAtCancellation = spawnPending;
      watchdog = setTimeout(onFatal, TOOL_TIMEOUT_POLICY.mxcMacShellStopMs);
    }
    if (owned) void owned.dispose({ drainOutput: false }).catch(() => resolveTerminal(CLEANUP_UNVERIFIED));
    else if (!starting) resolveTerminal(stopped());
  };
  const handleOwnerLoss = (): void => {
    ownerLost = true;
    stop();
  };
  const handleFailure = (): void => {
    contractFailed = true;
    stop();
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, stop);
  liveness.once("end", handleOwnerLoss);
  liveness.once("close", handleOwnerLoss);
  liveness.once("error", handleOwnerLoss);
  liveness.on("data", handleFailure);
  stdout.on("error", handleFailure);
  stderr.on("error", handleFailure);
  liveness.resume();
  if (liveness.readableEnded || liveness.destroyed) handleOwnerLoss();

  const runtime = Promise.resolve().then(bootstrap);
  void runtime.catch((error: unknown) => resolveTerminal({
    type: "error", code: error instanceof MxcIntegrityError ? "integrity" : "capability-unavailable",
    message: "Native shell SDK bootstrap failed",
  }));

  async function start(frame: ShellStart): Promise<ShellReceipt> {
    // A bootstrap failure is settled by the shared runtime observer.
    const { sdk, assertLibraryInPlace } = await runtime;
    if (stopping) return stopped();
    let request: Awaited<ReturnType<typeof loadRequest>>["request"];
    let cwdIdentity: ShellWorkingDirectoryIdentity;
    try {
      ({ request, cwdIdentity } = await loadRequest(frame));
    } catch (error) {
      return stopping ? stopped() : {
        type: "error", code: "start-refused", message: "Invalid staged shell request",
        ...(error instanceof MxcIntegrityError ? {} : { sdkCode: "malformed_request" }),
      };
    }
    if (stopping) return stopped();
    // The staged directory, restated just before the library check and the spawn. The workload compares it again,
    // after this, against the directory it inherited.
    if (!matchesShellWorkingDirectoryIdentity(cwdIdentity.realpath, cwdIdentity)) return CWD_CHANGED;
    let native: Awaited<ReturnType<MxcShellSdk["spawn"]>>;
    try {
      // A standby may have waited since its bootstrap: the SDK loads the library by path at first use, so the
      // verified bytes are re-checked here, synchronously, with nothing between this check and the spawn call.
      assertLibraryInPlace();
    } catch {
      return { type: "error", code: "integrity", message: "Native shell library changed after verification" };
    }
    try {
      spawnPending = true;
      native = await sdk.spawn(request);
    } catch (error) {
      return stopping ? stopped() : {
        type: "error", code: "start-refused", message: "Native shell start refused",
        ...(error instanceof sdk.MxcError ? { sdkCode: error.code } : {}),
      };
    } finally {
      spawnPending = false;
    }
    try {
      owned = new MxcNativeProcess(native, TOOL_TIMEOUT_POLICY.mxcMacShellStopMs);
    } catch {
      return CLEANUP_UNVERIFIED;
    }
    const workload = owned;
    const output = workload.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    const errors = forward(workload.stderr, stderr);
    void errors.catch(handleFailure);
    workload.stdin.on("error", handleFailure);
    // Nothing is forwarded before the verdict, so no output can precede or forge it.
    const verdict = await readCwdVerdict(output).catch(() => undefined);
    let granted = false;
    if (verdict === "R" && !stopping) {
      const grant = new Promise<void>((resolve) => { awaitingGrant = resolve; });
      try { await channel.send({ type: "shell-cwd-verified", id: workload.id }); } catch { handleFailure(); }
      await Promise.race([grant, stopSignal, terminal]);
      awaitingGrant = undefined;
      granted = !stopping;
    }
    if (granted) {
      workload.stdin.end(CONTAINER_SHELL_CWD_GRANT);
    } else {
      // No grant: the prelude reads end of file and exits before user code.
      workload.stdin.end();
      if (verdict === undefined && !stopping) handleFailure();
    }
    const streams = Promise.all([forward({ [Symbol.asyncIterator]: () => output }, stdout), errors]);
    void streams.catch(handleFailure);
    if (stopping) stop();
    else if (granted) {
      try { await channel.send({ type: "shell-ready", id: workload.id }); } catch { handleFailure(); }
    }
    try {
      const result = await owned.completion;
      await owned.dispose({ drainOutput: false });
      await streams;
      if (owned.state !== "terminated" || seatbeltCleanupUnverified(owned.warnings)) {
        return CLEANUP_UNVERIFIED;
      }
      // A refusal is read from the verdict byte, never from the workload's exit status.
      if (!granted && verdict === "C" && !stopping) return CWD_CHANGED;
      if (!granted && verdict === "ended" && !stopping) return ENDED_BEFORE_CHECK;
      return stopping ? stopped() : { type: "exit", exitCode: result.exitCode, timedOut: result.timedOut };
    } catch (error) {
      await owned.dispose({ drainOutput: false }).catch(() => {});
      if (error instanceof MxcSupervisorLostError) {
        return { type: "error", code: "supervisor-lost", message: "Native shell completion is unverified" };
      }
      return CLEANUP_UNVERIFIED;
    }
  }
  const controls = (async () => {
    for await (const frame of channel.frames()) {
      if (frame.type === "stop") stop();
      else if (frame.type === "spawn-authorized" && awaitingGrant !== undefined) {
        const resolve = awaitingGrant;
        awaitingGrant = undefined;
        resolve();
      } else if (frame.type === "shell-start" && !starting && !stopping) {
        starting = true;
        void start(frame).then(resolveTerminal, async () => {
          handleFailure();
          if (owned) await owned.dispose({ drainOutput: false }).catch(() => {});
          resolveTerminal(owned ? CLEANUP_UNVERIFIED : stopped());
        });
      } else {
        handleFailure();
      }
    }
    handleOwnerLoss();
  })();
  void controls.catch(handleFailure);
  try {
    const receipt = await terminal;
    if (!ownerLost) {
      await channel.send(receipt).catch(() => {});
      await channel.end().catch(() => {});
    }
  } finally {
    clearTimeout(watchdog);
    for (const signal of signals) process.off(signal, stop);
    liveness.off("end", handleOwnerLoss);
    liveness.off("close", handleOwnerLoss);
    liveness.off("error", handleOwnerLoss);
    liveness.off("data", handleFailure);
    stdout.off("error", handleFailure);
    stderr.off("error", handleFailure);
  }
}

/** The supervisor process body: fd 3 carries the owner key and liveness, fd 4 the authenticated control channel. */
export async function runMxcShellSupervisorProcess(
  argv: readonly string[], asyncStackBytes: number | null = MXC_SHELL_ASYNC_STACK_BYTES,
): Promise<void> {
  const [nodeModules, generation, mode] = argv;
  if (!nodeModules || !generation || (mode !== "packaged" && mode !== "development")) {
    throw new MxcProcessContractError("Missing shell supervisor configuration");
  }
  const liveness = new Socket({ fd: 3, readable: true, writable: false });
  const control = new Socket({ fd: 4, readable: true, writable: true, allowHalfOpen: true });
  const key = await readMxcSupervisorKey(liveness);
  const channel = new MxcExtensionChannel(control, control, generation, key, "supervisor");
  await serveMxcShellSupervisor(channel, liveness, process.stdout, process.stderr,
    () => bootstrapMxcShellSupervisor(nodeModules, mode === "packaged", asyncStackBytes), () => process.exit(1));
}
