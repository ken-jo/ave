// Per-command deny arrays replace the shared boot floor, even when empty; this primitive always restates it so children cannot regain secret reads. Callers provide allow paths only.
import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { assertSrtWinSpawnIntegrity } from "./srt-win-integrity.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, win32 as winPath } from "node:path";
import type { Readable, Writable } from "node:stream";

import {
  ensureSandboxTempPrincipalDir,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  isPluginWorkerConfinementActive,
  assertExtensionStartAllowed,
  admitMxcExtensionFilesystem,
  appOwnedSandboxHomeRoot,
  appOwnedSandboxTempRoot,
  appOwnedTerminalHandoffRoot,
  sandboxTempEnvLaunch,
  wrapWorkerCommand,
  type SandboxTempPrincipal,
  type WrapOptions,
} from "./asrt-sandbox.js";
import { openEgressInvocation, type EgressInvocation, type WorkerEgressOwner } from "./egress-invocations.js";
import { getWindowsExtensionBackendPlan } from "./sandbox-capability.js";
import { openMxcEgressLease } from "./egress-host-listener.js";
import { buildMxcConfinedChildRequest } from "./mxc-confined-child-request.js";
import { isWindowsPathAtOrUnder, rankMxcFilesystem, type MxcFilesystemGrants } from "./mxc-windows.js";
import { spawnMxcExtensionProcess, type OwnedMxcExtensionProcess } from "./mxc-extension-process.js";
import {
  MxcNativeEntryRequiredError,
  MxcProcessCleanupError,
  MxcProcessContractError,
  WorkerTransportUnsupportedError,
} from "./mxc-extension-errors.js";
import { createMxcExtensionAdmission, consumeMxcExtensionAdmission } from "./mxc-extension-admission.js";
import type { MxcExtensionReadinessEvidence } from "./mxc-extension-readiness.js";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { registerMxcHolderLifetime } from "./mxc-holder-lifetime.js";
import { assertMxcHolderPrivateDirectories, type MxcExtensionFilesystemOwnership } from "./mxc-filesystem-ownership.js";
import { buildSandboxedChildEnv, isSandboxWrapperEnvKey } from "../tools/safe-env.js";
import {
  assertManagedChildProcessAdmissionOpen,
  trackManagedChildProcess,
} from "../main/managed-child-processes.js";
import { shellQuote } from "../lib/shell-resolver.js";
import { createLogger } from "../lib/logger.js";
import { mainDir } from "../main/main-paths.js";
import {
  assertRelayRequest,
  batchFileRefusal,
  CHILD_RELAY_TRANSPORT_ARG,
  relayStdioOverLoopback,
  type RelayRequest,
} from "../plugins/isolation/child-loopback-link.js";

const log = createLogger("confined-child");

// Where the confined child runtime's entry lives: the reference runtime a plugin child runs, and the stdio relay a Windows sandboxed process runs through. Resolved from `mainDir`, NOT from this module's own `import.meta.url`: the main process is an esbuild bundle with code splitting, so this file executes from `main.js` or from a hashed `chunks/*.js` and has no fixed relationship to any emitted sibling. `main-paths.ts` is the one place that answers "where are the runtime assets", and `plugin-child-main` is registered as its own esbuild entry point so an actual file exists there to run.
export function resolvePluginChildEntryPath(): string {
  return join(mainDir, "plugin-child-main.js");
}

// How long a relayed Windows process has to start and announce its listener.
const WINDOWS_RELAY_CONNECT_TIMEOUT_MS = 30_000;

// Node's symlink-preserving flags, for the host's own runtime on the Windows sandboxed launch and for any Node program a relay starts. Node otherwise `realpath`s a module path in JavaScript, which `lstat`s every ancestor directory, and the `srt-sandbox` account may not list the user-profile directories above `<AVE_HOME>` (measured: `EPERM: lstat` on the first one, with the plugin's own grant held). What they give up is resolving symlinks inside the program's own tree: a symlinked file loads under its link's path, and dependencies reached through links (pnpm's layout) resolve from the link's location.
export const NODE_PRESERVE_SYMLINK_FLAGS = ["--preserve-symlinks", "--preserve-symlinks-main"] as const;

// Relay target env separately because sandbox spawn env is not forwarded. Exclude runtime-owned PATH/PATHEXT, proxy/CA and GIT_CONFIG_* overlays, TMPDIR, USERNAME and ELECTRON_RUN_AS_NODE; preserve the sandbox's own values.
export function srtWinTargetEnv(
  baseEnv: NodeJS.ProcessEnv,
  extraEnv: Readonly<Record<string, string>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...baseEnv, ...extraEnv })) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (SRT_WIN_OWN_ENV.has(lower) || lower.startsWith("git_config_") || isSandboxWrapperEnvKey(name)) continue;
    env[name] = value;
  }
  return env;
}

const SRT_WIN_OWN_ENV = new Set(["path", "pathext", "tmpdir", "electron_run_as_node", "username"]);

