import { win32 as winPath } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import type { OwnedMxcExtensionProcess } from "../../permissions/mxc-extension-process.js";
import { spawnMxcConfinedChild, type MxcConfinedChildSpawn, type MxcConfinedChildSpec } from "../../permissions/confined-child.js";
import { assertMxcHolderStaging, type MxcExtensionFilesystemOwnership } from "../../permissions/mxc-filesystem-ownership.js";
import { MxcProcessCleanupError, MxcProcessContractError } from "../../permissions/mxc-extension-errors.js";
import { PluginChildTerminationUnverifiedError, terminationUnverified, type ChildLink } from "./plugin-child-transport.js";
import type { DelegatedWorkerConfinement } from "./host-api-dispatcher.js";
import { windowsCommandLine } from "../../shared/windows-command-line.js";
import { aveHome } from "../../shared/ave-home.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("mxc-plugin-child");

/** The backend planner's part of one incarnation's admission, never supplied by a manifest or a child message. The command,
 * arguments, cwd, environment and grants are not here: the adapter derives them from the host's intent and envelope. */
export interface MxcPluginChildLaunch {
  /** `<AVE_HOME>\mxc-staging\<opaque-id>\…`, see `assertMxcHolderStaging`. */
  readonly home: string;
  readonly temp: string;
  /** Captured by the host from the owning incarnation. Its write roots must contain the staging directory and every
   * envelope write root, or row-2 admission refuses the spawn. */
  readonly filesystemOwnership: MxcExtensionFilesystemOwnership;
  readonly probe: MxcConfinedChildSpec["probe"];
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Release the planner's own state (staging tree, ownership capture) only after verified termination. */
  release(): void | Promise<void>;
}

export interface MxcPluginChild {
  readonly link: ChildLink;
  readonly pid: number;
  /** Rejecting means termination is unverified; the owner must refuse replacement. */
  waitForExit(): Promise<void>;
  /** Told synchronously, once, when termination begins for any reason; replayed to late listeners. */
  onTerminating(handler: () => void): void;
}

/** Adapt owned streams directly; neither the supervisor PID nor stream payloads select the recipient. */
export function attachMxcPluginChild(owned: OwnedMxcExtensionProcess, launch: Pick<MxcPluginChildLaunch, "signal" | "release">): MxcPluginChild {
  // Always take diagnostics, even when protocol construction has not begun.
  owned.stderr.on("data", (chunk: Buffer) => log.debug(chunk.toString("utf8").trimEnd()));
  let cleanup: Promise<void> | undefined;
  let terminating = false;
  const terminatingHandlers = new Set<() => void>();
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
    if (!terminating) {
      terminating = true;
      for (const handler of terminatingHandlers) handler();
    }
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
    onTerminating: (handler) => {
      terminatingHandlers.add(handler);
      if (terminating) handler();
    },
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

/** The launch intent the host derived; the admitted request must run exactly this. */
export interface MxcPluginChildIntent {
  readonly pluginId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The SAME envelope the dispatch table checks delegated workers against. */
  readonly envelope: DelegatedWorkerConfinement;
  readonly floorPierces: readonly string[];
  readonly baseEnv: NodeJS.ProcessEnv;
}

/** Both values are compared exactly against the request admission measured. The request builder forms `command` with
 * `windowsCommandLine` and passes the cwd through, so any rewriting (case folding, normalization, realpath) is a contract
 * violation. A JavaScript case fold would also disagree with the NTFS upcase table and could equate distinct directories. */
export function assertLaunchMatchesIntent(request: ContainerRequest, intent: Pick<MxcPluginChildIntent, "command" | "args" | "cwd">): void {
  if (request.command !== windowsCommandLine(intent.command, intent.args)) {
    throw new MxcProcessContractError("Admitted plugin request does not run the derived command");
  }
  if (request.workingDirectory !== intent.cwd) {
    throw new MxcProcessContractError("Admitted plugin request does not use the derived working directory");
  }
}

/** Admission is row 2's (`spawnMxcConfinedChild`): start guard, plan readiness, filesystem ranking, sibling-root and
 * executable nesting checks, HOME/temp placement, the single-use receipt and the executable re-measure in `beforeSpawn`.
 * This adds the plugin rules on top: the staging layout, the intent check on the measured request, the registration
 * recheck (through `assertStillValid`, so it also runs inside `beforeSpawn`), and quarantine on unverified termination.
 * No retries or fallback after admission. */
export async function spawnMxcPluginChild(
  launch: MxcPluginChildLaunch,
  intent: MxcPluginChildIntent,
  /** Attached before the post-spawn recheck, so even a child terminated inside this call is reported. */
  onTerminating?: () => void,
): Promise<MxcPluginChild> {
  let admitted: MxcConfinedChildSpawn;
  let mismatch: unknown;
  try {
    launch.assertCurrent();
    if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
    const staging = assertMxcHolderStaging({ aveHome: aveHome(), home: launch.home, temp: launch.temp });
    const args = Object.freeze([...intent.args]);
    const runtimeReads = [winPath.dirname(intent.command), ...args.slice(0, 1).map((entry) => winPath.dirname(entry))];
    admitted = await spawnMxcConfinedChild({
      command: intent.command,
      args,
      cwd: intent.cwd,
      home: launch.home,
      temp: launch.temp,
      filesystemOwnership: launch.filesystemOwnership,
      // One holder per incarnation: row 2 refuses a holder it already admitted.
      holder: {},
      label: `plugin-child:${intent.pluginId}`,
      egressOwner: { kind: "worker", role: "plugin-child", pluginId: intent.pluginId },
      allowRead: [...new Set([...intent.envelope.read, ...runtimeReads])],
      allowWrite: [...intent.envelope.write, staging],
      floorPierces: intent.floorPierces,
      baseEnv: intent.baseEnv,
      signal: launch.signal,
      assertStillValid: () => {
        launch.assertCurrent();
        if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
      },
      // Readiness is probed on a snapshot of the exact request admission later consumes, so this is the
      // request that runs. Readiness settlement reports a probe failure as not-ready; the mismatch is rethrown below.
      probe: async (request, signal) => {
        try {
          assertLaunchMatchesIntent(request, intent);
        } catch (error) {
          mismatch = error;
          throw error;
        }
        return launch.probe(request, signal);
      },
    });
  } catch (error) {
    // Unverified startup cleanup keeps the planner's state: the process may still exist.
    if (error instanceof MxcProcessCleanupError) throw new PluginChildTerminationUnverifiedError(intent.pluginId, { cause: error });
    await launch.release();
    throw mismatch ?? error;
  }
  const child = attachMxcPluginChild(admitted.process, {
    signal: launch.signal,
    // Row 2's release is idempotent and retained on failure; the planner's state goes only after it.
    release: async () => {
      await admitted.release();
      await launch.release();
    },
  });
  if (onTerminating) child.onTerminating(onTerminating);
  try {
    launch.assertCurrent();
    if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
    return child;
  } catch (error) {
    child.link.terminate("admission changed during spawn");
    try {
      await child.waitForExit();
    } catch (cleanupError) {
      throw terminationUnverified(intent.pluginId, error, cleanupError);
    }
    throw error;
  }
}
