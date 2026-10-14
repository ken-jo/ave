/**
 * Boot step — remote A2A runtime and its renderer action controller.
 *
 * Both gates are owner switches on the Remote surfaces tab, while the targets,
 * route-control endpoint and secrets they need are provisioned outside the app.
 * Flipping a switch before that provisioning exists used to throw out of
 * `bootstrap()` and quit the whole app on the next launch. A remote feature
 * that cannot start is this feature's failure, not the desktop's: it is logged
 * and audited with the runtime's own reason code, and the feature stays off for
 * this run. The setting itself is left untouched so the owner's choice stays
 * visible.
 *
 * "Off for this run" is not the same thing as "off": the owner turned a switch
 * on, and answering them with the gate-down code told them they had not. The
 * failure is returned as its own state carrying the clamped reason code, which
 * the IPC surface answers as `a2a-remote-start-failed` — and still refuses
 * every remote request, because nothing behind it started.
 */
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
  /**
   * Present only when a gate was on and the runtime did not start. Always a
   * {@link remoteA2AStartFailureReason} code — never the thrown message — so it
   * is safe to hand the renderer.
   */
  readonly startFailureReason?: string;
}

/** The runtime's own reason code when it threw one, otherwise a fixed code. */
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