// How the child's filesystem access is granted. `allow-list` puts the paths in the ASRT command itself (macOS seatbelt, Linux bwrap `--bind`). `deny-only` is Windows, where reachability is an ACL question decided outside the wrap — a grant against a holder process the caller owns for the process's lifetime (`windows-acl-grant-holder.ts`; a worker in `worker-spawn.ts`, a plugin child in `spawnConfinedPluginChild`) — so the wrap carries the deny floor and nothing else: passing allow paths there would imply a confinement the wrap does not perform.
type ConfinementGrantMode = "allow-list" | "deny-only";

export interface ConfinedChildSpec {
  readonly command: string;
  readonly args: readonly string[];
  // Used for the managed-child registration and in errors.
  readonly label: string;
  // Whose plugin-owned code this is, for egress attribution: while the sandbox is active the wrap carries an egress token (`egress-invocations.ts`) minted for this owner, and every proxy deny of the child is audited under it. The token lives as long as the child.
  readonly egressOwner: WorkerEgressOwner;
  readonly grantMode: ConfinementGrantMode;
  // Ignored under `deny-only`, where ACLs grant reachability instead.
  readonly allowRead?: readonly string[];
  readonly allowWrite?: readonly string[];
  // Whose temp directory the child gets: the plugin it belongs to. Required under `allow-list`, where the wrap grants that directory alone and sets the child's `TMPDIR` to it; ignored under `deny-only`, where the sandbox HOME's own `TEMP`/`TMP` is already per process (`sandbox-process-home.ts`).
  readonly tempPrincipal?: SandboxTempPrincipal;
  // The child may write INSIDE each write root but not unlink, rename or replace the root itself, its temp directory included. For a child whose write roots are directories the host created and keeps resolving — a plugin's data root above all — so that the child cannot `rmdir` one and leave a link in its place. Carried to the wrap as `PerCommandFilesystem.pinWriteRoots` (`asrt-sandbox.ts`), the one place every wrap of plugin-owned code pins its roots.
  readonly pinWriteRoots?: boolean;
  // The reads, among `allowRead`, this child may hold inside the protected read floor: a plugin's declared `hostDirectory` that pierces it. Carried to the wrap as `PerCommandFilesystem.floorPierces`; absent, none.
  readonly floorPierces?: readonly string[];
  // Refuse the child the plugins root beyond the protected floor, its own directories re-allowed through `allowRead`. Carried to the wrap as `PerCommandFilesystem.denyPluginsRoot` (`asrt-sandbox.ts`), which says why and why Windows refuses it: set only under `allow-list`.
  readonly denyPluginsRoot?: boolean;
  // Secret-stripped base environment the child starts from.
  readonly baseEnv: NodeJS.ProcessEnv;
  // Overlaid last — the sandbox process HOME, which must win.
  readonly extraEnv?: Record<string, string>;
  // Checked before and after the wrap. Throw to abort. Windows uses this for holder-process liveness: the ACL grant is only real while the holder is alive, so a holder that died between the grant and the spawn would otherwise produce a child believed to be confined by a grant that no longer exists.
  readonly assertStillValid?: () => void;
  // Called the instant the wrap succeeds, BEFORE the spawn. The wrap increments ASRT per-command state (the Linux active-sandbox count and proxy refcount). From that moment a later failure must decrement it, and only the caller knows how its own cleanup is arranged — so this is where the caller records that the wrap happened.
  readonly onWrapped?: () => void;
  // The child's standard streams. Defaults to `["ignore", "pipe", "pipe"]`, so a caller with no use for stdin does not hand an idle descriptor into a confined process. Both callers pipe stdin today, for different reasons: the JS plugin child is a JSON-RPC server whose pipes the host owns, and the plugin worker's stdin is the host's liveness pipe (see `worker-spawn.ts`) — it carries no bytes and closes only when the host process is gone.
  readonly stdio?: StdioOptions;
  // Windows direct children require exact cmd flags with delayed expansion off; checked tokens are not escaped. Refuse sandboxed spawns without this or a relay: the default inner shell loses stdin/env/exit status and may not wait for GUI children. Other platforms/unwrapped paths ignore this mode.
  readonly windowsShell?: "cmd";
  // Environment set ON the `"cmd"` command line, ahead of the command. srt-win gives the target the sandbox account's profile environment plus its own proxy overlay, never `baseEnv`/`extraEnv`, so a variable that must exist before the binary starts — `ELECTRON_RUN_AS_NODE` — can only arrive this way. Values are held to the same check as the tokens. Requires `windowsShell: "cmd"`.
  readonly windowsCommandLineEnv?: Readonly<Record<string, string>>;
  // Use returned relay streams rather than child pipes to preserve stdin, env, cwd and runtime symlink flags. Require piped stdin/stdout and exclude direct shell/env options; other platforms/unwrapped paths keep the original command.
  readonly windowsStdio?: "relay";
  // The child's working directory; on the relay, the program's.
  readonly cwd?: string;
}

