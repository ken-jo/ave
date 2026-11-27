import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Duplex, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { getHostResources, type HostResources } from "../main/host-resources.js";
import { assertManagedChildProcessAdmissionOpen, trackManagedChildProcess } from "../main/managed-child-processes.js";
import { raceWithTimeout } from "../shared/abortable-deadline.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { MxcExtensionChannel, type MxcFramePayload } from "./mxc-extension-channel.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { isMxcSupervisorLoaderOverride } from "./mxc-supervisor-transport.js";

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

export async function stageMxcShellRequest(requestPath: string, request: object): Promise<ShellStart> {
  const bytes = Buffer.from(JSON.stringify(request));
  await writeFile(requestPath, bytes, { flag: "wx", mode: 0o600 });
  return { type: "shell-start", requestPath, requestSha256: createHash("sha256").update(bytes).digest("hex") };
}

const STOP_MS = TOOL_TIMEOUT_POLICY.mxcMacShellStopMs;
const LOST = {
  code: null, timedOut: false, cancelled: false, rejected: false, cleanupUnverified: true,
} as const;

interface ShellOutcome {
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly rejected: boolean;
  readonly cleanupUnverified: boolean;
  readonly failure?: Extract<ShellReceipt, { type: "error" }>;
}

function shellOutcome(receipt: ShellReceipt, ready: boolean): ShellOutcome {
  if (receipt.type === "error") {
    if (receipt.code === "cleanup-unverified" || receipt.code === "supervisor-lost") return LOST;
    if (ready && receipt.code !== "contract") return LOST;
    return { ...LOST, cleanupUnverified: false, rejected: !ready, failure: receipt };
  }
  if (receipt.type === "stopped") return { ...LOST, cancelled: true, cleanupUnverified: false };
  if (!ready) return LOST;
  return { ...LOST, code: receipt.exitCode, timedOut: receipt.timedOut, cleanupUnverified: false };
}

export function startMxcShellSupervisor(
  request: ShellStart, timeoutMs: number, signal: AbortSignal | undefined, revoke: () => void,
  label: string, location = mxcShellSupervisorLocation(),
) {
  signal?.throwIfAborted();
  assertManagedChildProcessAdmissionOpen(label);
  const key = randomBytes(32);
  const generation = randomBytes(32).toString("hex");
  const env = Object.fromEntries(Object.entries(buildSafeChildEnv()).filter(([name]) => !isMxcSupervisorLoaderOverride(name)));
  const child = spawn(process.execPath, [location.entry, location.nodeModules, generation,
    location.isPackaged ? "packaged" : "development"], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  const owner = child.stdio[3] as Writable;
  const control = child.stdio[4] as Duplex;
  const channel = new MxcExtensionChannel(control, control, generation, key, "host");
  let ready = false;
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
  owner.on("error", handleFailure);
  child.stdout.on("error", handleFailure);
  child.stderr.on("error", handleFailure);
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.on("error", () => {
      if (child.pid === undefined) resolve();
    });
  });
  const readReceipts = (async () => {
    for await (const frame of channel.frames()) {
      if (receipt !== undefined) throw new MxcProcessContractError("Frame after shell terminal receipt");
      if (frame.type === "shell-ready" && !ready) ready = true;
      else if (frame.type === "exit" || frame.type === "stopped" || frame.type === "error") receipt = frame;
      else throw new MxcProcessContractError("Unexpected shell supervisor frame");
    }
    if (receipt === undefined && child.exitCode === null && child.signalCode === null) handleFailure();
  })().catch(() => { receipt = undefined; handleFailure(); });

  signal?.addEventListener("abort", handleAbort, { once: true });
  const watchdog = setTimeout(handleFailure, timeoutMs + STOP_MS);
  const completion = (async (): Promise<ShellOutcome> => {
    const result = await Promise.race([
      Promise.all([exited, readReceipts]).then(() => receipt === undefined ? LOST : shellOutcome(receipt, ready)),
      lost.then(() => LOST),
    ]);
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
  trackManagedChildProcess(child, { label, cooperativeStop() {
    quitting = true;
    handleFailure();
    closeControl();
  } });
  owner.write(key, (error) => { if (error) handleFailure(); });
  void channel.send(request).catch(handleFailure);
  return { child, completion };
}
