import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { spawnMxcExtensionProcess, type OwnedMxcExtensionProcess } from "../../permissions/mxc-extension-process.js";
import { MxcProcessCleanupError, MxcProcessContractError } from "../../permissions/mxc-extension-errors.js";
import type { ChildLink } from "./plugin-child-transport.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("mxc-plugin-child");

/** Host-owned admission, never supplied by a manifest or a child message. Policy construction belongs to the backend planner. */
export interface MxcPluginChildLaunch {
  readonly request: ContainerRequest;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Release the incarnation's policy/home/egress resources only after verified termination. */
  release(): void | Promise<void>;
}

export interface MxcPluginChild {
  readonly link: ChildLink;
  readonly pid: number;
  /** Rejecting means termination is unverified; the owner must refuse replacement. */
  waitForExit(): Promise<void>;
}

/** Adapt owned streams directly; neither the supervisor PID nor stream payloads select the recipient. */
export function attachMxcPluginChild(owned: OwnedMxcExtensionProcess, launch: Pick<MxcPluginChildLaunch, "signal" | "release">): MxcPluginChild {
  // Always take diagnostics, even when protocol construction has not begun.
  owned.stderr.on("data", (chunk: Buffer) => log.debug(chunk.toString("utf8").trimEnd()));
  let cleanup: Promise<void> | undefined;
  let fault: string | undefined;
  let resolveExit!: (reason: string) => void;
  let rejectExit!: (error: unknown) => void;
  const exited = new Promise<string>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const faults = new Set<(reason: string) => void>();
  const reportFault = (error: unknown): void => {
    if (fault !== undefined) return;
    fault = errorMessage(error);
    for (const handler of faults) handler(fault);
  };
  const stop = (reason: string): Promise<void> => {
    // Publish cleanup before invoking disposal: a synchronous fault callback
    // may reenter termination. Disposal, rather than signal delivery, proves death.
    cleanup ??= Promise.resolve().then(() => owned.dispose()).then(async () => {
      await launch.release();
      resolveExit(reason);
    }, (error: unknown) => {
      rejectExit(error);
      throw error;
    });
    // Resource release can fail after process death; retain that failure too.
    void cleanup.catch(rejectExit);
    void cleanup.catch(reportFault);
    return cleanup;
  };
  // A failed completion is a fault, never death evidence. Disposal must still
  // confirm termination before onGone, release, or replacement can proceed.
  void owned.completion.then(
    (result) => stop(`Plugin child exited code=${result.exitCode} timedOut=${result.timedOut}`),
    (error: unknown) => { reportFault(error); return stop("Plugin child terminated after a stream fault"); },
  ).catch(reportFault);
  void exited.catch(reportFault);
  const abort = (): void => {
    reportFault(new MxcProcessContractError("Plugin child admission was revoked"));
    void stop("Plugin child admission was revoked");
  };
  launch.signal.addEventListener("abort", abort, { once: true });
  void exited.finally(() => launch.signal.removeEventListener("abort", abort)).catch(() => {});
  if (launch.signal.aborted) abort();
  return {
    pid: owned.id,
    waitForExit: async () => { await exited; },
    link: {
      input: owned.stdout,
      output: owned.stdin,
      terminate: (reason) => { void stop(reason); },
      onGone: (handler) => { void exited.then(handler).catch(() => {}); },
      onFault: (handler) => {
        faults.add(handler);
        if (fault !== undefined) handler(fault);
      },
    },
  };
}

/** No retries or fallback after admission. The common primitive already tracks its supervisor for shutdown. */
export async function spawnMxcPluginChild(launch: MxcPluginChildLaunch): Promise<MxcPluginChild> {
  let owned: OwnedMxcExtensionProcess;
  try {
    launch.assertCurrent();
    if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
    // Snapshot the request before yielding so policy cannot change during startup.
    const request = structuredClone(launch.request);
    owned = await spawnMxcExtensionProcess(request, { signal: launch.signal });
  } catch (error) {
    if (!(error instanceof MxcProcessCleanupError)) await launch.release();
    throw error;
  }
  const child = attachMxcPluginChild(owned, launch);
  try {
    launch.assertCurrent();
    if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
    return child;
  } catch (error) {
    child.link.terminate("admission changed during spawn");
    await child.waitForExit();
    throw error;
  }
}