// The wrap a spawn actually applied — never the `features.pluginWorkerConfinement` setting. A child spawned unwrapped is `unconfined` whatever the setting says, because "confined" is a claim about this process, and only the wrap makes it true. One value per substrate ASRT wraps with.
// `windows-mxc` is a per-holder Microsoft Execution Container started through `spawnMxcConfinedChild`. Its holder adapter reports it only after the native spawn AND its own transport setup (the plugin protocol handshake) succeed, and stops reporting it when authority is revoked; `MxcConfinedChildSpawn.confinement` carries the value, never a boot plan.
export type SpawnConfinement = "macos-sandbox" | "linux-bubblewrap" | "windows-srt" | "windows-mxc" | "unconfined";

// A spawned, registered child and the wrap it runs under.
export interface ConfinedChildSpawn {
  readonly child: ChildProcess;
  readonly confinement: SpawnConfinement;
  // Where the caller writes the program's input and reads its output: the child's own pipes, except through the Windows relay, where they are the relay's (see ConfinedChildSpec.windowsStdio). `null` where the corresponding stdio entry is not a pipe.
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
}

/** Native holders use owned streams and completion, never a fabricated ChildProcess. */
export interface MxcConfinedChildSpec extends Pick<ConfinedChildSpec,
  "command" | "args" | "label" | "egressOwner" | "allowRead" | "allowWrite" | "floorPierces" | "assertStillValid" | "baseEnv"> {
  readonly cwd: string;
  readonly home: string;
  readonly temp: string;
  /** Captured by the host from the owning incarnation, independently of requested grants. */
  readonly filesystemOwnership: MxcExtensionFilesystemOwnership;
  readonly holder: object;
  readonly parent?: MxcConfinedChildSpawn;
  readonly probe: (request: ContainerRequest, signal: AbortSignal) => Promise<MxcExtensionReadinessEvidence>;
  /** Host adapter's negotiated mode; public worker negotiation is owned by its contract. */
  readonly workerTransport?: "stdio-control-v1";
  readonly signal?: AbortSignal;
}

export interface MxcConfinedChildSpawn {
  readonly process: OwnedMxcExtensionProcess;
  readonly confinement: Extract<SpawnConfinement, "windows-mxc">;
  /** Release only after native termination; failed cleanup retains the listener and token. */
  release(): Promise<void>;
}

function assertMxcWorkerTransport(owner: WorkerEgressOwner, transport?: "stdio-control-v1"): void {
  if (owner.role === "worker" && transport !== "stdio-control-v1") throw new WorkerTransportUnsupportedError();
}

interface NativeHolderBinding {
  readonly plan: object;
  active: boolean;
  readonly children: Set<{ release(): Promise<void> }>;
}
const nativeHolderBindings = new WeakMap<MxcConfinedChildSpawn, NativeHolderBinding>();
const admittedNativeHolderIdentities = new WeakSet<object>();

/** Synchronous file identity of the admitted executable: canonical path, volume/file ID, size and timestamps.
 * It is re-measured in `beforeSpawn`. A same-size rewrite that restores timestamps is closed by refusing any
 * executable inside a live holder's writable root (see `assertNoCoHolderNesting`), leaving only the signed-in user. */
