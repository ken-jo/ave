import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyEntries,
  cleanupAsrtSandboxAfterCommand,
  ensureSandboxTempPrincipalDir,
  wrapWorkerCommand,
  type SandboxTempPrincipal,
} from "../permissions/asrt-sandbox.js";
import { createAveHomeBoundarySnapshot } from "../permissions/ave-home-boundary-snapshot.js";
import { buildLauncherEnvironment, prepareSandboxTargetLaunch, type SandboxTargetLaunch } from "../permissions/launcher-environment.js";
import type { ChildProcess } from "node:child_process";
import {
  abandonManagedLaunch, assertManagedChildProcessAdmissionOpen, createManagedRelayResources, createManagedResources, ManagedExitUnconfirmedError,
  observeManagedWindowsRelayExit, observeManagedWindowsRelayTreeExit, recordManagedCleanup,
  releaseManagedResources, type ConfirmedExit, type ManagedResources, type RelayBestEffortExit,
} from "../main/managed-child-processes.js";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, posix as posixPath, win32 as winPath } from "node:path";
import type { Readable, Writable } from "node:stream";
import { t } from "../i18n/index.js";
import { raceWithTimeout } from "../shared/abortable-deadline.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { errorMessage } from "../shared/error-message.js";
import { isContainerHolderRouteEnabled } from "../shared/container-platform.js";
import { createLogger } from "../lib/logger.js";
import {
  liveMxcHolderWritableRoots,
  spawnConfinedChild,
  spawnMxcConfinedChild,
  type MxcConfinedChildSpawn,
  type MxcHolderIncarnation,
  type MxcHolderProcess,
  type MxcConfinedChildSpec,
} from "../permissions/confined-child.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { assertMxcReleaseGateEvidence } from "../permissions/mxc-extension-admission.js";
import { admitWindowsLookupPaths } from "../permissions/admitted-obligation.js";
import { MxcProcessCleanupError, MxcProcessContractError } from "../permissions/mxc-extension-errors.js";
import { planWindowsExtensionHolder } from "../permissions/mxc-extension-readiness.js";
import { isWindowsPathAtOrUnder } from "../permissions/mxc-windows.js";
import { measurePosixExecutableIdentity, posixHolderPaths, seatbeltHolderEnvironment, seatbeltHolderProcess } from "../permissions/holder-admission-darwin.js";
import { captureSeatbeltHolderFloors, composeSeatbeltHolderLaunch, startSeatbeltHolder, type SeatbeltHolderLaunchInput } from "../permissions/seatbelt-holder-launch.js";
import { newHolderLabels } from "../permissions/holder-label-sweep.js";
import { provenSeatbeltHolderRoute } from "../permissions/seatbelt-holder-boot.js";
import { withLocalityDecision } from "../shared/local-path-io.js";
import { isFullyQualifiedWindowsPath } from "../shared/windows-path-spelling.js";
import { getExtensionBackendPlan, getMacHolderCapability, onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import { listAuthorizedWorkspaceRoots } from "../permissions/workspace-authorized-roots.js";
import type { SandboxWindowsExtensionPlan } from "../shared/sandbox-capability-info.js";
import { createSandboxProcessHome, resolvedHostProcessOwner } from "../permissions/sandbox-process-home.js";
import { forgetIssuedContainerHome, recordIssuedContainerHome } from "../permissions/sandbox-home-registry.js";
import { readWindowsProcessRunStates, type ProcessRunStateProbe } from "../permissions/windows-process-start-time.js";
import {
  holdWindowsFilesystemGrant,
  terminateChildBestEffort,
  type HeldWindowsGrant,
} from "../permissions/windows-acl-grant-holder.js";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";
import { AVE_HOME_RUNTIME_DIRECTORY, AVE_RUNTIME_LAYOUT, aveHome } from "../shared/ave-home.js";
import { assertMxcHolderStaging } from "../permissions/mxc-filesystem-ownership.js";
import { mxcStagingParent } from "../permissions/mxc-runtime-root.js";
import { assertWriteGrantsOutsideConfinementState, declaredConfinementStatePaths } from "../permissions/confinement-state-paths.js";
import { renameDirectory, renameDirectorySyncOnce } from "../lib/transient-fs-lock-retry.js";
import { openEgressInvocation, type EgressInvocation, type WorkerEgressOwner } from "../permissions/egress-invocations.js";

const log = createLogger("wrap-bundled-command");

export interface BundledWrapInput {
  command: string;
  args: readonly string[];
  sandboxHome: { path: string; env: Record<string, string> };
  targetEnv: NodeJS.ProcessEnv;
  allowWrite: readonly string[];
  /** The directories of the process's own plugin it reads, re-allowed inside the plugins-root deny: a hook's generation root,
   * a bundled server's payload root. Empty for a server that belongs to no plugin, which then reads nothing under the root. */
  ownPluginReads: readonly string[];
  /** Host-owned principal whose private temporary directory the process receives. */
  tempPrincipal: SandboxTempPrincipal;
  /** Who the process's proxy denies are audited under (`egress-invocations.ts`). */
  egressOwner: WorkerEgressOwner;
}

/** Apply the same sensitive-path floors and egress policy to bundled processes. The wrapped launch, and the egress token it carries. The
 * caller spawns the process itself, so it owns the token too: `egress.release()` once the process has exited, or when the spawn fails. */
export async function wrapBundledCommand(input: BundledWrapInput): Promise<{
  argv: string[]; env: NodeJS.ProcessEnv; egress: EgressInvocation; targetLaunch: SandboxTargetLaunch;
}> {
  if (process.platform === "win32") {
    // The macOS and Linux wrap: allow paths in the command. Windows has no per-exec allow; its
    // bundled processes go through `spawnWindowsBundledProcess`, and reaching here is a caller's mistake.
    throw new Error("wrapBundledCommand is the macOS and Linux wrap; a Windows bundled process is spawned by spawnWindowsBundledProcess");
  }
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  // The principal's own temp directory, set as its TMPDIR inside the wrap (ASRT's own assignment would otherwise name the shared root) and granted alone; the read floor denies the
  // shared temp and HOME roots, so no other principal's temp files or HOME can be read either, and the process HOME re-allowed here is its own; as `confined-child.ts` does for its children.
  const temp = ensureSandboxTempPrincipalDir(input.tempPrincipal);
  const targetLaunch = prepareSandboxTargetLaunch(input.command, input.args, { ...input.targetEnv, ...input.sandboxHome.env }, temp.dir);
  const egress = openEgressInvocation(input.egressOwner);
  let result: { argv: string[]; env: NodeJS.ProcessEnv };
  try {
    const boundarySnapshot = createAveHomeBoundarySnapshot();
    result = await wrapWorkerCommand(targetLaunch.command, {
      commandId: egress.token,
      boundarySnapshot,
      filesystem: {
        allowWrite: [temp.dir, input.sandboxHome.path, ...input.allowWrite],
        // An ancestor grant can re-emit a protected deny after the exact hook file carve-out. User hooks need only their own temporary directory.
        // A host runtime program sits inside the Ave home read deny, so it reads its own runtime directories as on Windows.
        allowRead: [temp.dir, input.sandboxHome.path, ...input.ownPluginReads, ...input.allowWrite, ...hostRuntimeReads(input.command),
          ...(tmpDir && input.tempPrincipal.kind !== "hook" ? [tmpDir] : [])],
        ...(input.tempPrincipal.kind === "hook" ? { floorPierces: input.ownPluginReads } : {}),
        denyRead: boundarySnapshot.run(() => getDefaultSensitiveReadDenyPaths()),
        denyWrite: getDefaultSensitiveWriteDenyEntries(),
        // Bundled hooks and MCP stdio servers are plugin-owned (or third-party) code, and every root they
        // write into is one the host created: a plugin's data root, a server's sandbox root, the process HOME.
        pinWriteRoots: true,
        // And none of them reads another plugin's directories: a hook writes its plugin's data root, which
        // that plugin's child reads, so a hook that could read a neighbour's data could hand it to the child.
        denyPluginsRoot: true,
      },
    });
  } catch (error) {
    egress.release();
    throw error;
  }
  if (!result.argv[0]) {
    egress.release();
    await cleanupAsrtSandboxAfterCommand();
    throw new Error("ASRT returned an empty argv for a bundled process");
  }
  return { argv: result.argv, env: buildLauncherEnvironment(), egress, targetLaunch };
}

/** {@link wrapBundledCommand} with a throwaway HOME, whose teardown the owner holds on `resources` from acquisition: the caller
 * gets the launch and the egress group hook, never the cleanup. A wrap failure records only the HOME. */
export async function wrapManagedBundledCommand(input: Omit<BundledWrapInput, "sandboxHome"> & {
  readonly resources: ManagedResources;
}): Promise<{
  argv: string[]; env: NodeJS.ProcessEnv; homeEnv: Record<string, string>; targetLaunch: SandboxTargetLaunch; noteProcessGroup: (pid: number) => void;
}> {
  const { resources, ...wrapInput } = input;
  const sandboxHome = createSandboxProcessHome();
  let wrapped: Awaited<ReturnType<typeof wrapBundledCommand>>;
  try {
    wrapped = await wrapBundledCommand({ ...wrapInput, sandboxHome });
  } catch (error) {
    recordManagedCleanup(resources, sandboxHome.cleanup);
    throw error;
  }
  recordManagedCleanup(resources, wrapped.egress.release, cleanupAsrtSandboxAfterCommand, sandboxHome.cleanup);
  return {
    argv: wrapped.argv,
    env: wrapped.env,
    homeEnv: sandboxHome.env,
    targetLaunch: wrapped.targetLaunch,
    noteProcessGroup: (pid) => wrapped.egress.noteProcessGroup(pid),
  };
}

/** Own a private HOME and command wrap for a Windows launch with no lifetime ACL grants. */
export function prepareManagedWindowsProcessHome(label: string, treeReceiptLine?: string, onExitConfirmed?: () => void, onExitLost?: () => void) {
  if (process.platform !== "win32") throw new Error("Managed Windows process HOME requires Windows");
  const home = treeReceiptLine === undefined ? createSandboxProcessHome() : createSandboxProcessHome("win32", undefined, null);
  const resources = treeReceiptLine === undefined ? createManagedRelayResources() : createManagedResources();
  let child: ChildProcess | undefined;
  let treeExit: Promise<void> | undefined;
  let directExit: Promise<void> | undefined;
  let wrapped = false;
  recordManagedCleanup(resources, home.cleanup, () => wrapped ? cleanupAsrtSandboxAfterCommand() : undefined);
  return {
    env: home.env,
    onWrapped() { wrapped = true; },
    onSpawn(running: ChildProcess) {
      child = running;
      if (treeReceiptLine !== undefined) {
        treeExit = observeManagedWindowsRelayTreeExit(running, resources, treeReceiptLine).then(receipt => {
          if (receipt === undefined) {
            onExitLost?.();
            throw new ManagedExitUnconfirmedError();
          }
          onExitConfirmed?.();
          return releaseManagedResources(resources, receipt);
        });
        void treeExit.catch(() => {});
        return;
      }
      directExit = observeManagedWindowsRelayExit(running, resources).then(receipt => {
        onExitConfirmed?.();
        void releaseManagedResources(resources, receipt)
          .catch((error: unknown) => log.warn(`[${label}] sandbox home release failed: ${errorMessage(error)}`));
      });
    },
    async stop(preAuthenticationMs = 0) {
      if (child === undefined) {
        onExitConfirmed?.();
        return abandonManagedLaunch(resources);
      }
      if (treeExit === undefined) {
        terminateChildBestEffort(child);
        if (directExit === undefined) throw new ManagedExitUnconfirmedError();
        return raceWithTimeout(directExit, TOOL_TIMEOUT_POLICY.windowsInferenceTargetExitMs,
          () => new ManagedExitUnconfirmedError());
      }
      try {
        await raceWithTimeout(treeExit, preAuthenticationMs + TOOL_TIMEOUT_POLICY.windowsInferenceRelayStopMs,
          () => new ManagedExitUnconfirmedError());
      } catch (error) {
        terminateChildBestEffort(child);
        log.warn(`[${label}] sandbox teardown refused: ${errorMessage(error)}`);
        throw error;
      }
    },
  };
}

/** A bundled process started under srt-win, and what it holds while it runs. */
export interface WindowsBundledSpawn {
  readonly child: ChildProcess;
  /** The program's input and output, through the stdio relay (`confined-child.ts`). */
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly exit: Promise<RelayBestEffortExit>;
  /** Revoke the filesystem grant and remove the throwaway HOME once the relay settles. Idempotent; the HOME removal stays retryable, as
   * `createSandboxProcessHome` documents. ASRT's per-command cleanup is the caller's unless it passed `ownsCommandSandbox`. */
  readonly releaseHold: () => void;
}

/** Windows holds lifetime ACL grants for allowed reads/writes, private home, and bundled runtime binaries; relay stdio with the intended environment and cwd.
 * It shares one sandbox identity without per-plugin root pinning; lost grants stop the process, and any launch failure releases all acquired resources. */
export async function spawnWindowsBundledProcess(input: {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  readonly egressOwner: WorkerEgressOwner;
  /** Recheck caller-owned admission after preparation, at the actual spawn boundary. */
  readonly assertStillValid?: () => void;
  /** Refresh caller-owned authority after asynchronous launch preparation. */
  readonly refreshStillValid?: () => Promise<void>;
  /** A user hook's host-issued admitted shell plan; see `ConfinedChildSpec.userHookShellPlan`. */
  readonly userHookShellPlan?: HostShellExecutionPlan;
  /** The owner also runs ASRT's per-command cleanup with the hold. */
  readonly ownsCommandSandbox?: boolean;
}): Promise<WindowsBundledSpawn> {
  if (process.platform !== "win32") {
    throw new Error(`[wrap-bundled-command] ${input.label}: spawnWindowsBundledProcess is the Windows path`);
  }
  const sandboxHome = createSandboxProcessHome();
  const resources = createManagedRelayResources();
  let grant: HeldWindowsGrant | undefined;
  let wrapped = false;
  let launchFailed = false;
  let child: ChildProcess | undefined;
  let exit: Promise<RelayBestEffortExit> | undefined;
  // Recorded with the handle; the grant and wrap state are read when the owner releases.
  recordManagedCleanup(resources,
    () => (wrapped && (launchFailed || input.ownsCommandSandbox) ? cleanupAsrtSandboxAfterCommand() : undefined), () => grant?.release(), sandboxHome.cleanup);
  const settleHold = (): void => {
    const release = exit ? exit.then(receipt => releaseManagedResources(resources, receipt)) : abandonManagedLaunch(resources);
    void release.catch((error: unknown) => log.warn(`[${input.label}] sandbox hold release failed: ${errorMessage(error)}`));
  };
  const acquire = (running: ChildProcess): void => {
    child = running;
    exit = observeManagedWindowsRelayExit(running, resources);
  };
  try {
    grant = await holdWindowsFilesystemGrant({
      label: `${input.label}:asrt-win-acl`,
      allowRead: [...new Set([sandboxHome.path, ...input.allowWrite, ...input.allowRead, ...hostRuntimeReads(input.command)])],
      allowWrite: [...new Set([sandboxHome.path, ...input.allowWrite])],
      sandboxHome: sandboxHome.path,
    });
    const held = grant;
    const spawned = await spawnConfinedChild({
      command: input.command,
      args: input.args,
      label: `${input.label}:asrt-win`,
      egressOwner: input.egressOwner,
      grantMode: "deny-only",
      baseEnv: input.baseEnv,
      extraEnv: { ...sandboxHome.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsStdio: "relay",
      // srt-win starts only in a directory the sandbox account is granted; the host's own cwd is not one.
      cwd: input.cwd ?? sandboxHome.path,
      ...(input.userHookShellPlan !== undefined ? { userHookShellPlan: input.userHookShellPlan } : {}),
      refreshStillValid: input.refreshStillValid,
      assertStillValid: () => {
        held.assertAlive();
        input.assertStillValid?.();
      },
      onWrapped: () => {
        wrapped = true;
      },
      onSpawn: acquire,
    });
    if (spawned.confinement !== "windows-srt") {
      throw new Error(`[wrap-bundled-command] ${input.label}: the sandbox was expected but the process came back ${spawned.confinement}`);
    }
    const running = spawned.child;
    if (!exit) throw new Error("Windows relay exit is unowned.");
    held.onLost((reason) => {
      log.warn(`[${input.label}] filesystem grant lost, ending the process: ${reason.message}`);
      terminateChildBestEffort(running);
    });
    // A start that produced no process emits `error` and may emit nothing else.
    running.once("error", () => {
      if (running.pid === undefined) settleHold();
    });
    return { child: running, stdin: spawned.stdin!, stdout: spawned.stdout!, exit, releaseHold: settleHold };
  } catch (error) {
    if (child !== undefined) terminateChildBestEffort(child);
    launchFailed = true;
    settleHold();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** The runtime-boundary children a program inside `<AVE_HOME>/runtime` needs, never the boundary itself: a grant entry left by a
 * crash then sits on a child, and boot reads only the boundary's own DACL. uv gets `uv`; a venv or Python-install program gets its
 * env root's `venv` and `python` (the base interpreter its venv was created from). The sandbox account crosses the owner-only
 * boundary through bypass-traverse. A program elsewhere in the boundary is outside the layout and refused. */
export function hostRuntimeReads(command: string): string[] {
  const runtime = join(aveHome(), AVE_HOME_RUNTIME_DIRECTORY);
  if (!isPathWithin(runtime, command)) return [];
  const segments = command.slice(runtime.length).split(/[\\/]+/).filter((segment) => segment !== "");
  if (segments[0] === AVE_RUNTIME_LAYOUT.uv && segments.length > 1) return [join(runtime, AVE_RUNTIME_LAYOUT.uv)];
  const pythonEnv = segments[0] === AVE_RUNTIME_LAYOUT.pythonEnvs;
  const envRoot = pythonEnv && segments.length > 1 ? join(runtime, AVE_RUNTIME_LAYOUT.pythonEnvs, segments[1]!) : runtime;
  const rest = pythonEnv ? segments.slice(2) : segments;
  if (rest.length > 1 && (rest[0] === AVE_RUNTIME_LAYOUT.venv || rest[0] === AVE_RUNTIME_LAYOUT.python)) {
    return [join(envRoot, AVE_RUNTIME_LAYOUT.venv), join(envRoot, AVE_RUNTIME_LAYOUT.python)];
  }
  throw new Error(`[wrap-bundled-command] ${command} is inside the Ave runtime folder but not in its uv or Python environment layout`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Container holders (design row 5). MCP stdio servers and hooks run as their own extension holder through the one
// sanctioned native entry, `spawnMxcConfinedChild`. This helper lays out the holder's sibling roots and refuses, with a
// named reason and before admission, what the contract forbids; admission, the receipt, nesting and lifetime stay row 2's.
// ---------------------------------------------------------------------------------------------------------------------

/** The selected boot plan routes extension holders to containers. A checking or rejected plan is refused by the guard. */
export function isMxcExtensionBackendSelected(): boolean {
  if (!isContainerHolderRouteEnabled(process.platform)) return false;
  const plan = getExtensionBackendPlan();
  return plan?.selectedBackend === "mxc" && plan.readiness === "ready";
}

/** macOS: this app run proved the holder route. A user hook admitted under a container shell plan runs as a holder when
 * it did, whatever the extension setting: a user hook follows the shell setting. */
function isMacHolderRouteReady(): boolean {
  return process.platform === "darwin" && isContainerHolderRouteEnabled("darwin") && getMacHolderCapability()?.state === "ready";
}

/** Whether this holder start is routed to a container: the extension plan, or for a macOS user hook the holder route. */
function isHolderStartRouted(owner: WorkerEgressOwner): boolean {
  return isMxcExtensionBackendSelected() || (owner.role === "hook" && owner.pluginId === undefined && isMacHolderRouteReady());
}

/** The container executable is inside a workspace or a holder-writable root, is not a Windows executable, or cannot be resolved. */
export class MxcExecutableNotAdmissibleError extends Error {
  readonly code = "executable-not-admissible";
  constructor(detail: string) {
    super(t("be_wrapBundledCommand.executableNotAdmissible", { detail, code: "executable-not-admissible" }));
    this.name = "MxcExecutableNotAdmissibleError";
  }
}

/** Another live extension holder writes the same workspace; two such holders cannot be live at once and are never queued.
 * `stagingOverlap`: the overlap is another holder's private staging tree under the runtime root inside this workspace (a
 * project rooted at the user profile), which the message then names. */
export class MxcHolderWorkspaceBusyError extends Error {
  readonly code = "holder-workspace-busy";
  constructor(readonly stagingOverlap = false) {
    super(t(stagingOverlap ? "be_wrapBundledCommand.workspaceBusyStaging" : "be_wrapBundledCommand.workspaceBusy", { code: "holder-workspace-busy" }));
    this.name = "MxcHolderWorkspaceBusyError";
  }
}

/** Git Bash cannot start inside a container (owner decision on the user-hook selector). Carries the per-holder plan that names the reason. */
export class MxcBashIncompatibleError extends Error {
  readonly code = "bash-incompatible";
  constructor(readonly plan: SandboxWindowsExtensionPlan) {
    super(t("be_wrapBundledCommand.bashIncompatible", { code: "bash-incompatible" }));
    this.name = "MxcBashIncompatibleError";
  }
}

/** An earlier incarnation's termination could not be verified; it keeps its leases and blocks replacement until restart. */
export class MxcHolderQuarantinedError extends Error {
  readonly code = "holder-quarantined";
  constructor(label: string) {
    super(t("be_wrapBundledCommand.holderQuarantined", { label, code: "holder-quarantined" }));
    this.name = "MxcHolderQuarantinedError";
  }
}

const BASH_BASENAME = /^(?:bash|sh|git-bash)(?:\.exe)?$/iu;
// Git for Windows and MSYS2 keep their POSIX runtime programs in `<root>\usr\bin`; every one of them loads the MSYS
// runtime that cannot start in a container. Native Windows has no `usr\bin` directory of its own.
const MSYS_USR_BIN = /[\\/]usr[\\/]bin[\\/][^\\/]+$/iu;

/** Bash-form: a Git Bash / MSYS interpreter or tool, by its resolved flavor, its executable name (`bash`, `sh`,
 * `git-bash`) or its location in an MSYS `usr\bin`. */
export function isBashFormCommand(command: string, shellFlavor?: string): boolean {
  return shellFlavor === "msys" || BASH_BASENAME.test(winPath.basename(command)) || MSYS_USR_BIN.test(command);
}

/** Loader and SDK overrides a container request refuses. A holder whose host-owned variables carry one is refused
 * here, by key name, before any lease or staging; the request validator stays the last line of defense. */
const CONTAINER_REFUSED_ENV = /^(?:NODE_OPTIONS|NODE_PATH|MXC_FFI_DIR|MXC_BIN_DIR|AVE_MXC_.*)$/u;

export class MxcHolderEnvironmentRefusedError extends Error {
  readonly code = "holder-environment-refused";
  constructor(readonly keys: readonly string[]) {
    super(t("be_wrapBundledCommand.environmentRefused", { keys: keys.join(", "), code: "holder-environment-refused" }));
    this.name = "MxcHolderEnvironmentRefusedError";
  }
}

function assertHolderEnvironmentAdmissible(...environments: Readonly<Record<string, string | undefined>>[]): void {
  const refused = new Set<string>();
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) continue;
      const key = name.toUpperCase();
      if (CONTAINER_REFUSED_ENV.test(key) || (key === "ELECTRON_RUN_AS_NODE" && value !== "1")) refused.add(key);
    }
  }
  // Names only: a value may be a secret.
  if (refused.size > 0) throw new MxcHolderEnvironmentRefusedError([...refused].sort());
}

/** Produce `bash-incompatible` before admission. The plan selects no fallback: under a selected container boot plan an
 * extension holder has no account-backed admission (the legacy guard refuses it), and the backend is never switched for
 * one holder. A user hook on an srt-win shell plan never reaches this; it keeps that route. */
export function assertMxcHolderNotBashForm(command: string, shellFlavor?: string): void {
  if (!isBashFormCommand(command, shellFlavor)) return;
  throw new MxcBashIncompatibleError(planWindowsExtensionHolder({
    requested: true,
    mxc: { state: "unavailable", reason: "bash-incompatible" },
    fallback: { version: "0.0.80", ready: false },
  }));
}

/** Lexical and admitted paths so a junction-spelled root compares as its target. */
/** The staging and path rules of the platform this holder runs on: Windows, or macOS. */
const windowsHost = (): boolean => process.platform === "win32";
const hostPath = (): typeof winPath => windowsHost() ? winPath : posixPath;
const atOrUnderOnHost = (path: string, root: string): boolean => windowsHost() ? isWindowsPathAtOrUnder(path, root) : posixHolderPaths.atOrUnder(path, root);

function pathForms(paths: readonly string[]): string[] {
  if (!windowsHost()) {
    return paths.flatMap(path => {
      const lexical = posixHolderPaths.normalize(path);
      const target = posixHolderPaths.target(path);
      return target === lexical ? [lexical] : [lexical, target];
    });
  }
  const local = admitWindowsLookupPaths(paths, "mxc-launch");
  return paths.flatMap(path => {
    const lexical = winPath.normalize(path);
    const target = local.get(path)?.target;
    return target === undefined || target.toLowerCase() === lexical.toLowerCase() ? [lexical] : [lexical, target];
  });
}

function overlaps(left: string, right: string): boolean {
  return atOrUnderOnHost(left, right) || atOrUnderOnHost(right, left);
}

/** PATH resolution as the legacy spawn would find it, restricted to absolute directories and `.exe` programs: a relative
 * PATH entry needs a working directory or drive, and a script shim needs an interpreter the container would run instead. */
function resolveHolderExecutable(command: string, env: NodeJS.ProcessEnv): string {
  if (!windowsHost()) return resolvePosixHolderExecutable(command, env);
  let canonical: string | undefined;
  if (winPath.isAbsolute(command)) {
    const entry = admitWindowsLookupPaths([command], "mxc-launch").get(command);
    if (entry?.kind !== "file") {
      throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableNotFound", { command }));
    }
    canonical = entry.target;
  } else if (/[\\/]/u.test(command)) {
    throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableRelative", { command }));
  } else {
    const name = winPath.extname(command) === "" ? `${command}.exe` : command;
    const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? "";
    const directories = pathValue.split(";");
    if (directories.some(directory => !isFullyQualifiedWindowsPath(directory) || directory.split(/[\\/]/u).includes(".."))) {
      throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableNotFound", { command }));
    }
    const candidates = directories.map(directory => winPath.join(directory, name));
    const entries = admitWindowsLookupPaths(candidates, "mxc-launch");
    canonical = [...entries.values()].find(entry => entry.kind === "file")?.target;
  }
  if (canonical === undefined) throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableNotFound", { command }));
  if (!/\.exe$/iu.test(canonical)) {
    throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableNotExe", { path: canonical }));
  }
  return canonical;
}

/** macOS: an absolute path, or a bare name found on an all-absolute PATH, resolved to the regular executable file it
 * names. The holder runs that resolved file, whose identity row 2 measures. */
function resolvePosixHolderExecutable(command: string, env: NodeJS.ProcessEnv): string {
  let candidates: string[];
  if (posixPath.isAbsolute(command)) {
    candidates = [command];
  } else if (command.includes("/")) {
    throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableRelative", { command }));
  } else {
    const directories = (env.PATH ?? process.env.PATH ?? "").split(":");
    if (directories.some(directory => !posixPath.isAbsolute(directory) || directory.split("/").includes(".."))) {
      throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableNotFound", { command }));
    }
    candidates = directories.map(directory => posixPath.join(directory, command));
  }
  for (const candidate of candidates) {
    let resolved: string;
    try { resolved = realpathSync.native(candidate); } catch { continue; }
    const entry = statSync(resolved, { throwIfNoEntry: false });
    if (entry?.isFile() && (entry.mode & 0o111) !== 0) return resolved;
  }
  throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableNotFound", { command }));
}

/** What the kernel runs for a macOS holder command. */
export interface PosixHolderLaunch {
  /** The program exec'd: the resolved file, or a script's interpreter. Row 2 measures this one. */
  readonly command: string;
  /** Arguments before the caller's: a script's interpreter arguments, then the script itself. */
  readonly prefix: readonly string[];
  /** Every file the launch runs or interprets; each takes the executable rule. */
  readonly files: readonly string[];
}

const SHEBANG_BYTES = 512;

/**
 * macOS: a `#!` script runs its interpreter, which an `env` line would look up on the holder's PATH at run time. The
 * interpreter is resolved here instead, by the same rule as the command and on the same PATH, and exec'd directly with
 * the script as its argument. So the program that runs is the one row 2 measures, and both files take the executable
 * rule. An interpreter that is itself a script, or an `env` line with options or assignments, is refused.
 * @internal exported for its tests.
 */
export function resolvePosixHolderLaunch(command: string, env: NodeJS.ProcessEnv): PosixHolderLaunch {
  const file = resolvePosixHolderExecutable(command, env);
  const line = shebangOf(file);
  if (line === undefined) return Object.freeze({ command: file, prefix: Object.freeze([]), files: Object.freeze([file]) });
  const refuse = (): never => {
    throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.interpreterNotAdmissible", { path: file, line: `#!${line}` }));
  };
  const [interpreter, ...interpreterArgs] = line.trim().split(/[ \t]+/u);
  if (interpreter === undefined || !posixPath.isAbsolute(interpreter)) return refuse();
  let program: string;
  let programArgs: readonly string[];
  if (interpreter === "/usr/bin/env") {
    const [name, ...rest] = interpreterArgs;
    if (name === undefined || rest.length > 0 || name.startsWith("-") || name.includes("=") || name.includes("/")) return refuse();
    program = resolvePosixHolderExecutable(name, env);
    programArgs = [];
  } else {
    program = resolvePosixHolderExecutable(interpreter, env);
    programArgs = interpreterArgs;
  }
  if (shebangOf(program) !== undefined) return refuse();
  return Object.freeze({ command: program, prefix: Object.freeze([...programArgs, file]), files: Object.freeze([file, program]) });
}

function shebangOf(file: string): string | undefined {
  const head = Buffer.alloc(SHEBANG_BYTES);
  const fd = openSync(file, "r");
  let read: number;
  try { read = readSync(fd, head, 0, SHEBANG_BYTES, 0); } finally { closeSync(fd); }
  if (read < 2 || head[0] !== 0x23 || head[1] !== 0x21) return undefined;
  const end = head.subarray(0, read).indexOf(0x0a);
  if (end < 0) throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.interpreterNotAdmissible", { path: file, line: "#!" }));
  return head.subarray(2, end).toString("utf8");
}

/** Contract rule: never an executable from a workspace or any holder-writable root, this holder's own included. */
function assertExecutableAdmissible(executable: string, ownWriteRoots: readonly string[], workspaceRoots: readonly string[]): void {
  const forbidden = [
    ...pathForms([...listAuthorizedWorkspaceRoots(), ...workspaceRoots, ...ownWriteRoots]),
    ...liveMxcHolderWritableRoots(),
  ];
  const hit = forbidden.find((root) => atOrUnderOnHost(executable, root));
  if (hit !== undefined) throw new MxcExecutableNotAdmissibleError(t("be_wrapBundledCommand.executableInsideWorkspace", { path: executable }));
}

/** Two holders writing one workspace cannot both be live. Refuse only that concurrency, never queue it. */
function assertNoLiveWorkspaceWriter(allowWrite: readonly string[], workspaceRoots: readonly string[]): void {
  const workspaces = pathForms([...listAuthorizedWorkspaceRoots(), ...workspaceRoots]);
  const workspaceWrites = pathForms(allowWrite).filter((write) => workspaces.some((root) => overlaps(write, root)));
  if (workspaceWrites.length === 0) return;
  const busy = liveMxcHolderWritableRoots().filter((live) => workspaceWrites.some((write) => overlaps(write, live)));
  if (busy.length === 0) return;
  // The caller's workspace write contains another holder's private staging tree.
  let staging: string[] = [];
  try { staging = pathForms([mxcStagingParent(process.platform)]); } catch { /* no staging parent: the busy root is not under one */ }
  throw new MxcHolderWorkspaceBusyError(busy.some((live) => staging.some((root) => atOrUnderOnHost(live, root))));
}

interface HolderStaging { readonly root: string; readonly home: string; readonly temp: string }

/** Resolve the staging parent again, which re-reads the runtime root's path, and refuse one that is no longer `parent`. */
function assertSameStagingParent(parent: string): void {
  if (mxcStagingParent(process.platform) !== parent) throw new MxcProcessContractError("Container staging parent changed while a holder's directories were created");
}

/** `instance` tells two copies of this module in one process apart: each copy knows only its own live holders.
 * `start` is the process creation time, or null while the start-up probe has not read it. */
interface StagingOwner { readonly pid: number; readonly start: string | null; readonly instance: string }

const STAGING_INSTANCE = randomBytes(8).toString("hex");
const STAGING_OWNER_SUFFIX = ".owner";
const STAGING_RETIRED_SUFFIX = ".retired";
const STAGING_OWNER_MAX_BYTES = 256;
const STAGING_ID = /^[0-9a-f]{32}$/u;

/** Staging roots this copy created and has not yet been told to remove. A sweep never touches them. */
const liveStaging = new Set<string>();
/** Staging parents whose other instances' leftovers this process has already asked the OS about. */
const probedStagingParents = new Set<string>();

/**
 * `<staging parent>\<opaque-id>\{home,temp}`: its enumerate grant reveals only opaque IDs (contract doc). The parent is
 * the platform's (`mxcStagingParent`), under the runtime root outside the Ave home, which every Ave home and running
 * instance of this account shares. A sibling `<id>.owner` therefore records this process before the directory exists,
 * so a crash never leaves an unmarked tree. The marker sits in the staging parent, which no holder is granted.
 */
function createHolderStaging(): HolderStaging {
  const parent = mxcStagingParent(process.platform);
  sweepHolderStaging(parent);
  const dir = hostPath().join(parent, randomBytes(16).toString("hex"));
  const home = hostPath().join(dir, "home");
  const temp = hostPath().join(dir, "temp");
  // The shared staging-shape check (also the plugin-child adapter's): exactly <staging parent>\<32-hex>\{home,temp}.
  const root = assertMxcHolderStaging({ stagingParent: parent, home, temp });
  const owner: StagingOwner = { pid: process.pid, start: resolvedHostProcessOwner()?.startTime ?? null, instance: STAGING_INSTANCE };
  // The sweep ran since the parent was resolved: the runtime root's path is read again right before the tree is created.
  assertSameStagingParent(parent);
  writeFileSync(`${root}${STAGING_OWNER_SUFFIX}`, JSON.stringify(owner), { flag: "wx" });
  liveStaging.add(root);
  try {
    // Exclusive: an existing entry under a fresh random name is not this holder's.
    for (const directory of [root, home, temp]) mkdirSync(directory);
    // Ave owns this fresh staging directory and can prepare the carrier here.
    mkdirSync(hostPath().join(root, ".ave"));
  } catch (error) {
    liveStaging.delete(root);
    try { removeStagingTree(root); } catch { /* the marked remainder is left for a sweep */ }
    throw error;
  }
  try {
    // And once it exists: a tree created while the path was swapped is never handed to a holder.
    assertSameStagingParent(parent);
  } catch (error) {
    // Nothing is removed through a path that no longer leads to the root; the marked tree is left for a sweep.
    liveStaging.delete(root);
    throw error;
  }
  // The one directory under the runtime root this holder may use as its working directory.
  recordIssuedContainerHome(home, hostPath().dirname(parent));
  return Object.freeze({ root, home, temp });
}

/** Delete a tree without following links: a confined child may have planted a junction there, and a recursive removal
 * through it would delete the target. A link is unlinked itself and never followed or chmod-ed; a read-only file has its
 * read-only attribute cleared first. */
function removeTreeWithoutFollowingLinks(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (!entry.isDirectory()) {
    chmodSync(path, 0o666);
    unlinkSync(path);
    return;
  }
  for (const name of readdirSync(path)) removeTreeWithoutFollowingLinks(hostPath().join(path, name));
  rmdirSync(path);
}

/** The retired and unretired trees a marker stands for, where they exist. Each must be a real directory. */
function stagingTrees(root: string): string[] {
  return [`${root}${STAGING_RETIRED_SUFFIX}`, root].filter((tree) => {
    const entry = lstatSync(tree, { throwIfNoEntry: false });
    if (entry !== undefined && (entry.isSymbolicLink() || !entry.isDirectory())) throw new Error("the marked entry is not a directory");
    return entry !== undefined;
  });
}

/** Delete one holder's retired and unretired trees and, last, its owner marker. A marked entry that is a link or a
 * file is not a staging tree and stops the removal. The marker goes only once neither tree is left, so an interrupted
 * removal stays provably this owner's for a later sweep. */
function removeStagingTree(root: string): void {
  for (const tree of stagingTrees(root)) removeTreeWithoutFollowingLinks(tree);
  try {
    unlinkSync(`${root}${STAGING_OWNER_SUFFIX}`);
  } catch (error) {
    // Already removed by another remover of the same tree.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Remove a dead holder's staging tree. It is first renamed to its `.retired` sibling, so nothing can reach it by its
 * granted name mid-removal. The rename retries Windows lock codes, which a just-exited holder's handles can still
 * raise. A partial failure leaves the marked remainder for the next sweep. */
async function removeHolderStaging(root: string): Promise<void> {
  if (!liveStaging.delete(root)) return;
  forgetIssuedContainerHome(hostPath().join(root, "home"));
  try {
    try {
      await renameDirectory(root, `${root}${STAGING_RETIRED_SUFFIX}`);
    } catch (error) {
      // Never created.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Synchronous after the rename, so no sweep in this process interleaves with it.
    removeStagingTree(root);
  } catch (error) {
    log.warn(`holder staging removal incomplete: ${(error as Error).message}`);
  }
}

function readStagingOwner(markerPath: string): StagingOwner | null {
  try {
    const entry = lstatSync(markerPath);
    if (!entry.isFile() || entry.nlink !== 1 || entry.size > STAGING_OWNER_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, start, instance } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof instance !== "string" || instance === ""
        || !(start === null || (typeof start === "string" && start !== ""))) return null;
    return { pid, start, instance };
  } catch {
    return null;
  }
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function sweepStagingTree(root: string): void {
  // A holder this process still runs keeps its tree, whichever copy of this module started it.
  if (liveMxcHolderWritableRoots().some((live) => overlaps(live, root))) return;
  try {
    // Before the rename: a link or a file beside a marker is left exactly where it is.
    stagingTrees(root);
    try {
      renameDirectorySyncOnce(root, `${root}${STAGING_RETIRED_SUFFIX}`);
    } catch (error) {
      // Already retired by an interrupted removal, or never created. EPERM is not among them: a process that outlived
      // its owner may still hold the tree open, so it is kept whole, marker included, for a sweep after a later start.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
    }
    removeStagingTree(root);
  } catch (error) {
    log.warn(`abandoned holder staging not removed: ${(error as Error).message}`);
  }
}

/**
 * Remove what crashed or interrupted holders left under the staging parent. A tree is another instance's until its
 * sibling marker proves otherwise: it is removed only when the marker names this copy of this module for a holder it
 * already released, or a process that is provably gone (no such pid, or a pid whose creation time is no longer the
 * recorded one). Entries with no marker, an unreadable marker, or a live or undetermined owner are kept. The first
 * call per staging parent asks the OS for the creation times of the owners still running and removes the reused ones
 * when the answer arrives. Failure only warns: a leftover never blocks a start.
 */
function sweepHolderStaging(parent: string, probe: ProcessRunStateProbe = readWindowsProcessRunStates): void {
  let names: string[];
  try {
    names = readdirSync(parent).filter((name) => name.endsWith(STAGING_OWNER_SUFFIX) && STAGING_ID.test(name.slice(0, -STAGING_OWNER_SUFFIX.length)));
  } catch (error) {
    log.warn(`holder staging sweep skipped: ${(error as Error).message}`);
    return;
  }
  const running = new Map<string, StagingOwner>();
  for (const name of names) {
    const root = hostPath().join(parent, name.slice(0, -STAGING_OWNER_SUFFIX.length));
    if (liveStaging.has(root)) continue;
    const owner = readStagingOwner(`${root}${STAGING_OWNER_SUFFIX}`);
    if (owner === null) continue;
    if (owner.pid === process.pid) {
      if (owner.instance === STAGING_INSTANCE) sweepStagingTree(root);
    } else if (processIsGone(owner.pid)) {
      sweepStagingTree(root);
    } else if (owner.start !== null) {
      running.set(root, owner);
    }
  }
  if (running.size === 0 || probedStagingParents.has(parent)) return;
  probedStagingParents.add(parent);
  void probe([...new Set([...running.values()].map((owner) => owner.pid))]).then((states) => {
    for (const [root, owner] of running) {
      const state = states.get(owner.pid);
      // A different creation time under the same pid is another process: the owner exited and its pid was reused.
      const gone = state !== undefined && (!state.running || (state.startTime !== null && state.startTime !== owner.start));
      // The marker is read again: it must still be the one the question was asked about.
      const current = readStagingOwner(`${root}${STAGING_OWNER_SUFFIX}`);
      if (gone && current !== null && current.pid === owner.pid && current.start === owner.start && current.instance === owner.instance) {
        sweepStagingTree(root);
      }
    }
  }).catch((error: unknown) => {
    log.warn(`holder staging owner probe failed: ${errorMessage(error)}`);
  });
}

export interface MxcBundledHolderInput {
  readonly label: string;
  /** As configured; resolved to a canonical `.exe` through the caller's PATH. */
  readonly command: string;
  readonly args: readonly string[];
  /** Secret-stripped base environment; only forwarded runtime keys enter the container from it. */
  readonly baseEnv: NodeJS.ProcessEnv;
  /** Host-owned variables the same holder kind receives on its non-container path. */
  readonly holderEnv: Readonly<Record<string, string>>;
  /** Must lie inside the admitted roots; never added to them. Defaults to the private HOME. */
  readonly cwd?: string;
  readonly allowRead: readonly string[];
  readonly allowWrite: readonly string[];
  /** Host-captured read roots of the owning incarnation (a plugin generation, a bundled payload). */
  readonly ownedReadRoots: readonly string[];
  /** The reads, among `allowRead`, held inside the protected read floor. Named by the host from the reviewed declaration, never by the plugin. */
  readonly floorPierces?: readonly string[];
  readonly egressOwner: WorkerEgressOwner;
  /** Workspace roots beyond the authorized ones this holder writes (a user hook's cwd). */
  readonly workspaceRoots?: readonly string[];
  /** Synchronous caller authority, rechecked by row 2 immediately before native creation. */
  readonly assertStillValid?: () => void;
  /** A worker's declared control mode; required for the worker role. */
  readonly workerTransport?: MxcConfinedChildSpec["workerTransport"];
  /** The live holder this one descends from: row 2 refuses the start once it is gone and ends this holder with it. */
  readonly parent?: MxcConfinedChildSpawn;
  readonly signal?: AbortSignal;
}

export type MxcBundledHolder = MxcHolderIncarnation & {
  /** Resolves after verified termination, then removes the staging tree. Rejection means termination is unverified: the
   * holder stays quarantined with its listener, token and staging tree, and a later call retries the cleanup. */
  release(): Promise<void>;
  /** Sticky once a release failed. */
  readonly quarantined: boolean;
};

/** What a plugin child's planner needs from this adapter: a fresh staging tree. The plugin-child adapter drives row 2
 * itself, so nothing is spawned here. Every refusal comes before the staging tree exists; with no registered
 * release-gate evidence the start is refused, never run another way. */
export function prepareMxcHolderStart(input: {
  readonly label: string;
  readonly executable: string;
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  readonly allowWrite: readonly string[];
}): {
  readonly root: string;
  readonly home: string;
  readonly temp: string;
  /** Only after verified termination, or for a start that never reached native creation. */
  release(): Promise<void>;
} {
  if (!isMxcExtensionBackendSelected()) throw new MxcProcessContractError(`${input.label}: the extension container backend is not selected`);
  assertHolderEnvironmentAdmissible(input.baseEnv);
  // macOS has no build-time release record; its readiness is the boot check's proof (lead decision L2).
  if (windowsHost()) assertMxcReleaseGateEvidence();
  const executable = resolveHolderExecutable(input.executable, {});
  if (windowsHost()) assertMxcHolderNotBashForm(executable);
  assertExecutableAdmissible(executable, input.allowWrite, []);
  assertNoLiveWorkspaceWriter(input.allowWrite, []);
  // Caller writes only, before this holder's own staging root, which the state root holds, joins them.
  assertWriteGrantsOutsideConfinementState(input.allowWrite, declaredConfinementStatePaths());
  const staging = createHolderStaging();
  return { root: staging.root, home: staging.home, temp: staging.temp, release: () => removeHolderStaging(staging.root) };
}

/** One holder incarnation per call: its own sibling roots and staging, never the caller's plan passed through. */
export async function spawnMxcBundledHolder(input: MxcBundledHolderInput): Promise<MxcBundledHolder> {
  if (!isHolderStartRouted(input.egressOwner)) throw new MxcProcessContractError(`${input.label}: the extension container backend is not selected`);
  // Git Bash cannot start in a Windows container; a POSIX shell is an ordinary macOS holder command.
  if (windowsHost()) assertMxcHolderNotBashForm(input.command);
  assertHolderEnvironmentAdmissible(input.baseEnv, input.holderEnv);
  // Before any staging: row 2 checks it again when it mints the receipt. macOS has no build-time record (L2).
  if (windowsHost()) assertMxcReleaseGateEvidence();
  const posixLaunch = windowsHost() ? undefined : resolvePosixHolderLaunch(input.command, input.baseEnv);
  const executable = posixLaunch?.command ?? resolveHolderExecutable(input.command, input.baseEnv);
  if (windowsHost()) assertMxcHolderNotBashForm(executable);
  const workspaceRoots = input.workspaceRoots ?? [];
  for (const file of posixLaunch?.files ?? [executable]) assertExecutableAdmissible(file, input.allowWrite, workspaceRoots);
  assertNoLiveWorkspaceWriter(input.allowWrite, workspaceRoots);
  assertWriteGrantsOutsideConfinementState(input.allowWrite, declaredConfinementStatePaths());
  const staging = createHolderStaging();
  const allowWrite = [...new Set([...input.allowWrite, staging.root])];
  const allowRead = [...new Set([...input.allowRead, ...(posixLaunch?.files ?? [executable]).map(file => hostPath().dirname(file))])];
  const cwd = input.cwd ?? staging.home;
  let spawned: Awaited<ReturnType<typeof spawnMxcConfinedChild>>;
  try {
    if (![...allowRead, ...allowWrite].some((root) => atOrUnderOnHost(cwd, root))) {
      throw new MxcProcessContractError(`${input.label}: the working directory is outside this process's admitted folders`);
    }
    spawned = await spawnMxcConfinedChild({
      label: input.label,
      command: executable,
      args: [...(posixLaunch?.prefix ?? []), ...input.args],
      egressOwner: input.egressOwner,
      allowRead,
      allowWrite,
      baseEnv: input.baseEnv,
      holderEnv: input.holderEnv,
      cwd,
      home: staging.home,
      temp: staging.temp,
      stagingRoot: staging.root,
      filesystemOwnership: { readRoots: [...input.ownedReadRoots], writeRoots: allowWrite, hostStorageRoots: [] },
      holder: Object.freeze({ label: input.label }),
      ...(input.floorPierces !== undefined ? { floorPierces: [...input.floorPierces] } : {}),
      ...(input.assertStillValid ? { assertStillValid: input.assertStillValid } : {}),
      ...(input.workerTransport ? { workerTransport: input.workerTransport } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // An unverified startup cleanup keeps the staging tree with the rest of the holder's resources.
    if (!(error instanceof MxcProcessCleanupError)) await removeHolderStaging(staging.root);
    throw error;
  }
  let releasing: Promise<void> | undefined;
  let quarantined = false;
  return {
    ...(spawned.confinement === "windows-mxc"
      ? { process: spawned.process, confinement: spawned.confinement }
      : { process: spawned.process, confinement: spawned.confinement }),
    get quarantined() { return quarantined; },
    release: () => releasing ??= spawned.release().then(() => removeHolderStaging(staging.root), (error: unknown) => {
      quarantined = true;
      releasing = undefined;
      throw error;
    }),
  };
}

/** A started host-owned offline holder: its pipes, and the one hand on its lifetime. */
export interface SeatbeltOfflineHolder {
  readonly process: MxcHolderProcess;
  /** Idempotent. Resolves with the exit receipt (issued on the caller's `resources`, when given) after a verified stop;
   * rejects when termination is unverified, and that label then starts nothing more this app run. */
  release(): Promise<ConfirmedExit>;
}

/**
 * A host session an offline holder runs in instead of its own staging (owner L-O1, the document engine): the caller's
 * one private write root, which is also its HOME, temp and cwd; reads of its authenticated runtime inside the read floor;
 * and the one per-session 0700 Unix-socket directory inside that root. Nothing else is written or connected.
 */
export interface SeatbeltOfflineHolderSession {
  readonly writeRoot: string;
  readonly runtimeReads: readonly string[];
  readonly socketDirectory: string;
}

function assertPrivateSocketDirectory(path: string, writeRoot: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  const uid = process.getuid?.();
  if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o700 || entry.uid !== uid
    || realpathSync.native(path) !== path || !posixHolderPaths.strictlyUnder(path, writeRoot)) {
    throw new MxcProcessContractError("An offline holder's socket directory must be a private 0700 directory of this user, canonical and inside its write root");
  }
}

const quarantinedOfflineHolders = new Set<string>();

/**
 * A host-owned offline child on macOS (the memory inference child) once its holder route is on: a holder whose profile
 * has no network rule, with no egress invocation, no lease, no proxy variable and no extension-start consent. Its only
 * writes are its own staging HOME and temp; it reads what every holder reads. It starts only on the boot check's proof
 * (`asrt-sandbox.ts` `isOfflineHolderConfinementActive`), and is never started on the old wrap.
 */
export async function spawnSeatbeltOfflineHolder(input: {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly baseEnv: Readonly<NodeJS.ProcessEnv>;
  readonly holderEnv?: Readonly<Record<string, string>>;
  readonly session?: SeatbeltOfflineHolderSession;
  /** The caller's process handle: the stop's exit receipt is issued on it. */
  readonly resources?: ManagedResources;
}): Promise<SeatbeltOfflineHolder> {
  const route = provenSeatbeltHolderRoute();
  if (process.platform !== "darwin" || route === undefined || getMacHolderCapability()?.state !== "ready") {
    throw new MxcProcessContractError(`${input.label}: the macOS holder route is not proven`);
  }
  if (quarantinedOfflineHolders.has(input.label)) throw new MxcHolderQuarantinedError(input.label);
  assertManagedChildProcessAdmissionOpen(input.label);
  const { session } = input;
  if (session !== undefined) assertPrivateSocketDirectory(session.socketDirectory, session.writeRoot);
  // A session holder writes only the caller's root, so it has no staging tree of its own.
  const staging = session === undefined ? createHolderStaging() : undefined;
  const removeStaging = async (): Promise<void> => { if (staging !== undefined) await removeHolderStaging(staging.root); };
  let holder: Awaited<ReturnType<typeof startSeatbeltHolder>>;
  try {
    const writeRoot = session?.writeRoot ?? (staging as HolderStaging).root;
    const home = session?.writeRoot ?? (staging as HolderStaging).home;
    const temp = session?.writeRoot ?? (staging as HolderStaging).temp;
    const writeRoots = [writeRoot];
    const boundary = createAveHomeBoundarySnapshot();
    const floors = await boundary.run(() => captureSeatbeltHolderFloors({ cwd: home, writeRoots }));
    const launchInput: SeatbeltHolderLaunchInput = {
      command: input.command, args: [...input.args], cwd: home,
      env: seatbeltHolderEnvironment({ baseEnv: input.baseEnv, holderEnv: input.holderEnv, home, temp, cwd: home }),
      readRoots: [], writeRoots, floorPierces: [...(session?.runtimeReads ?? [])], network: "offline", labels: newHolderLabels(),
      ...(session === undefined ? {} : { unixSocketDirectory: session.socketDirectory }),
    };
    const { launch, identity } = boundary.run(() => withLocalityDecision(() => ({
      launch: composeSeatbeltHolderLaunch(launchInput, floors), identity: measurePosixExecutableIdentity(input.command),
    })));
    // A capability lost between the gate and the ready byte stops the holder at once.
    const revoked = new AbortController();
    const unsubscribe = onSandboxStatusChanged(() => {
      if (getMacHolderCapability()?.state !== "ready") revoked.abort();
    });
    try {
      holder = await startSeatbeltHolder(launch, {
        label: input.label, helper: route.helper, launchers: route.launchers, admittedDigest: launch.digest,
        assertStillValid: () => {
          assertManagedChildProcessAdmissionOpen(input.label);
          if (getMacHolderCapability()?.state !== "ready") throw new MxcProcessContractError(`${input.label}: the macOS holder route is no longer proven`);
          if (measurePosixExecutableIdentity(input.command) !== identity) throw new MxcProcessContractError("Container executable changed after admission");
        },
        revoked: revoked.signal,
        ...(input.resources === undefined ? {} : { resources: input.resources }),
      });
    } finally {
      unsubscribe();
    }
  } catch (error) {
    // An unverified refused start may have left a process: its staging stays, and so does the quarantine.
    if (error instanceof MxcProcessCleanupError) quarantinedOfflineHolders.add(input.label);
    else await removeStaging();
    throw error;
  }
  let releasing: Promise<ConfirmedExit> | undefined;
  return Object.freeze({
    process: seatbeltHolderProcess(holder),
    release: () => releasing ??= holder.dispose().then(async (receipt) => { await removeStaging(); return receipt; }, (error: unknown) => {
      quarantinedOfflineHolders.add(input.label);
      throw new MxcProcessCleanupError(`${input.label}: offline holder termination is unverified`, { cause: error });
    }),
  });
}

// @internal — test teardown only.
export function __resetOfflineHolderQuarantineForTest(): void {
  quarantinedOfflineHolders.clear();
}
