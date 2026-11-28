import { homedir } from "node:os";
import { statSync } from "node:fs";
import { posix as posixPath, win32 as winPath } from "node:path";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import type { MxcHolderProcess } from "../../permissions/confined-child.js";
import { isMxcConfinedChildLive, spawnMxcConfinedChild, type MxcConfinedChildSpawn } from "../../permissions/confined-child.js";
import { assertMxcHolderStaging, type MxcExtensionFilesystemOwnership } from "../../permissions/mxc-filesystem-ownership.js";
import { mxcStagingParent } from "../../permissions/mxc-runtime-root.js";
import { atOrUnder, posixExecutableReadRoot } from "../../permissions/mxc-posix.js";
import { registerMxcPluginChildHolder } from "../../permissions/mxc-holder-lifetime.js";
import { isWindowsPathAtOrUnder } from "../../permissions/mxc-windows.js";
import { MxcProcessCleanupError, MxcProcessContractError } from "../../permissions/mxc-extension-errors.js";
import { PluginChildTerminationUnverifiedError, terminationUnverified, type ChildLink } from "./plugin-child-transport.js";
import type { DelegatedWorkerConfinement } from "./host-api-dispatcher.js";
import { windowsCommandLine } from "../../shared/windows-command-line.js";
import { capturePluginStderr } from "./plugin-stderr.js";
import { pacePluginChildInput } from "./plugin-child-credit.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";

const log = createLogger("mxc-plugin-child");

/** The backend planner's part of one incarnation's admission, never supplied by a manifest or a child message. The command,
 * arguments, cwd, environment and grants are not here: the adapter derives them from the host's intent and envelope. */
export interface MxcPluginChildLaunch {
  /** `<staging parent>\<opaque-id>\…` (`mxcStagingParent`), see `assertMxcHolderStaging`. */
  readonly home: string;
  readonly temp: string;
  /** Captured by the host from the owning incarnation. Its write roots must contain the staging directory and every
   * envelope write root, or row-2 admission refuses the spawn. */
  readonly filesystemOwnership: MxcExtensionFilesystemOwnership;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  /** Release the planner's own state (staging tree, ownership capture) only after verified termination. */
  release(): void | Promise<void>;
}

export interface MxcPluginChild {
  readonly link: ChildLink;
  readonly pid: number;
  /** The container it runs in, reported only after native spawn and transport setup. Not named `confinement`: that
   * key marks the legacy confined child. */
  readonly containerConfinement: MxcConfinedChildSpawn["confinement"];
  /** Rejecting means termination is unverified; the owner must refuse replacement. */
  waitForExit(): Promise<void>;
  /** Told synchronously, once, when termination begins for any reason; replayed to late listeners. */
  onTerminating(handler: () => void): void;
}