function measureExecutableIdentity(command: string): string {
  const canonical = realpathSync.native(command);
  const stat = statSync(canonical, { bigint: true });
  if (!stat.isFile()) throw new MxcProcessContractError("Container executable is not a regular file");
  return createHash("sha256").update([winPath.normalize(canonical).toLowerCase(), stat.dev, stat.ino, stat.size,
    stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join("\0")).digest("hex");
}

// Lexical and canonical spellings, so a junction-spelled path and its target compare as one location.
function pathForms(path: string): readonly string[] {
  const lexical = winPath.normalize(path);
  try {
    const canonical = winPath.normalize(realpathSync.native(path).replace(/^\\\\\?\\/u, ""));
    return canonical.toLowerCase() === lexical.toLowerCase() ? [lexical] : [lexical, canonical];
  } catch (error) {
    // A path that does not exist yet has no canonical spelling; its lexical form is still compared.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [lexical];
    throw error;
  }
}

/** Writable roots of every holder that is admitted or still owned (pending, live or quarantined). */
interface LiveHolderWritableRoots { readonly writable: readonly string[] }
const liveHolderWritableRoots = new Set<LiveHolderWritableRoots>();

function strictlyInside(path: string, root: string): boolean {
  return isWindowsPathAtOrUnder(path, root) && winPath.normalize(path).replace(/\\+$/u, "").toLowerCase()
    !== winPath.normalize(root).replace(/\\+$/u, "").toLowerCase();
}

/** A confined co-holder (the parent included) that can write above a path can swap a reparse point there between the
 * host's final identity check and the SDK's native string-path open. Refuse such nesting; equal pinned roots are allowed.
 * The executable must lie outside every live writable root, this holder's own included. */
function assertNoCoHolderNesting(self: LiveHolderWritableRoots, paths: readonly string[], command: string): void {
  const candidates = paths.flatMap(pathForms);
  const commandForms = pathForms(command);
  for (const holder of new Set([...liveHolderWritableRoots, self])) {
    for (const root of holder.writable) {
      if (commandForms.some((form) => isWindowsPathAtOrUnder(form, root))) {
        throw new MxcProcessContractError("Container executable lies inside a holder's writable root");
      }
      if (holder !== self && candidates.some((candidate) => strictlyInside(candidate, root))) {
        throw new MxcProcessContractError("Container path lies inside another live holder's writable root");
      }
    }
  }
}

function assertWritesInsideEnvelope(grants: MxcFilesystemGrants, ownership: MxcExtensionFilesystemOwnership): void {
  if (grants.readwrite.some((grant) => !ownership.writeRoots.some((root) => isWindowsPathAtOrUnder(grant, root)))) {
    throw new MxcProcessContractError("Container write grant is outside this holder's captured write roots");
  }
}

/** Preparation is per holder, with no session ACL union or fallback after selection. */
export async function spawnMxcConfinedChild(spec: MxcConfinedChildSpec): Promise<MxcConfinedChildSpawn> {
  assertExtensionStartAllowed({ backend: "mxc" });
  assertMxcWorkerTransport(spec.egressOwner, spec.workerTransport);
  const plan = getWindowsExtensionBackendPlan();
  if (process.platform !== "win32" || plan?.selectedBackend !== "mxc" || plan.readiness !== "ready") {
    throw new MxcProcessContractError("Extension container backend is not ready");
  }
  spec = Object.freeze({ ...spec, args: Object.freeze([...spec.args]),
    baseEnv: Object.freeze({ ...spec.baseEnv }), egressOwner: Object.freeze({ ...spec.egressOwner }),
    allowRead: Object.freeze([...(spec.allowRead ?? [])]), allowWrite: Object.freeze([...(spec.allowWrite ?? [])]),
    floorPierces: Object.freeze([...(spec.floorPierces ?? [])]),
    filesystemOwnership: Object.freeze({ readRoots: Object.freeze([...spec.filesystemOwnership.readRoots]),
      writeRoots: Object.freeze([...spec.filesystemOwnership.writeRoots]), hostStorageRoots: Object.freeze([...spec.filesystemOwnership.hostStorageRoots]) }),
  });
  const assertParent = (): void => {
    if (spec.parent === undefined) return;
    const parent = nativeHolderBindings.get(spec.parent);
    if (!parent?.active || parent.plan !== plan) throw new MxcProcessContractError("Extension parent backend is no longer admitted");
  };
  assertParent();
  spec.assertStillValid?.();
  assertManagedChildProcessAdmissionOpen(spec.label);
  const admitted = admitMxcExtensionFilesystem({
    allowRead: [...(spec.allowRead ?? [])], allowWrite: [...(spec.allowWrite ?? [])],
    denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyPaths(),
    floorPierces: spec.floorPierces, denyPluginsRoot: true, pinWriteRoots: true,
  }, spec.filesystemOwnership);
  const grants = rankMxcFilesystem(admitted.policy, existsSync);
  assertWritesInsideEnvelope(grants, spec.filesystemOwnership);
  assertMxcHolderPrivateDirectories({ home: spec.home, temp: spec.temp, ownership: spec.filesystemOwnership,
    sharedPrivateRoots: [appOwnedSandboxHomeRoot(), appOwnedSandboxTempRoot(), appOwnedTerminalHandoffRoot()] });
  const ownRoots: LiveHolderWritableRoots = Object.freeze({ writable: Object.freeze([...new Set(
    [...grants.readwrite, spec.home, spec.temp, ...spec.filesystemOwnership.writeRoots].flatMap(pathForms))]) });
  const nestedPaths = Object.freeze([...grants.readwrite, ...grants.readonly, ...grants.denied, spec.cwd, spec.home, spec.temp]);
  const assertNesting = (): void => assertNoCoHolderNesting(ownRoots, nestedPaths, spec.command);
  assertNesting();
  if (!spec.holder || typeof spec.holder !== "object" || admittedNativeHolderIdentities.has(spec.holder)) {
    throw new MxcProcessContractError("Extension holder incarnation is invalid or already admitted");
  }
  const controller = new AbortController();
  const signal = spec.signal ? AbortSignal.any([spec.signal, controller.signal]) : controller.signal;
  const egress = openEgressInvocation(spec.egressOwner, { abortSignal: signal });
  let lease: Awaited<ReturnType<typeof openMxcEgressLease>> | undefined;
  let native: OwnedMxcExtensionProcess | undefined;
  let binding: NativeHolderBinding | undefined;
  let settleStartup!: () => void;
  const startupSettled = new Promise<void>((resolve) => { settleStartup = resolve; });
  let lifetime: ReturnType<typeof registerMxcHolderLifetime>;
  try {
    lifetime = registerMxcHolderLifetime(spec.label, async () => {
      if (binding) binding.active = false;
      controller.abort();
      // Start cancellation immediately, then retain ownership until startup adopts
      // any late native handle and settles. Parent teardown owns this pending slot.
      const earlyDispose = native?.dispose();
      void earlyDispose?.catch(() => {});
      await startupSettled;
      const results = await Promise.allSettled([
        ...[...(binding?.children ?? [])].map((child) => child.release()),
        ...(earlyDispose ? [earlyDispose] : native ? [native.dispose()] : []),
      ]);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new MxcProcessCleanupError("Extension tree cleanup is unverified", { cause: new AggregateError(failures) });
      await lease?.close();
      egress.release();
      admittedNativeHolderIdentities.delete(spec.holder);
      liveHolderWritableRoots.delete(ownRoots);
      if (spec.parent) nativeHolderBindings.get(spec.parent)?.children.delete(lifetime);
    });
    admittedNativeHolderIdentities.add(spec.holder);
    // Owned from registration until verified termination, so a concurrent admission sees these roots.
    liveHolderWritableRoots.add(ownRoots);
    if (spec.parent) nativeHolderBindings.get(spec.parent)!.children.add(lifetime);
  } catch (error) { egress.release(); throw error; }
  try {
    lease = await openMxcEgressLease(egress.token);
    spec.assertStillValid?.();
    admitted.assertStillValid();
    if (getWindowsExtensionBackendPlan() !== plan) throw new MxcProcessContractError("Extension backend changed before admission");
    const request = buildMxcConfinedChildRequest({ ...spec, grants, proxyUrl: lease.url });
    assertNesting();
    const admissionInput = { request, holder: spec.holder, executableIdentity: measureExecutableIdentity(spec.command), bootPlan: plan };
    const admission = await createMxcExtensionAdmission({ ...admissionInput, probe: spec.probe, signal });
    const child = await spawnMxcExtensionProcess(request, {
      signal,
      onOwned: (owned) => { native = owned; },
      beforeSpawn: () => {
        assertParent();
        if (signal.aborted) throw new MxcProcessContractError("Extension start was cancelled");
        spec.assertStillValid?.();
        admitted.assertStillValid();
        assertManagedChildProcessAdmissionOpen(spec.label);
        if (getWindowsExtensionBackendPlan() !== plan) throw new MxcProcessContractError("Extension backend changed before native creation");
        assertNesting();
        consumeMxcExtensionAdmission(admission, { ...admissionInput, executableIdentity: measureExecutableIdentity(spec.command) });
      },
    });
    native = child;
    spec.assertStillValid?.();
    if (signal.aborted) throw new MxcProcessContractError("Extension start was cancelled");
    assertParent();
    admitted.assertStillValid();
    assertManagedChildProcessAdmissionOpen(spec.label);
    if (getWindowsExtensionBackendPlan() !== plan) throw new MxcProcessContractError("Extension backend changed during native start");
    binding = { plan, active: true, children: new Set() };
    const result: MxcConfinedChildSpawn = Object.freeze({ process: child, confinement: "windows-mxc", release: lifetime.release });
    nativeHolderBindings.set(result, binding);
    // Revocation closes descendant admission even when termination cannot be established.
    void child.completion.then(() => result.release(), () => result.release()).catch((error: unknown) => {
      log.warn(`Extension cleanup failed: ${String(error)}`);
    });
    settleStartup();
    return result;
  } catch (error) {
    settleStartup();
    // Cleanup failure retains the closure, native owner and endpoint in the shutdown registry.
    try { await lifetime.release(); } catch (cause) {
      throw new MxcProcessCleanupError("Extension holder cleanup remains owned by shutdown", { cause: new AggregateError([error, cause]) });
    }
    throw error;
  }
}

// Only active confinement wraps and marks a child; inactive spawn leaves no confinement marker. If failure follows onWrapped, caller cleanup owns the already-incremented runtime state.
export async function spawnConfinedChild(spec: ConfinedChildSpec): Promise<ConfinedChildSpawn> {
  const extensionPlan = process.platform === "win32" ? getWindowsExtensionBackendPlan() : undefined;
  if (extensionPlan?.readiness === "checking" || extensionPlan?.readiness === "rejected") {
    throw new MxcProcessContractError("Extension backend readiness has not admitted this start");
  }
  if (extensionPlan?.selectedBackend === "mxc") {
    assertMxcWorkerTransport(spec.egressOwner);
    throw new MxcNativeEntryRequiredError();
  }
  spec.assertStillValid?.();
  const stdio = spec.stdio ?? ["ignore", "pipe", "pipe"];
  if (spec.windowsStdio === "relay") assertRelayableSpec(spec, stdio);

  const { executable, args, wrappedEnv, confinement, relayRequest, egress } = await resolveSpawnLine(spec);
  let child: ChildProcess;
  try {
    spec.assertStillValid?.();
    assertManagedChildProcessAdmissionOpen(spec.label);
    if (confinement !== "unconfined") assertSrtWinSpawnIntegrity(executable);
    child = spawn(executable, args, {
      stdio,
      shell: false,
      windowsHide: true,
      // A wrapped child starts its own process session, so the sandbox profile's refusal to read other processes' arguments and environment (the carried ASRT patch) covers this process group too: Seatbelt only refuses it across sessions.
      ...(egress !== undefined && process.platform !== "win32" ? { detached: true } : {}),
      env: composeConfinedEnv(spec.baseEnv, wrappedEnv, spec.extraEnv ?? {}),
      // On the relay the program's directory travels in its request; the relay itself needs none.
      ...(spec.cwd !== undefined && relayRequest === undefined ? { cwd: spec.cwd } : {}),
    });
  } catch (error) {
    egress?.release();
    throw error;
  }
  if (egress !== undefined) {
    // Detached (POSIX), the child leads its own process group: the sandbox keeps the ended invocation's listener port while that group lives.
    if (process.platform !== "win32" && child.pid !== undefined) egress.noteProcessGroup(child.pid);
    // The token outlives neither the process nor a spawn that never started.
    const running = child;
    running.once("exit", () => egress.release());
    running.once("close", () => egress.release());
    running.once("error", () => { if (running.pid === undefined) egress.release(); });
  }
  trackManagedChildProcess(child, { label: spec.label, killProcessGroup: egress !== undefined && process.platform !== "win32" });
  if (relayRequest === undefined) {
    return { child, confinement, stdin: child.stdin, stdout: child.stdout };
  }
  const exited = new Promise<string>((resolve) => {
    child.once("exit", (code, signal) => resolve(`code=${String(code)} signal=${String(signal)}`));
    child.once("error", (error) => resolve(error.message));
  });
  const relayed = relayStdioOverLoopback({
    stdout: child.stdout!,
    exited,
    request: relayRequest,
    timeoutMs: WINDOWS_RELAY_CONNECT_TIMEOUT_MS,
    onFailure: (error) => {
      log.warn(`[${spec.label}] stdio relay not connected, ending the process: ${error.message}`);
      child.kill();
    },
  });
  return { child, confinement, stdin: relayed.stdin, stdout: relayed.stdout };
}

function assertRelayableSpec(spec: ConfinedChildSpec, stdio: StdioOptions): void {
  if (spec.windowsShell !== undefined || spec.windowsCommandLineEnv !== undefined) {
    throw new Error(`[confined-child] ${spec.label}: the stdio relay sets its own Windows shell and command-line environment`);
  }
  const entries = typeof stdio === "string" ? [stdio, stdio] : stdio;
  if (entries[0] !== "pipe" || entries[1] !== "pipe") {
    throw new Error(`[confined-child] ${spec.label}: the stdio relay needs piped stdin and stdout`);
  }
}

// The relay's own launch and the request naming the program. The launch is the reference runtime's, run as Node from `cmd.exe` with only host-owned tokens on the line; the program, its arguments, its environment and its directory go in the request, over the authenticated channel.
// The batch file a bare program name (`npx`) would mean to a Windows shell, when the relay's own lookup — which, without a shell, tries the name with `.com` and `.exe` only, directory by directory — would find no program by it on `PATH`. Asked so that such a name is refused with the reason (batchFileRefusal) rather than reported by the relay as not found. `PATH` is the launch's own, which srt-win's overlay carries into the sandbox.
function batchFileBehindBareName(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (/[\\/:]/.test(command) || extname(command) !== "") return undefined;
  const pathName = Object.keys(env).find((name) => name.toLowerCase() === "path");
  const dirs = (pathName === undefined ? "" : env[pathName] ?? "").split(";").filter((dir) => dir.trim() !== "");
  const found = (exts: readonly string[]): string | undefined => {
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, `${command}${ext}`);
        if (existsSync(candidate)) return candidate;
      }
    }
    return undefined;
  };
  return found([".com", ".exe"]) === undefined ? found([".cmd", ".bat"]) : undefined;
}

