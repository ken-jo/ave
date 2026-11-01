import type { Readable } from "node:stream";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MxcExtensionChannel } from "./mxc-extension-channel.js";
import { MXC_STREAM_CHUNK_BYTES } from "./mxc-extension-protocol.js";
import { MxcNativeProcess } from "./mxc-native-process.js";
import { MxcIntegrityError } from "../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError, MxcProcessContractError, MxcProcessCleanupError, MxcSupervisorLostError } from "./mxc-extension-errors.js";
import type { MxcSupervisorRuntime } from "./mxc-supervisor-bootstrap.js";
import { assertMxcExtensionRequest } from "./mxc-extension-request.js";

/** One container incarnation per supervisor. All dependencies are host-owned. */
export async function serveMxcSupervisor(channel: MxcExtensionChannel, liveness: Readable,
  bootstrap: () => Promise<MxcSupervisorRuntime>, onFatal: () => void): Promise<void> {
  let owned: MxcNativeProcess | undefined;
  let starting: Promise<{ exitCode: number; timedOut: boolean } | null> | undefined;
  let creationStarted = false;
  let stopping = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let resolveTerminal!: (result: { exitCode: number; timedOut: boolean } | null) => void;
  let rejectTerminal!: (error: unknown) => void;
  const terminal = new Promise<{ exitCode: number; timedOut: boolean } | null>((resolve, reject) => {
    resolveTerminal = resolve; rejectTerminal = reject;
  });
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    watchdog = setTimeout(onFatal, TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
    if (owned) void owned.dispose({ drainOutput: false }).catch(rejectTerminal);
    else if (!starting) resolveTerminal(null);
  };
  const fail = (error: unknown): void => { stop(); rejectTerminal(error); };
  const handleLivenessData = (): void => fail(new MxcProcessContractError("Unexpected supervisor liveness data"));
  liveness.once("end", stop); liveness.once("close", stop);
  liveness.once("error", fail);
  liveness.on("data", handleLivenessData);
  liveness.resume();
  if (liveness.readableEnded || liveness.destroyed) stop();

  const forward = async (stream: Readable, type: "stdout" | "stderr"): Promise<void> => {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let offset = 0; offset < bytes.length; offset += MXC_STREAM_CHUNK_BYTES) {
        await channel.send({ type, data: bytes.subarray(offset, offset + MXC_STREAM_CHUNK_BYTES).toString("base64") });
      }
    }
  };
  const controls = (async () => {
    for await (const frame of channel.frames()) {
      switch (frame.type) {
        case "start": {
          if (starting || stopping) throw new MxcProcessContractError("Supervisor start is not available");
          assertMxcExtensionRequest(frame.request);
          starting = (async () => {
            const runtime = await bootstrap();
            if (stopping) return null;
            const probe = runtime.sdk.probe(frame.request);
            const enumeration = frame.request.containment?.type === "processcontainer"
              ? frame.request.containment.config?.filesystem?.enumeratePaths ?? [] : [];
            if (probe.tier !== "base-container" || probe.needsDaclAugmentation !== false
              || (enumeration.length && probe.probes.baseContainerSupportsEnumeratePaths !== true)) {
              throw new MxcCapabilityUnavailableError("Required native containment is unavailable");
            }
            runtime.auditModules();
            if (stopping) return null;
            await channel.send({ type: "creating" });
            if (stopping) return null;
            creationStarted = true;
            // A single argument is deliberate: telemetry options are never passed.
            const native = await runtime.sdk.spawn(frame.request);
            owned = new MxcNativeProcess(native);
            const nativeModules = runtime.auditModules();
            if (stopping) {
              await owned.dispose();
              return null;
            }
            await channel.send({ type: "ready", id: owned.id, nodeVersion: process.versions.node, nativeModules });
            const stdout = forward(owned.stdout, "stdout"), stderr = forward(owned.stderr, "stderr");
            void stdout.catch(fail); void stderr.catch(fail);
            try {
              const result = await owned.completion;
              await Promise.all([stdout, stderr]);
              await owned.dispose({ drainOutput: false });
              return result;
            } catch (error) {
              // Stop forwarding into a failed parent while native teardown drains locally.
              owned.stdout.resume(); owned.stderr.resume();
              await owned.dispose();
              throw error;
            }
          })().catch(async (error: unknown) => {
            if (owned) await owned.dispose();
            throw error;
          });
          void starting.then(resolveTerminal, fail);
          break;
        }
        case "stdin":
          if (stopping) break;
          if (!owned || stopping || owned.stdin.writableEnded) throw new MxcProcessContractError("Supervisor input is not available");
          await new Promise<void>((resolve, reject) => owned!.stdin.write(Buffer.from(frame.data, "base64"),
            (error) => error && !stopping ? reject(error) : resolve()));
          break;
        case "stdin-end":
          if (stopping) break;
          if (!owned || stopping || owned.stdin.writableEnded) throw new MxcProcessContractError("Supervisor input is not available");
          owned.stdin.end();
          break;
        case "stop": stop(); break;
        default: throw new MxcProcessContractError("Unexpected supervisor control frame");
      }
    }
    stop();
  })();
  void controls.catch(fail);
  try {
    const result = await terminal;
    if (result) await channel.send({ type: "exit", ...result });
    else await channel.send({ type: "stopped" });
    await channel.end();
  } catch (cause) {
    stop();
    let failure = cause;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        starting?.catch((error: unknown) => {
          if (error instanceof MxcProcessCleanupError) throw error;
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(creationStarted
            ? new MxcProcessCleanupError("Supervisor cleanup is unverified")
            : new MxcSupervisorLostError("Supervisor startup did not settle")), TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs);
        }),
      ]);
      if (creationStarted && (!owned || owned.state !== "terminated")) {
        failure = new MxcProcessCleanupError("Supervisor cleanup is unverified", { cause });
      }
    } catch (error) {
      failure = error;
    } finally { clearTimeout(timer); }
    const code = failure instanceof MxcProcessCleanupError ? "cleanup-unverified"
      : failure instanceof MxcIntegrityError ? "integrity"
      : failure instanceof MxcCapabilityUnavailableError ? "capability-unavailable"
      : failure instanceof MxcSupervisorLostError ? "supervisor-lost" : "contract";
    try {
      // Every other error receipt certifies that creation never began or native
      // termination and disposal completed; cleanup failure has its own code.
      await channel.send({ type: "error", code,
        message: failure instanceof Error ? failure.message.slice(0, 1024) : "Supervisor failed" });
      await channel.end();
    } catch { /* The parent may already be gone; process exit closes the native job. */ }
    throw failure;
  } finally {
    clearTimeout(watchdog);
    liveness.off("end", stop); liveness.off("close", stop); liveness.off("error", fail); liveness.off("data", handleLivenessData);
    channel.input.destroy();
  }
}
