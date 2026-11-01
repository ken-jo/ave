import { shellQuote } from "../lib/shell-resolver.js";
import {
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  cleanupAsrtSandboxAfterCommand,
  ensureSandboxTempPrincipalDir,
  sandboxTempEnvLaunch,
  wrapWorkerCommand,
  type SandboxTempPrincipal,
} from "../permissions/asrt-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join, win32 as winPath } from "node:path";
import type { Readable, Writable } from "node:stream";
import { createLogger } from "../lib/logger.js";
import {
  liveMxcHolderWritableRoots,
  spawnConfinedChild,
  spawnMxcConfinedChild,
  type MxcConfinedChildSpec,
} from "../permissions/confined-child.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError } from "../permissions/mxc-extension-errors.js";
import type { OwnedMxcExtensionProcess } from "../permissions/mxc-extension-process.js";
import { planWindowsExtensionHolder } from "../permissions/mxc-extension-readiness.js";
import { isWindowsPathAtOrUnder } from "../permissions/mxc-windows.js";
import { getWindowsExtensionBackendPlan } from "../permissions/sandbox-capability.js";
import { listAuthorizedWorkspaceRoots } from "../permissions/workspace-authorized-roots.js";
import type { SandboxWindowsExtensionPlan } from "../shared/sandbox-capability-info.js";
import { createSandboxProcessHome } from "../permissions/sandbox-process-home.js";
import {
  holdWindowsFilesystemGrant,
  terminateChildBestEffort,
  type HeldWindowsGrant,
} from "../permissions/windows-acl-grant-holder.js";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";
import { aveHome } from "../shared/ave-home.js";
import { openEgressInvocation, type EgressInvocation, type WorkerEgressOwner } from "../permissions/egress-invocations.js";

const log = createLogger("wrap-bundled-command");