function windowsRelayLaunch(spec: ConfinedChildSpec): {
  readonly launch: Pick<ConfinedChildSpec, "label" | "windowsShell" | "windowsCommandLineEnv"> & { command: string; args: string[] };
  readonly request: RelayRequest;
} {
  const env = srtWinTargetEnv(spec.baseEnv, spec.extraEnv ?? {});
  const nodeOptions = Object.keys(env).find((name) => name.toLowerCase() === "node_options");
  const inheritedOptions = nodeOptions === undefined ? "" : env[nodeOptions]!;
  if (nodeOptions !== undefined) delete env[nodeOptions];
  env.NODE_OPTIONS = [...NODE_PRESERVE_SYMLINK_FLAGS, inheritedOptions].filter((part) => part.length > 0).join(" ");
  const request: RelayRequest = {
    command: spec.command,
    args: [...spec.args],
    env,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
  };
  // Refused here, before anything is wrapped or spawned, rather than after the relay is already running with no request it could be sent.
  assertRelayRequest(request);
  const batchFile = batchFileBehindBareName(spec.command, spec.baseEnv);
  if (batchFile !== undefined) throw batchFileRefusal(batchFile);
  return {
    launch: {
      label: spec.label,
      command: process.execPath,
      args: [...NODE_PRESERVE_SYMLINK_FLAGS, resolvePluginChildEntryPath(), CHILD_RELAY_TRANSPORT_ARG],
      windowsShell: "cmd",
      windowsCommandLineEnv: { ELECTRON_RUN_AS_NODE: "1" },
    },
    request,
  };
}

