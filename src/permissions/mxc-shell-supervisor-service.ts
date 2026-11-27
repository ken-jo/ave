import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { MxcIntegrityError } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import type { MxcExtensionChannel, MxcFramePayload } from "./mxc-extension-channel.js";
import { MxcProcessContractError, MxcSupervisorLostError } from "./mxc-extension-errors.js";
import { mapSeatbeltShellRequest, type buildSeatbeltShellRequest } from "./mxc-macos.js";
import { MxcNativeProcess } from "./mxc-native-process.js";
import type { MxcShellSdk } from "./mxc-shell-supervisor-bootstrap.js";

export const SEATBELT_CLEANUP_WARNING = "Seatbelt: the process exited, but processes it started could not be terminated";

type ShellStart = Extract<MxcFramePayload, { type: "shell-start" }>;
type ShellReceipt = Extract<MxcFramePayload, { type: "exit" | "stopped" | "error" }>;
type SeatbeltRequest = ReturnType<typeof buildSeatbeltShellRequest>["request"];
const CLEANUP_UNVERIFIED = { type: "error", code: "cleanup-unverified", message: "Native shell cleanup is unverified" } as const;

async function loadRequest(frame: ShellStart) {
  const bytes = await readFile(frame.requestPath);
  if (createHash("sha256").update(bytes).digest("hex") !== frame.requestSha256) {
    throw new MxcIntegrityError("Staged shell request hash mismatch");
  }
  const wire: SeatbeltRequest = JSON.parse(bytes.toString("utf8"));
  if (wire.version !== "1.0.0" || wire.containment !== "seatbelt" || typeof wire.seatbelt?.profileOverride !== "string"
    || !wire.seatbelt.profileOverride || typeof wire.process?.cwd !== "string" || !wire.process.cwd
    || wire.process.inheritDefaultEnv !== false || !Array.isArray(wire.process.env)) {
    throw new MxcProcessContractError("Invalid staged shell request");
  }
  return mapSeatbeltShellRequest(wire);
}

async function forward(source: Readable, destination: Writable): Promise<void> {
  for await (const chunk of source) {
    await new Promise<void>((resolve, reject) => destination.write(chunk, (error) => error ? reject(error) : resolve()));
  }
}

export async function serveMxcShellSupervisor(
  channel: MxcExtensionChannel, liveness: Readable, stdout: Writable, stderr: Writable,
  bootstrap: () => Promise<MxcShellSdk>, onFatal: () => void,
): Promise<void> {
  let owned: MxcNativeProcess | undefined;
  let starting = false;
  let spawnPending = false;
  let stopping = false;
  let spawnPendingAtCancellation = false;
  let ownerLost = false;
  let contractFailed = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let resolveTerminal!: (receipt: ShellReceipt) => void;
  const terminal = new Promise<ShellReceipt>((resolve) => { resolveTerminal = resolve; });
  const stopped = (): ShellReceipt => contractFailed
    ? { type: "error", code: "contract", message: "Invalid native shell supervisor transport" }
    : { type: "stopped", spawnPendingAtCancellation };

  const stop = (): void => {
    if (!stopping) {
      stopping = true;
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
    const sdk = await runtime;
    if (stopping) return stopped();
    let request: Awaited<ReturnType<typeof loadRequest>>;
    try {
      request = await loadRequest(frame);
    } catch (error) {
      return stopping ? stopped() : {
        type: "error", code: "start-refused", message: "Invalid staged shell request",
        ...(error instanceof MxcIntegrityError ? {} : { sdkCode: "malformed_request" }),
      };
    }
    if (stopping) return stopped();
    let native: Awaited<ReturnType<MxcShellSdk["spawn"]>>;
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
    const streams = Promise.all([forward(owned.stdout, stdout), forward(owned.stderr, stderr)]);
    void streams.catch(handleFailure);
    owned.stdin.on("error", handleFailure);
    owned.stdin.end();
    if (stopping) stop();
    else {
      try { await channel.send({ type: "shell-ready", id: owned.id }); } catch { handleFailure(); }
    }
    try {
      const result = await owned.completion;
      await owned.dispose({ drainOutput: false });
      await streams;
      if (owned.state !== "terminated" || owned.warnings.some((warning) => warning.startsWith(SEATBELT_CLEANUP_WARNING))) {
        return CLEANUP_UNVERIFIED;
      }
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
      else if (frame.type === "shell-start" && !starting && !stopping) {
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