export interface BundledWrapInput {
  command: string;
  args: readonly string[];
  sandboxHome: { path: string; env: Record<string, string> };
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
export async function wrapBundledCommand(input: BundledWrapInput): Promise<{ argv: string[]; env: NodeJS.ProcessEnv; egress: EgressInvocation }> {
  if (process.platform === "win32") {
    // The macOS and Linux wrap: allow paths in the command. Windows has no per-exec allow; its
    // bundled processes go through `spawnWindowsBundledProcess`, and reaching here is a caller's mistake.
    throw new Error("wrapBundledCommand is the macOS and Linux wrap; a Windows bundled process is spawned by spawnWindowsBundledProcess");
  }
  const tmpDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  // The principal's own temp directory, set as its TMPDIR inside the wrap (ASRT's own assignment would otherwise name the shared root) and granted alone; the read floor denies the
  // shared temp and HOME roots, so no other principal's temp files or HOME can be read either, and the process HOME re-allowed here is its own; as `confined-child.ts` does for its children.
  const temp = ensureSandboxTempPrincipalDir(input.tempPrincipal);
  const launch = sandboxTempEnvLaunch(temp.dir, input.command, input.args);
  const cmdline = [launch.command, ...launch.args].map(shellQuote).join(" ");
  const egress = openEgressInvocation(input.egressOwner);
  let result: { argv: string[]; env: NodeJS.ProcessEnv };
  try {
    result = await wrapWorkerCommand(cmdline, {
      commandId: egress.token,
      filesystem: {
        allowWrite: [temp.dir, input.sandboxHome.path, ...input.allowWrite],
        // An ancestor grant can re-emit a protected deny after the exact hook file carve-out. User hooks need only their own temporary directory.
        allowRead: [temp.dir, input.sandboxHome.path, ...input.ownPluginReads, ...input.allowWrite,
          ...(tmpDir && input.tempPrincipal.kind !== "hook" ? [tmpDir] : [])],
        ...(input.tempPrincipal.kind === "hook" ? { floorPierces: input.ownPluginReads } : {}),
        denyRead: getDefaultSensitiveReadDenyPaths(),
        denyWrite: getDefaultSensitiveWriteDenyPaths(),
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
  return { ...result, egress };
}

/** Preserve only ASRT's changed proxy keys over the caller's stripped environment. */
export function bundledWrappedEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
  sandboxHomeEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const composed = buildSandboxedChildEnv(wrappedEnv);
  const baseline = buildSandboxedChildEnv(process.env);
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(composed)) {
    if (value !== undefined && baseline[key] !== value) overlay[key] = value;
  }
  return { ...baseEnv, ...overlay, ...sandboxHomeEnv };
}

/** A bundled process started under srt-win, and what it holds while it runs. */
export interface WindowsBundledSpawn {
  readonly child: ChildProcess;
  /** The program's input and output, through the stdio relay (`confined-child.ts`). */
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** Revoke the filesystem grant and remove the throwaway HOME. Idempotent; the HOME removal stays retryable, as `createSandboxProcessHome`
   * documents. Call it on the child's exit and again on its close. ASRT's per-command cleanup is the caller's, as it is for {@link wrapBundledCommand}. */
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
}): Promise<WindowsBundledSpawn> {
  if (process.platform !== "win32") {
    throw new Error(`[wrap-bundled-command] ${input.label}: spawnWindowsBundledProcess is the Windows path`);
  }
  const sandboxHome = createSandboxProcessHome();
  let grant: HeldWindowsGrant | undefined;
  const releaseHold = (): void => {
    grant?.release();
    sandboxHome.cleanup();
  };
  let wrapped = false;
  let child: ChildProcess | undefined;
  try {
    grant = await holdWindowsFilesystemGrant({
      label: `${input.label}:asrt-win-acl`,
      allowRead: [...new Set([sandboxHome.path, ...input.allowWrite, ...input.allowRead, ...hostRuntimeReads(input.command)])],
      allowWrite: [...new Set([sandboxHome.path, ...input.allowWrite])],
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
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.userHookShellPlan !== undefined ? { userHookShellPlan: input.userHookShellPlan } : {}),
      refreshStillValid: input.refreshStillValid,
      assertStillValid: () => {
        held.assertAlive();
        input.assertStillValid?.();
      },
      onWrapped: () => {
        wrapped = true;
      },
    });
    child = spawned.child;
    if (spawned.confinement !== "windows-srt") {
      throw new Error(`[wrap-bundled-command] ${input.label}: the sandbox was expected but the process came back ${spawned.confinement}`);
    }
    const running = child;
    held.onLost((reason) => {
      log.warn(`[${input.label}] filesystem grant lost, ending the process: ${reason.message}`);
      terminateChildBestEffort(running);
    });
    // A start that produced no process emits `error` and may emit nothing else.
    running.once("error", () => {
      if (running.pid === undefined) releaseHold();
    });
    return { child: running, stdin: spawned.stdin!, stdout: spawned.stdout!, releaseHold };
  } catch (error) {
    if (child !== undefined) terminateChildBestEffort(child);
    if (wrapped) void cleanupAsrtSandboxAfterCommand();
    releaseHold();
    throw error instanceof Error ? error : new Error(String(error));
  }
}

/** `<AVE_HOME>/runtime`, when the command is a program inside it. */
function hostRuntimeReads(command: string): string[] {
  const runtime = join(aveHome(), "runtime");
  return isPathWithin(runtime, command) ? [runtime] : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Container holders (design row 5). MCP stdio servers and hooks run as their own extension holder through the one
// sanctioned native entry, `spawnMxcConfinedChild`. This helper lays out the holder's sibling roots and refuses, with a
// named reason and before admission, what the contract forbids; admission, the receipt, nesting and lifetime stay row 2's.
// ---------------------------------------------------------------------------------------------------------------------

/** The selected boot plan routes extension holders to containers. A checking or rejected plan is refused by the guard. */
export function isMxcExtensionBackendSelected(): boolean {
  if (process.platform !== "win32") return false;
  const plan = getWindowsExtensionBackendPlan();
  return plan?.selectedBackend === "mxc" && plan.readiness === "ready";
}

/** The container executable is inside a workspace or a holder-writable root, is not a Windows executable, or cannot be resolved. */
export class MxcExecutableNotAdmissibleError extends Error {
  readonly code = "executable-not-admissible";
  constructor(detail: string) {
    super(`This program cannot run in an extension container: ${detail}`);
    this.name = "MxcExecutableNotAdmissibleError";
  }
}

/** Another live extension holder writes the same workspace; two such holders cannot be live at once and are never queued. */
export class MxcHolderWorkspaceBusyError extends Error {
  readonly code = "holder-workspace-busy";
  constructor() {
    super("Another contained extension process is writing this workspace; this one did not start. Retry after it ends");
    this.name = "MxcHolderWorkspaceBusyError";
  }
}

/** Git Bash cannot start inside a container (owner decision on the user-hook selector). Carries the per-holder plan that names the reason. */
export class MxcBashIncompatibleError extends Error {
  readonly code = "bash-incompatible";
  constructor(readonly plan: SandboxWindowsExtensionPlan) {
    super("Git Bash cannot start inside a Windows extension container on this host; run this command through PowerShell or a Windows executable");
    this.name = "MxcBashIncompatibleError";
  }
}

/** An earlier incarnation's termination could not be verified; it keeps its leases and blocks replacement until restart. */
export class MxcHolderQuarantinedError extends Error {
  readonly code = "holder-quarantined";
  constructor(label: string) {
    super(`${label}: the previous contained process could not be confirmed stopped, so it was not restarted. Restart Ave to clear it`);
    this.name = "MxcHolderQuarantinedError";
  }
}

const BASH_BASENAME = /^(?:bash|sh)(?:\.exe)?$/iu;

/** Bash-form: a Git Bash / MSYS interpreter, by its resolved flavor or by its executable name. */
export function isBashFormCommand(command: string, shellFlavor?: string): boolean {
  return shellFlavor === "msys" || BASH_BASENAME.test(winPath.basename(command));
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

type HolderReadinessProbe = MxcConfinedChildSpec["probe"];
let holderReadinessProbe: HolderReadinessProbe | undefined;

/** The exact-request readiness probe for MCP and hook holders. The native release gate (row 7) registers it; until then
 * every holder start fails closed with `MxcCapabilityUnavailableError`. Returns the unregister function. */
export function registerMxcHolderReadinessProbe(probe: HolderReadinessProbe): () => void {
  if (holderReadinessProbe !== undefined) throw new MxcProcessContractError("An extension holder readiness probe is already registered");
  holderReadinessProbe = probe;
  return () => {
    if (holderReadinessProbe === probe) holderReadinessProbe = undefined;
  };
}

function registeredHolderReadinessProbe(): HolderReadinessProbe {
  const probe = holderReadinessProbe;
  if (probe === undefined) {
    throw new MxcCapabilityUnavailableError("No extension holder readiness probe is registered; native readiness has not been established");
  }
  return probe;
}

function stripExtendedPrefix(path: string): string {
  return path.replace(/^\\\\\?\\/u, "");
}

/** Lexical and (when it exists) canonical spelling, so a junction-spelled root compares as its target. */
function pathForms(path: string): string[] {
  const lexical = winPath.normalize(path);
  try {
    const canonical = winPath.normalize(stripExtendedPrefix(realpathSync.native(lexical)));
    return canonical.toLowerCase() === lexical.toLowerCase() ? [lexical] : [lexical, canonical];
  } catch {
    return [lexical];
  }
}

function overlaps(left: string, right: string): boolean {
  return isWindowsPathAtOrUnder(left, right) || isWindowsPathAtOrUnder(right, left);
}

/** PATH resolution as the legacy spawn would find it, restricted to absolute directories and `.exe` programs: a relative
 * PATH entry resolves against the working directory, and a script shim needs an interpreter the container would run instead. */
function resolveHolderExecutable(command: string, env: NodeJS.ProcessEnv): string {
  let candidate: string | undefined;
  if (winPath.isAbsolute(command)) {
    candidate = command;
  } else if (/[\\/]/u.test(command)) {
    throw new MxcExecutableNotAdmissibleError(`"${command}" is a relative path, which would resolve inside the working directory`);
  } else {
    const names = winPath.extname(command) === "" ? [`${command}.exe`] : [command];
    const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? "";
    for (const directory of pathValue.split(";")) {
      if (!winPath.isAbsolute(directory)) continue;
      const found = names.map((name) => winPath.join(directory, name)).find((file) => existsSync(file) && statSync(file).isFile());
      if (found !== undefined) {
        candidate = found;
        break;
      }
    }
  }
  if (candidate === undefined) throw new MxcExecutableNotAdmissibleError(`"${command}" was not found as a Windows executable on PATH`);
  let canonical: string;
  try {
    canonical = winPath.normalize(stripExtendedPrefix(realpathSync.native(candidate)));
  } catch (error) {
    throw new MxcExecutableNotAdmissibleError(`"${candidate}" cannot be resolved (${(error as Error).message})`);
  }
  if (!/\.exe$/iu.test(canonical)) {
    throw new MxcExecutableNotAdmissibleError(`"${canonical}" is not a Windows executable (.exe); run its interpreter directly`);
  }
  return canonical;
}

/** Contract rule: never an executable from a workspace or any holder-writable root, this holder's own included. */
function assertExecutableAdmissible(executable: string, ownWriteRoots: readonly string[], workspaceRoots: readonly string[]): void {
  const forbidden = [
    ...[...listAuthorizedWorkspaceRoots(), ...workspaceRoots].flatMap(pathForms),
    ...ownWriteRoots.flatMap(pathForms),
    ...liveMxcHolderWritableRoots(),
  ];
  const hit = forbidden.find((root) => isWindowsPathAtOrUnder(executable, root));
  if (hit !== undefined) throw new MxcExecutableNotAdmissibleError(`"${executable}" lies inside a workspace or a writable root of a contained process`);
}

/** Two holders writing one workspace cannot both be live. Refuse only that concurrency, never queue it. */
function assertNoLiveWorkspaceWriter(allowWrite: readonly string[], workspaceRoots: readonly string[]): void {
  const workspaces = [...listAuthorizedWorkspaceRoots(), ...workspaceRoots].flatMap(pathForms);
  const workspaceWrites = allowWrite.flatMap(pathForms).filter((write) => workspaces.some((root) => overlaps(write, root)));
  if (workspaceWrites.length === 0) return;
  if (liveMxcHolderWritableRoots().some((live) => workspaceWrites.some((write) => overlaps(write, live)))) {
    throw new MxcHolderWorkspaceBusyError();
  }
}

interface HolderStaging { readonly root: string; readonly home: string; readonly temp: string }

/** `<AVE_HOME>\mxc-staging\<opaque-id>\{home,temp}`: its enumerate grant reveals only opaque IDs (contract doc). */
function createHolderStaging(): HolderStaging {
  const root = winPath.join(aveHome(), "mxc-staging", randomBytes(16).toString("hex"));
  const home = winPath.join(root, "home");
  const temp = winPath.join(root, "temp");
  mkdirSync(home, { recursive: true });
  mkdirSync(temp, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new MxcProcessContractError("Holder staging root is a link");
  return Object.freeze({ root, home, temp });
}

/** Remove a dead holder's staging tree without following links: a confined child may have planted a junction there, and
 * a recursive removal through it would delete the target. A link is unlinked itself; nothing is followed. */
function removeHolderStaging(root: string): void {
  const remove = (path: string): void => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      unlinkSync(path);
      return;
    }
    for (const name of readdirSync(path)) remove(winPath.join(path, name));
    rmdirSync(path);
  };
  try {
    remove(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    log.warn(`holder staging removal incomplete: ${(error as Error).message}`);
  }
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
  readonly egressOwner: WorkerEgressOwner;
  /** Workspace roots beyond the authorized ones this holder writes (a user hook's cwd). */
  readonly workspaceRoots?: readonly string[];
  /** Synchronous caller authority, rechecked by row 2 immediately before native creation. */
  readonly assertStillValid?: () => void;
  readonly signal?: AbortSignal;
}

export interface MxcBundledHolder {
  readonly process: OwnedMxcExtensionProcess;
  readonly confinement: "windows-mxc";
  /** Resolves after verified termination, then removes the staging tree. Rejection means termination is unverified: the
   * holder stays quarantined with its listener, token and staging tree, and a later call retries the cleanup. */
  release(): Promise<void>;
  /** Sticky once a release failed. */
  readonly quarantined: boolean;
}

/** One holder incarnation per call: its own sibling roots and staging, never the caller's plan passed through. */
export async function spawnMxcBundledHolder(input: MxcBundledHolderInput): Promise<MxcBundledHolder> {
  if (!isMxcExtensionBackendSelected()) throw new MxcProcessContractError(`${input.label}: the extension container backend is not selected`);
  assertMxcHolderNotBashForm(input.command);
  const probe = registeredHolderReadinessProbe();
  const executable = resolveHolderExecutable(input.command, input.baseEnv);
  assertMxcHolderNotBashForm(executable);
  const workspaceRoots = input.workspaceRoots ?? [];
  assertExecutableAdmissible(executable, input.allowWrite, workspaceRoots);
  assertNoLiveWorkspaceWriter(input.allowWrite, workspaceRoots);
  const staging = createHolderStaging();
  const allowWrite = [...new Set([...input.allowWrite, staging.root])];
  const allowRead = [...new Set([...input.allowRead, winPath.dirname(executable)])];
  const cwd = input.cwd ?? staging.home;
  let spawned: Awaited<ReturnType<typeof spawnMxcConfinedChild>>;
  try {
    if (![...allowRead, ...allowWrite].some((root) => isWindowsPathAtOrUnder(cwd, root))) {
      throw new MxcProcessContractError(`${input.label}: the working directory is outside this process's admitted folders`);
    }
    spawned = await spawnMxcConfinedChild({
      label: input.label,
      command: executable,
      args: [...input.args],
      egressOwner: input.egressOwner,
      allowRead,
      allowWrite,
      baseEnv: input.baseEnv,
      holderEnv: input.holderEnv,
      cwd,
      home: staging.home,
      temp: staging.temp,
      filesystemOwnership: { readRoots: [...input.ownedReadRoots], writeRoots: allowWrite, hostStorageRoots: [] },
      holder: Object.freeze({ label: input.label }),
      probe,
      ...(input.assertStillValid ? { assertStillValid: input.assertStillValid } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    // An unverified startup cleanup keeps the staging tree with the rest of the holder's resources.
    if (!(error instanceof MxcProcessCleanupError)) removeHolderStaging(staging.root);
    throw error;
  }
  let releasing: Promise<void> | undefined;
  let quarantined = false;
  return {
    process: spawned.process,
    confinement: spawned.confinement,
    get quarantined() { return quarantined; },
    release: () => releasing ??= spawned.release().then(() => removeHolderStaging(staging.root), (error: unknown) => {
      quarantined = true;
      releasing = undefined;
      throw error;
    }),
  };
}