// The substrate ASRT wraps with on this platform. Asked only on the wrapped path; a platform ASRT does not wrap on is an internal contract violation, because `isPluginWorkerConfinementActive` reported a live sandbox there.
function wrapConfinement(label: string): Exclude<SpawnConfinement, "unconfined"> {
  switch (process.platform) {
    case "darwin":
      return "macos-sandbox";
    case "linux":
      return "linux-bubblewrap";
    case "win32":
      return "windows-srt";
    default:
      throw new Error(`[confined-child] ${label}: the sandbox is active on '${process.platform}', which no wrap substrate serves`);
  }
}

// What actually gets spawned: the ASRT-wrapped argv while the sandbox is active, the caller's own command otherwise. The two are one function so the decision is made in one place and `onWrapped` cannot fire on the plain path.
async function resolveSpawnLine(
  spec: ConfinedChildSpec,
): Promise<{
  executable: string;
  args: string[];
  wrappedEnv: NodeJS.ProcessEnv;
  confinement: SpawnConfinement;
  relayRequest?: RelayRequest;
  egress?: EgressInvocation;
}> {
  assertExtensionStartAllowed();
  if (!isPluginWorkerConfinementActive()) {
    return { executable: spec.command, args: [...spec.args], wrappedEnv: {}, confinement: "unconfined" };
  }
  const confinement = wrapConfinement(spec.label);
  const relay = spec.windowsStdio === "relay" && confinement === "windows-srt" ? windowsRelayLaunch(spec) : undefined;
  const temp = spec.grantMode === "allow-list" ? ensureSandboxTempPrincipalDir(requireTempPrincipal(spec)) : undefined;
  const launch = relay?.launch ?? (temp ? sandboxTempEnvLaunch(temp.dir, spec.command, spec.args) : spec);
  const { cmdline, binShell } = buildConfinedCommandLine(launch.command, launch.args, relay?.launch ?? spec);
  const egress = openEgressInvocation(spec.egressOwner);
  let argv: string[];
  let env: NodeJS.ProcessEnv;
  try {
    ({ argv, env } = await wrapWorkerCommand(cmdline, {
      filesystem: buildFilesystemConfinement(spec, temp),
      ...(binShell !== undefined ? { binShell } : {}),
      commandId: egress.token,
    }));
  } catch (error) {
    egress.release();
    throw error;
  }
  try {
    spec.onWrapped?.();
  } catch (error) {
    egress.release();
    throw error;
  }
  const [executable, ...args] = argv;
  if (executable === undefined) {
    egress.release();
    throw new Error(`[confined-child] ASRT returned an empty argv for ${spec.label}`);
  }
  return {
    executable,
    args,
    wrappedEnv: env,
    confinement,
    egress,
    ...(relay !== undefined ? { relayRequest: relay.request } : {}),
  };
}