/** Adapt the owned streams without letting stream payloads or the supervisor PID select the recipient. */
export function attachMxcPluginChild(owned: MxcHolderProcess, launch: Pick<MxcPluginChildLaunch, "signal" | "release">, pluginId: string,
  confinement: MxcConfinedChildSpawn["confinement"]): MxcPluginChild {
  // Always take diagnostics, even when protocol construction has not begun.
  capturePluginStderr(owned.stderr, pluginId);
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
      log.debug("terminating native child %s: %s", pluginId, reason);
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
    containerConfinement: confinement,
    waitForExit: async () => { await exited; },
    onTerminating: (handler) => {
      terminatingHandlers.add(handler);
      if (terminating) handler();
    },
    link: {
      ...pacePluginChildInput(owned.stdout, owned.stdin),
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

/** Compare the exact command and physical cwd the holder admitted. */
export function assertLaunchMatchesIntent(request: ContainerRequest, intent: Pick<MxcPluginChildIntent, "command" | "args" | "cwd">): void {
  if (request.command !== windowsCommandLine(intent.command, intent.args)) {
    throw new MxcProcessContractError("Admitted plugin request does not run the derived command");
  }
  if (request.workingDirectory !== intent.cwd) {
    throw new MxcProcessContractError("Admitted plugin request does not use the derived working directory");
  }
}

/** The envelope reads, the runtime's directory, and the entry's directory unless another read root already covers it or
 * it lies inside an archive: a packaged entry sits in `app.asar`, a file, which the runtime's own directory covers. */
function pluginChildReadRoots(envelopeReads: readonly string[], command: string, entry: string | undefined): string[] {
  const windows = process.platform === "win32";
  const path = windows ? winPath : posixPath;
  const roots = [...new Set([...envelopeReads, windows ? path.dirname(command) : posixExecutableReadRoot(command)])];
  if (entry === undefined) return roots;
  const entryDirectory = path.dirname(entry);
  const inArchive = entryDirectory.split(/[\\/]/u).some((segment) => segment.toLowerCase().endsWith(".asar"));
  const contains = windows ? isWindowsPathAtOrUnder : (path: string, root: string) => atOrUnder(path, root, true);
  if (inArchive) return roots;
  const granted = roots.some((root) => contains(entryDirectory, root)) ? roots : [...roots, entryDirectory];
  if (process.platform !== "darwin") return granted;
  // macOS: an unpacked entry (a development build) loads the main bundle's external packages from the nearest node_modules
  // above it, and Node reads the package.json beside it for the entry's package scope; a packaged app keeps both inside
  // its archive. Granted like the entry, they never depend on the read carve. The rest of that folder stays ungranted.
  // The walk stays inside the checkout whose node_modules holds the runtime: never above it, never for a runtime that is
  // not a checkout's, and never when that checkout is the home folder or the root.
  const checkout = runtimeCheckout(command);
  if (checkout === undefined || !atOrUnder(entryDirectory, checkout, true)) return granted;
  const modules = nearestNodeModules(entryDirectory, checkout);
  if (modules === undefined) return granted;
  const manifest = posixPath.join(posixPath.dirname(modules), "package.json");
  const extra = [modules, ...(statSync(manifest, { throwIfNoEntry: false })?.isFile() === true ? [manifest] : [])];
  return [...granted, ...extra.filter((path) => !granted.some((root) => contains(path, root)))];
}

/** The folder whose node_modules holds the runtime (`<checkout>/node_modules/electron/...`); undefined otherwise. */
function runtimeCheckout(command: string): string | undefined {
  const index = command.indexOf("/node_modules/");
  if (index <= 0) return undefined;
  const checkout = command.slice(0, index);
  return checkout === posixPath.resolve(homedir()) ? undefined : checkout;
}

/** The nearest node_modules from `from` up to `bound`, both inclusive; never above `bound`. */
function nearestNodeModules(from: string, bound: string): string | undefined {
  for (let dir = from; ; dir = posixPath.dirname(dir)) {
    const candidate = posixPath.join(dir, "node_modules");
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory() === true) return candidate;
    if (dir === bound || dir === "/") return undefined;
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
  try {
    launch.assertCurrent();
    if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
    const staging = assertMxcHolderStaging({ stagingParent: mxcStagingParent(process.platform), home: launch.home, temp: launch.temp });
    const args = Object.freeze([...intent.args]);
    const allowRead = pluginChildReadRoots(intent.envelope.read, intent.command, args[0]);
    admitted = await spawnMxcConfinedChild({
      command: intent.command,
      args,
      cwd: intent.cwd,
      home: launch.home,
      temp: launch.temp,
      stagingRoot: staging,
      filesystemOwnership: launch.filesystemOwnership,
      // One holder per incarnation: row 2 refuses a holder it already admitted.
      holder: {},
      label: `plugin-child:${intent.pluginId}`,
      egressOwner: { kind: "worker", role: "plugin-child", pluginId: intent.pluginId },
      allowRead,
      allowWrite: [...intent.envelope.write, staging],
      floorPierces: intent.floorPierces,
      baseEnv: intent.baseEnv,
      signal: launch.signal,
      assertStillValid: () => {
        launch.assertCurrent();
        if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
      },
      // Checked on a snapshot of the exact request admission later consumes, so this is the request that runs. A macOS
      // launch is composed from these very command, arguments and directory, so there is no request to compare.
      ...(process.platform === "win32" ? { assertRequest: (request: ContainerRequest, cwd: string) => assertLaunchMatchesIntent(request, { ...intent, cwd }) } : {}),
    });
  } catch (error) {
    // Unverified startup cleanup keeps the planner's state: the process may still exist.
    if (error instanceof MxcProcessCleanupError) throw new PluginChildTerminationUnverifiedError(intent.pluginId, { cause: error });
    await launch.release();
    throw error;
  }
  const child = attachMxcPluginChild(admitted.process, {
    signal: launch.signal,
    // Row 2's release is idempotent and retained on failure; the planner's state goes only after it.
    release: async () => {
      await admitted.release();
      await launch.release();
    },
  }, intent.pluginId, admitted.confinement);
  // This plugin's contained workers bind to this incarnation, and to none once its termination begins.
  child.onTerminating(registerMxcPluginChildHolder(intent.pluginId, admitted, () => isMxcConfinedChildLive(admitted)));
  if (onTerminating) child.onTerminating(onTerminating);
  try {
    launch.assertCurrent();
    if (launch.signal.aborted) throw new MxcProcessContractError("Plugin child admission was revoked");
    return child;
  } catch (error) {
    child.link.terminate(`refused after spawn: ${errorMessage(error)}`);
    try {
      await child.waitForExit();
    } catch (cleanupError) {
      throw terminationUnverified(intent.pluginId, error, cleanupError);
    }
    throw error;
  }
}
