/** Remote startup failure disables only that feature for this run; retain the owner’s switch and deny requests. */
import type { A2ARemoteRuntime } from "../../main/a2a-remote-runtime.js";
import type { RemoteA2AActionController } from "../../main/remote-a2a-action-controller.js";

const REASON_CODE = /^a2a-remote-[a-z0-9-]{1,96}$/;
const UNCLASSIFIED_REASON = "a2a-remote-start-failed";

export interface RemoteA2ASetupOptions {
  /** Null when neither gate is on. May throw when a gate is on but unprovisioned. */
  readonly createRuntime: () => A2ARemoteRuntime | null;
  readonly createController: (runtime: A2ARemoteRuntime) => RemoteA2AActionController;
  /** Receives the reason code only; never the thrown value. */
  readonly audit: (code: string) => void;
  readonly logError: (err: unknown, message: string) => void;
}

export interface RemoteA2ASetup {
  readonly runtime?: A2ARemoteRuntime;
  readonly controller?: RemoteA2AActionController;
  /** Return only a clamped reason code to renderers, never a thrown message. */
  readonly startFailureReason?: string;
}

export function remoteA2AStartFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : undefined;
  return message !== undefined && REASON_CODE.test(message) ? message : UNCLASSIFIED_REASON;
}

export async function setupRemoteA2A(options: RemoteA2ASetupOptions): Promise<RemoteA2ASetup> {
  let runtime: A2ARemoteRuntime | null = null;
  try {
    runtime = options.createRuntime();
    if (runtime === null) return Object.freeze({});
    await runtime.ready();
    const controller = runtime.gates.outboundRouting ? options.createController(runtime) : undefined;
    return Object.freeze({ runtime, ...(controller ? { controller } : {}) });
  } catch (err) {
    const reason = remoteA2AStartFailureReason(err);
    try {
      runtime?.dispose();
    } catch (disposeErr) {
      options.logError(disposeErr, "remote A2A runtime dispose failed after a start failure");
    }
    options.audit(`start-failed:${reason}`);
    options.logError(err, `remote A2A is unavailable for this run (${reason}); continuing boot`);
    return Object.freeze({ startFailureReason: reason });
  }
}