function requireTempPrincipal(spec: ConfinedChildSpec): SandboxTempPrincipal {
  if (spec.tempPrincipal === undefined) {
    throw new Error(`[confined-child] ${spec.label}: an allow-list confinement needs the temp principal it belongs to`);
  }
  return spec.tempPrincipal;
}

// The filesystem section of the ASRT command. The deny floor is restated unconditionally in BOTH modes, because a per-command array replaces the shared one rather than extending it.
function buildFilesystemConfinement(spec: ConfinedChildSpec, temp: { dir: string } | undefined): {
  allowRead?: string[];
  allowWrite?: string[];
  denyRead: string[];
  denyWrite: string[];
  pinWriteRoots?: boolean;
  floorPierces?: readonly string[];
  denyPluginsRoot?: boolean;
} {
  const floor = {
    denyRead: getDefaultSensitiveReadDenyPaths(),
    denyWrite: getDefaultSensitiveWriteDenyPaths(),
  };
  if (spec.grantMode === "deny-only") {
    if (spec.denyPluginsRoot === true) {
      throw new Error(`[confined-child] ${spec.label}: denyPluginsRoot needs an allow-list confinement to re-allow the child's own directories`);
    }
    return floor;
  }
  if (temp === undefined) throw new Error(`[confined-child] ${spec.label}: an allow-list confinement was built without its temp directory`);
  // The temp directory is granted here for the same reason the deny floor is restated here: no caller should have to remember it, and one that forgot would produce a child whose `os.tmpdir` names a directory it cannot write — a failure with no obvious cause, arriving inside whatever library wanted a temp file. It is the principal's OWN directory, read and write; the shared root above it is read-denied by the floor, with the sandbox HOME root beside it, and ASRT's reads are deny-only, so that deny is what keeps one plugin from reading another's temp files or HOME.
  return {
    allowRead: [temp.dir, ...(spec.allowRead ?? [])],
    allowWrite: [temp.dir, ...(spec.allowWrite ?? [])],
    denyRead: floor.denyRead,
    denyWrite: floor.denyWrite,
    ...(spec.pinWriteRoots === true ? { pinWriteRoots: true } : {}),
    ...(spec.floorPierces !== undefined ? { floorPierces: spec.floorPierces } : {}),
    ...(spec.denyPluginsRoot === true ? { denyPluginsRoot: true } : {}),
  };
}

// Assemble the command line ASRT will run. Every token is quoted so a path containing spaces or shell metacharacters cannot mis-split: ASRT runs this through a shell on both platforms.
function buildConfinedCommandLine(
  command: string,
  args: readonly string[],
  spec: Pick<ConfinedChildSpec, "label" | "windowsShell" | "windowsCommandLineEnv">,
): { readonly cmdline: string; readonly binShell?: WrapOptions["binShell"] } {
  if (spec.windowsCommandLineEnv !== undefined && spec.windowsShell !== "cmd") {
    throw new Error(`[confined-child] ${spec.label}: windowsCommandLineEnv needs windowsShell "cmd"`);
  }
  if (process.platform === "win32") {
    if (spec.windowsShell !== "cmd") {
      throw new Error(
        `[confined-child] ${spec.label}: a Windows sandboxed spawn names windowsStdio "relay" or windowsShell "cmd"; `
          + "srt-win's PowerShell launch delivers no stdin, no environment and no exit code",
      );
    }
    return {
      cmdline: buildCmdCommandLine(spec.label, command, args, spec.windowsCommandLineEnv ?? {}),
      binShell: { exe: win32SystemBinary("cmd"), args: ["/d", "/v:off", "/s", "/c"] },
    };
  }
  return { cmdline: [command, ...args].map((part) => shellQuote(part)).join(" ") };
}

// `cmd.exe` limits its command line to 8191 characters; this leaves room for nothing else to be added to it.
const CMD_LINE_LIMIT = 8_000;
const CMD_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Quote every cmd token and disable delayed expansion; refuse quotes, %, CR/LF and NUL rather than attempt unsafe escaping. Double trailing backslashes for the target argument parser. Only host-owned launch tokens reach this line; plugin env and relayed program args travel separately.
function buildCmdCommandLine(
  label: string,
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!CMD_ENV_NAME_RE.test(name)) {
      throw new Error(`[confined-child] ${label}: '${name}' is not an environment variable name`);
    }
    assertCmdSafe(label, `${name}=${value}`);
    parts.push(`set "${name}=${value}"&&`);
  }
  for (const token of [command, ...args]) {
    assertCmdSafe(label, token);
    parts.push(`"${token.replace(/(\\+)$/, "$1$1")}"`);
  }
  const line = parts.join(" ");
  if (line.length > CMD_LINE_LIMIT) {
    throw new Error(
      `[confined-child] ${label}: the cmd.exe command line is ${line.length} characters, over the ${CMD_LINE_LIMIT} it can carry`,
    );
  }
  return line;
}

function assertCmdSafe(label: string, token: string): void {
  const bad = /["%\r\n\0]/.exec(token);
  if (bad !== null) {
    const what = bad[0] === '"' ? "a double quote" : bad[0] === "%" ? "'%'" : "a control character";
    throw new Error(
      `[confined-child] ${label}: '${token.slice(0, 200)}' contains ${what}, which cmd.exe cannot be given safely; `
        + "move the plugin, or the app, to a path without it",
    );
  }
}

// Compose the child's environment. Only the variables ASRT actually CHANGED are overlaid. Taking its whole composed environment would drag in this process's own values under the guise of proxy configuration, so it is diffed against a baseline composed from `process.env` and only the differences carry over.
function composeConfinedEnv(
  baseEnv: NodeJS.ProcessEnv,
  wrappedEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const asrtComposed: Record<string, string> = buildSandboxedChildEnv(wrappedEnv);
  const safeBaseline: Record<string, string> = buildSandboxedChildEnv(process.env);
  const proxyOverlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(asrtComposed)) {
    if (value === undefined) continue;
    if (safeBaseline[key] === value) continue;
    proxyOverlay[key] = value;
  }
  return { ...baseEnv, ...proxyOverlay, ...extraEnv };
}
